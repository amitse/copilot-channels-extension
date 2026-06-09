import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_OUTCOME,
} from "../consts.mjs";
import {
  CONNECTION_STATE,
  ERROR_CODE,
  MESSAGE_TYPE,
  PAYLOAD_LIMIT,
  PROTOCOL_VERSION,
  TOKEN_PREFIX,
  TOOL_RESULT_ERROR
} from "./consts.mjs";
import { parseMessage } from "./protocol-parsing.mjs";
import { computeTransition, identifyActions, CONNECTION_ACTION, CONNECTION_EVENT } from "./connection-state.mjs";
import { createProviderConnection } from "./connection.mjs";
import { buildToolCall } from "./protocol-builders.mjs";
import { validateHello, validateToolDef, validateToolsUpdate } from "./protocol-validation.mjs";
import { wrapProviderTool } from "./tool-proxy.mjs";
import { createMockTimerAdapter, createMockWebSocketAdapter } from "../test-support/adapters.mjs";
import { ConflictError } from "../errors/index.mjs";

function bindConnection({
  tools = [],
  websocketAdapter = createMockWebSocketAdapter(),
  timerAdapter,
  onBound = () => {},
  onUnbound = () => {},
  onPush = () => {},
  onToolsUpdate = () => {},
  onToolResult = () => {},
  log = () => {}
} = {}) {
  const adapters = { websocketAdapter };
  if (timerAdapter) {
    adapters.timerAdapter = timerAdapter;
  }

  const conn = createProviderConnection(websocketAdapter.socket, {
    expectedToken: `${TOKEN_PREFIX}secret`,
    activeSessions: [{ id: "s1", label: "One", cwd: "C:/tmp" }],
    onBound,
    onUnbound,
    onPush,
    onToolsUpdate,
    onToolResult,
    checkToolConflict: () => [],
    log
  }, adapters);

  websocketAdapter.emitMessage(JSON.stringify({ type: MESSAGE_TYPE.AUTH, token: `${TOKEN_PREFIX}secret` }));
  websocketAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.HELLO,
    name: "demo",
    protocolVersion: PROTOCOL_VERSION,
    session: "s1",
    tools
  }));

  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  return { conn, websocketAdapter };
}

function sentMessages(websocketAdapter) {
  return websocketAdapter.sent.map((payload) => JSON.parse(payload));
}

function providerTool(name, overrides = {}) {
  return {
    name,
    description: `${name} provider tool`,
    parameters: { type: "object", properties: {} },
    ...overrides
  };
}

function createCleanupTrackingWebSocketAdapter() {
  const baseAdapter = createMockWebSocketAdapter();
  const cleanupCalls = [];
  return {
    ...baseAdapter,
    cleanupCalls,
    connect(target, handlers) {
      const cleanupBaseAdapter = baseAdapter.connect(target, handlers);
      return () => {
        cleanupCalls.push("cleanup");
        cleanupBaseAdapter();
      };
    }
  };
}

function messageOverDefaultLimit(message) {
  const expanded = {
    ...message,
    padding: "x".repeat(PAYLOAD_LIMIT.DEFAULT)
  };
  const bytes = Buffer.byteLength(JSON.stringify(expanded), "utf8");
  assert.ok(bytes > PAYLOAD_LIMIT.DEFAULT);
  assert.ok(bytes < PAYLOAD_LIMIT.TOOL_RESULT);
  return expanded;
}

async function promiseStateAfterMicrotask(promise) {
  let outcome = { status: "pending" };
  promise.then(
    (value) => { outcome = { status: "fulfilled", value }; },
    (error) => { outcome = { status: "rejected", error }; }
  );
  await Promise.resolve();
  return outcome;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("parseMessage accepts WebSocket string and byte payload variants", () => {
  const message = {
    type: MESSAGE_TYPE.PUSH,
    level: EVENT_OUTCOME.SURFACE,
    event: "provider emitted bytes",
    stream: "provider-bytes"
  };
  const json = JSON.stringify(message);
  const encoded = new TextEncoder().encode(json);
  const padded = new Uint8Array(encoded.byteLength + 4);
  padded.set(encoded, 2);

  const cases = [
    ["string", json],
    ["Buffer", Buffer.from(json, "utf8")],
    ["ArrayBuffer", encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)],
    ["Uint8Array view", new Uint8Array(padded.buffer, 2, encoded.byteLength)],
    ["DataView", new DataView(padded.buffer, 2, encoded.byteLength)],
    ["Buffer fragments", [Buffer.from(json.slice(0, 11), "utf8"), Buffer.from(json.slice(11), "utf8")]]
  ];

  for (const [label, raw] of cases) {
    const parsed = parseMessage(raw);
    assert.equal(parsed.ok, true, label);
    assert.deepEqual(parsed.message, message, label);
  }
});

test("protocol validation rejects blank provider and tool fields without trimming valid values", () => {
  const validTool = {
    name: " spaced_tool ",
    description: " Provider tool ",
    parameters: { type: "object", properties: {} }
  };
  const validHello = {
    type: MESSAGE_TYPE.HELLO,
    name: " demo ",
    protocolVersion: PROTOCOL_VERSION,
    session: " s1 ",
    tools: [validTool]
  };

  const helloResult = validateHello(validHello);
  assert.equal(helloResult.ok, true);
  assert.equal(helloResult.hello.name, " demo ");
  assert.equal(helloResult.hello.session, " s1 ");
  assert.equal(helloResult.hello.tools[0].name, " spaced_tool ");
  assert.equal(helloResult.hello.tools[0].description, " Provider tool ");

  const toolResult = validateToolDef(validTool);
  assert.equal(toolResult.ok, true);

  const updateResult = validateToolsUpdate({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [validTool]
  });
  assert.equal(updateResult.ok, true);
  assert.equal(updateResult.update.tools[0].name, " spaced_tool ");
  assert.equal(updateResult.update.tools[0].description, " Provider tool ");

  assert.equal(validateHello({ ...validHello, name: " \t " }).ok, false);
  assert.equal(validateHello({ ...validHello, session: "\n\t" }).ok, false);
  assert.equal(validateHello({
    ...validHello,
    tools: [{ ...validTool, name: "  " }]
  }).ok, false);
  assert.equal(validateHello({
    ...validHello,
    tools: [{ ...validTool, description: "\t" }]
  }).ok, false);
  assert.equal(validateToolsUpdate({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [{ ...validTool, name: "\n" }]
  }).ok, false);
  assert.equal(validateToolsUpdate({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [{ ...validTool, description: "   " }]
  }).ok, false);
});

test("connection transition accepts auth", () => {
  const transition = computeTransition(
    {
      state: CONNECTION_STATE.AWAIT_AUTH,
      expectedToken: `${TOKEN_PREFIX}abc`,
      activeSessions: [{ id: "s1", label: "One", cwd: "C:/tmp" }],
      providerId: null,
      providerName: null,
      sessionId: null,
      tools: [],
      wasBound: false
    },
    {
      type: CONNECTION_EVENT.MESSAGE,
      message: { type: MESSAGE_TYPE.AUTH, token: `${TOKEN_PREFIX}abc` }
    }
  );

  assert.equal(transition.nextState.state, CONNECTION_STATE.AWAIT_HELLO);
  assert.equal(transition.actions[0].type, "send");
});

test("bound tool.result transition does not echo a provider result back to the provider", () => {
  const transition = computeTransition(
    {
      state: CONNECTION_STATE.BOUND,
      expectedToken: `${TOKEN_PREFIX}abc`,
      activeSessions: [{ id: "s1", label: "One", cwd: "C:/tmp" }],
      providerId: "p-provider",
      providerName: "demo",
      sessionId: "s1",
      tools: [providerTool("echo_tool")],
      wasBound: true
    },
    {
      type: CONNECTION_EVENT.MESSAGE,
      message: { type: MESSAGE_TYPE.TOOL_RESULT, id: "call-echo", data: { ok: true } }
    }
  );

  assert.equal(transition.nextState.state, CONNECTION_STATE.BOUND);
  assert.equal(identifyActions(transition).some((action) => (
    action.type === CONNECTION_ACTION.SEND &&
    action.message?.type === MESSAGE_TYPE.TOOL_RESULT
  )), false);
});

test("mock websocket adapter drives auth and hello", () => {
  const wsAdapter = createMockWebSocketAdapter();
  const onBoundCalls = [];
  const conn = createProviderConnection(wsAdapter.socket, {
    expectedToken: `${TOKEN_PREFIX}secret`,
    activeSessions: [{ id: "s1", label: "One", cwd: "C:/tmp" }],
    onBound: (value) => onBoundCalls.push(value.providerId),
    onUnbound: () => {},
    onToolResult: () => {},
    checkToolConflict: () => [],
    log: () => {}
  }, { websocketAdapter: wsAdapter });

  wsAdapter.emitMessage(JSON.stringify({ type: MESSAGE_TYPE.AUTH, token: `${TOKEN_PREFIX}secret` }));
  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.HELLO,
    name: "demo",
    protocolVersion: PROTOCOL_VERSION,
    session: "s1",
    tools: []
  }));

  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.equal(onBoundCalls.length, 1);
  assert.ok(wsAdapter.sent.some((payload) => String(payload).includes(MESSAGE_TYPE.HELLO_ACK)));
});

test("provider bound and unbound callbacks catch promise rejections", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const logs = [];
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    onBound() {
      return Promise.reject(new Error("bound async failed"));
    },
    onUnbound() {
      return Promise.reject(new Error("unbound async failed"));
    },
    log(message) {
      logs.push(message);
    }
  });

  await flushMicrotasks();
  conn.close("done");
  await flushMicrotasks();

  assert.equal(conn.state, CONNECTION_STATE.DISCONNECTED);
  assert.ok(logs.some((message) => (
    message.includes("onBound callback error") &&
    message.includes("bound async failed")
  )));
  assert.ok(logs.some((message) => (
    message.includes("onUnbound callback error") &&
    message.includes("unbound async failed")
  )));
});

test("custom websocket cleanup runs exactly once on disconnect paths", () => {
  const scenarios = [
    {
      name: "gateway close",
      bind: true,
      drive({ conn }) {
        conn.close("done");
      }
    },
    {
      name: "remote close",
      bind: true,
      drive({ websocketAdapter }) {
        websocketAdapter.socket.close();
      }
    },
    {
      name: "socket error",
      bind: true,
      drive({ websocketAdapter }) {
        websocketAdapter.emitError(new Error("boom"));
      }
    },
    {
      name: "auth failure",
      bind: false,
      drive({ websocketAdapter }) {
        websocketAdapter.emitMessage(JSON.stringify({ type: MESSAGE_TYPE.AUTH, token: `${TOKEN_PREFIX}wrong` }));
      }
    }
  ];

  for (const scenario of scenarios) {
    const websocketAdapter = createCleanupTrackingWebSocketAdapter();
    const conn = createProviderConnection(websocketAdapter.socket, {
      expectedToken: `${TOKEN_PREFIX}secret`,
      activeSessions: [{ id: "s1", label: "One", cwd: "C:/tmp" }],
      onBound: () => {},
      onUnbound: () => {},
      onPush: () => {},
      onToolsUpdate: () => {},
      onToolResult: () => {},
      checkToolConflict: () => [],
      log: () => {}
    }, { websocketAdapter });

    if (scenario.bind) {
      websocketAdapter.emitMessage(JSON.stringify({ type: MESSAGE_TYPE.AUTH, token: `${TOKEN_PREFIX}secret` }));
      websocketAdapter.emitMessage(JSON.stringify({
        type: MESSAGE_TYPE.HELLO,
        name: "demo",
        protocolVersion: PROTOCOL_VERSION,
        session: "s1",
        tools: [providerTool(`${scenario.name.replaceAll(" ", "_")}_tool`)]
      }));
      assert.equal(conn.state, CONNECTION_STATE.BOUND, scenario.name);
    }

    scenario.drive({ conn, websocketAdapter });
    assert.equal(conn.state, CONNECTION_STATE.DISCONNECTED, scenario.name);
    assert.equal(websocketAdapter.cleanupCalls.length, 1, scenario.name);

    conn.close("again");
    websocketAdapter.socket.close();
    assert.equal(websocketAdapter.cleanupCalls.length, 1, scenario.name);
  }
});

test("provider tool calls honor declared timeout and send cancel", async () => {
  const timerAdapter = createMockTimerAdapter();
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    timerAdapter,
    tools: [{
      name: "slow_tool",
      description: "Slow provider tool",
      parameters: { type: "object", properties: {} },
      timeout: 50
    }]
  });

  const call = conn.sendToolCall("call-timeout", "s1", "slow_tool", {});
  const rejection = assert.rejects(call, (err) => {
    assert.equal(err.code, TOOL_RESULT_ERROR.TIMEOUT);
    assert.match(err.message, /timed out after 50ms/);
    return true;
  });

  timerAdapter.advance(49);
  assert.equal(timerAdapter.pendingCount, 1);

  timerAdapter.advance(1);
  await rejection;

  assert.equal(timerAdapter.pendingCount, 0);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.TOOL_CANCEL &&
    message.id === "call-timeout" &&
    message.sessionId === "s1" &&
    message.reason === "timeout"
  )));
});

test("provider tool call send failure rejects and clears timeout", async () => {
  const timerAdapter = createMockTimerAdapter();
  const baseAdapter = createMockWebSocketAdapter();
  const websocketAdapter = {
    ...baseAdapter,
    send(target, message) {
      if (message.type === MESSAGE_TYPE.TOOL_CALL) {
        throw new Error("socket send failed");
      }
      return baseAdapter.send(target, message);
    }
  };

  const { conn } = bindConnection({
    websocketAdapter,
    timerAdapter,
    tools: [{
      name: "send_fail_tool",
      description: "Provider tool with failing send",
      parameters: { type: "object", properties: {} },
      timeout: 10
    }]
  });

  await assert.rejects(
    conn.sendToolCall("call-send-fail", "s1", "send_fail_tool", {}),
    (err) => {
      assert.equal(err.code, TOOL_RESULT_ERROR.DISCONNECTED);
      assert.match(err.message, /failed to send tool call/);
      return true;
    }
  );

  assert.equal(timerAdapter.pendingCount, 0);
  timerAdapter.advance(10);
  assert.ok(!sentMessages(websocketAdapter).some((message) => (
    message.type === MESSAGE_TYPE.TOOL_CANCEL &&
    message.id === "call-send-fail"
  )));
});

test("bound non-tool.result messages over default limit are rejected below tool.result limit", () => {
  for (const type of ["provider.future", MESSAGE_TYPE.GOODBYE]) {
    const wsAdapter = createMockWebSocketAdapter();
    const { conn } = bindConnection({ websocketAdapter: wsAdapter });
    const message = messageOverDefaultLimit({ type, reason: "large control message" });

    wsAdapter.emitMessage(JSON.stringify(message));

    const errors = sentMessages(wsAdapter).filter((sent) => sent.type === MESSAGE_TYPE.ERROR);
    assert.equal(errors.at(-1)?.code, ERROR_CODE.PAYLOAD_TOO_LARGE);
    assert.equal(conn.state, CONNECTION_STATE.BOUND);
    assert.equal(wsAdapter.socket.closed, false);
  }
});

test("bound tool.result over default limit is accepted below tool.result limit", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [providerTool("big_tool")]
  });
  const data = "x".repeat(PAYLOAD_LIMIT.DEFAULT);
  const response = { type: MESSAGE_TYPE.TOOL_RESULT, id: "call-large-result", data };
  const bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  assert.ok(bytes > PAYLOAD_LIMIT.DEFAULT);
  assert.ok(bytes < PAYLOAD_LIMIT.TOOL_RESULT);

  const call = conn.sendToolCall("call-large-result", "s1", "big_tool", {});
  wsAdapter.emitMessage(JSON.stringify(response));

  const result = await call;
  assert.equal(result.id, "call-large-result");
  assert.equal(result.data, data);
  assert.equal(conn.state, CONNECTION_STATE.BOUND);
});

test("malformed tool.result for pending call rejects caller and clears pending state", async () => {
  const timerAdapter = createMockTimerAdapter();
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    timerAdapter,
    tools: [{
      name: "validated_tool",
      description: "Provider tool with validation-sensitive result",
      parameters: { type: "object", properties: {} },
      timeout: 100
    }]
  });

  const call = conn.sendToolCall("call-malformed", "s1", "validated_tool", {});
  assert.equal(timerAdapter.pendingCount, 1);

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOL_RESULT,
    id: "call-malformed",
    data: "ok",
    error: "not ok"
  }));

  const outcome = await promiseStateAfterMicrotask(call);
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.code, ERROR_CODE.UNKNOWN_TYPE);
  assert.match(outcome.error.message, /exactly one of data or error/);
  assert.equal(timerAdapter.pendingCount, 0);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.UNKNOWN_TYPE &&
    message.replyTo === "call-malformed"
  )));
});

test("uncorrelatable malformed tool.result rejects sole no-timeout pending call", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [{
      name: "no_timeout_tool",
      description: "Provider tool without a declared timeout",
      parameters: { type: "object", properties: {} }
    }]
  });

  const call = conn.sendToolCall("call-no-timeout", "s1", "no_timeout_tool", {});

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOL_RESULT,
    data: "uncorrelatable"
  }));

  const outcome = await promiseStateAfterMicrotask(call);
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.code, ERROR_CODE.UNKNOWN_TYPE);
  assert.match(outcome.error.message, /missing required field: id/);
  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.equal(wsAdapter.socket.closed, false);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.UNKNOWN_TYPE
  )));
});

test("multi-pending uncorrelatable tool.result disconnects and rejects all calls", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [{
      name: "multi_tool",
      description: "Provider tool with concurrent pending calls",
      parameters: { type: "object", properties: {} }
    }]
  });

  const first = conn.sendToolCall("call-multi-a", "s1", "multi_tool", {});
  const second = conn.sendToolCall("call-multi-b", "s1", "multi_tool", {});
  const firstRejected = assert.rejects(first, (err) => {
    assert.equal(err.code, TOOL_RESULT_ERROR.DISCONNECTED);
    assert.match(err.message, /uncorrelatable tool\.result/);
    return true;
  });
  const secondRejected = assert.rejects(second, (err) => {
    assert.equal(err.code, TOOL_RESULT_ERROR.DISCONNECTED);
    assert.match(err.message, /uncorrelatable tool\.result/);
    return true;
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOL_RESULT,
    data: "ambiguous"
  }));

  await Promise.all([firstRejected, secondRejected]);
  assert.equal(conn.state, CONNECTION_STATE.DISCONNECTED);
  assert.equal(wsAdapter.socket.closed, true);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.UNKNOWN_TYPE
  )));
});

test("malformed bound provider message rejects sole pending call without orphaning it", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [{
      name: "parse_sensitive_tool",
      description: "Provider tool waiting for a parse-sensitive response",
      parameters: { type: "object", properties: {} }
    }]
  });

  const call = conn.sendToolCall("call-invalid-json", "s1", "parse_sensitive_tool", {});
  wsAdapter.emitMessage("{not valid json");

  const outcome = await promiseStateAfterMicrotask(call);
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.code, ERROR_CODE.INVALID_JSON);
  assert.match(outcome.error.message, /invalid JSON/);
  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.equal(wsAdapter.socket.closed, false);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.INVALID_JSON
  )));
});

test("oversized bound provider message with multiple pending calls disconnects and rejects all", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [{
      name: "oversized_tool",
      description: "Provider tool with concurrent oversized responses",
      parameters: { type: "object", properties: {} }
    }]
  });

  const first = conn.sendToolCall("call-oversized-a", "s1", "oversized_tool", {});
  const second = conn.sendToolCall("call-oversized-b", "s1", "oversized_tool", {});
  const firstRejected = assert.rejects(first, (err) => {
    assert.equal(err.code, TOOL_RESULT_ERROR.DISCONNECTED);
    assert.match(err.message, /uncorrelatable message/);
    return true;
  });
  const secondRejected = assert.rejects(second, (err) => {
    assert.equal(err.code, TOOL_RESULT_ERROR.DISCONNECTED);
    assert.match(err.message, /uncorrelatable message/);
    return true;
  });

  wsAdapter.emitMessage(JSON.stringify(messageOverDefaultLimit({
    type: "provider.future",
    reason: "ambiguous large message"
  })));

  await Promise.all([firstRejected, secondRejected]);
  assert.equal(conn.state, CONNECTION_STATE.DISCONNECTED);
  assert.equal(wsAdapter.socket.closed, true);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.PAYLOAD_TOO_LARGE
  )));
});

test("valid tool.result with unknown id rejects sole pending call as uncorrelatable", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const toolResults = [];
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [{
      name: "late_result_tool",
      description: "Provider tool with an uncorrelatable terminal result",
      parameters: { type: "object", properties: {} }
    }],
    onToolResult(_connection, result) {
      toolResults.push(result);
    }
  });

  const call = conn.sendToolCall("call-active", "s1", "late_result_tool", {});

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOL_RESULT,
    id: "call-unknown",
    data: "late"
  }));

  const outcome = await promiseStateAfterMicrotask(call);
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.code, ERROR_CODE.UNKNOWN_CALL_ID);
  assert.match(outcome.error.message, /does not match any pending provider tool call/);
  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.equal(wsAdapter.socket.closed, false);
  assert.deepEqual(toolResults, []);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.UNKNOWN_CALL_ID &&
    message.replyTo === "call-unknown"
  )));
});

test("valid tool.result with unknown id disconnects and rejects multiple pending calls", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const toolResults = [];
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [{
      name: "unknown_multi_tool",
      description: "Provider tool with multiple pending calls",
      parameters: { type: "object", properties: {} }
    }],
    onToolResult(_connection, result) {
      toolResults.push(result);
    }
  });

  const first = conn.sendToolCall("call-active-a", "s1", "unknown_multi_tool", {});
  const second = conn.sendToolCall("call-active-b", "s1", "unknown_multi_tool", {});
  const firstRejected = assert.rejects(first, (err) => {
    assert.equal(err.code, TOOL_RESULT_ERROR.DISCONNECTED);
    assert.match(err.message, /unknown tool\.result id 'call-unknown'/);
    return true;
  });
  const secondRejected = assert.rejects(second, (err) => {
    assert.equal(err.code, TOOL_RESULT_ERROR.DISCONNECTED);
    assert.match(err.message, /unknown tool\.result id 'call-unknown'/);
    return true;
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOL_RESULT,
    id: "call-unknown",
    data: "late"
  }));

  await Promise.all([firstRejected, secondRejected]);
  assert.equal(conn.state, CONNECTION_STATE.DISCONNECTED);
  assert.equal(wsAdapter.socket.closed, true);
  assert.deepEqual(toolResults, []);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.UNKNOWN_CALL_ID &&
    message.replyTo === "call-unknown"
  )));
});

test("bound provider push is delivered through callback", () => {
  const wsAdapter = createMockWebSocketAdapter();
  const pushes = [];
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    onPush(connection, push) {
      pushes.push({
        providerId: connection.providerId,
        providerName: connection.providerName,
        sessionId: connection.sessionId,
        push
      });
    }
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.PUSH,
    level: EVENT_OUTCOME.INJECT,
    event: "browser asked for help",
    stream: "detour",
    metadata: { clientId: "tab-1" }
  }));

  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.equal(wsAdapter.socket.closed, false);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].providerName, "demo");
  assert.equal(pushes[0].sessionId, "s1");
  assert.deepEqual(pushes[0].push, {
    level: EVENT_OUTCOME.INJECT,
    event: "browser asked for help",
    stream: "detour",
    sessionId: undefined,
    metadata: { clientId: "tab-1" }
  });
  assert.ok(!sentMessages(wsAdapter).some((message) => message.type === MESSAGE_TYPE.ERROR));
});

test("bound provider push rejects stream names that normalize empty without delivery", () => {
  const wsAdapter = createMockWebSocketAdapter();
  const pushes = [];
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    onPush(_connection, push) {
      pushes.push(push);
    }
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.PUSH,
    level: EVENT_OUTCOME.SURFACE,
    event: "should not append to main",
    stream: "!!!"
  }));

  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.equal(wsAdapter.socket.closed, false);
  assert.deepEqual(pushes, []);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.UNKNOWN_TYPE &&
    message.replyTo === MESSAGE_TYPE.PUSH &&
    /resolve to a non-empty identifier/.test(message.message)
  )));
});

test("bound provider push rejects mismatched session without disconnecting", () => {
  const wsAdapter = createMockWebSocketAdapter();
  const pushes = [];
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    onPush(_connection, push) {
      pushes.push(push);
    }
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.PUSH,
    level: EVENT_OUTCOME.SURFACE,
    event: "wrong session",
    stream: "detour",
    sessionId: "other-session"
  }));

  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.equal(wsAdapter.socket.closed, false);
  assert.deepEqual(pushes, []);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.INVALID_SESSION &&
    message.replyTo === MESSAGE_TYPE.PUSH
  )));
});

test("tools.update callback updates bound connection tools", () => {
  const wsAdapter = createMockWebSocketAdapter();
  const updates = [];
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [{
      name: "old_tool",
      description: "Old provider tool",
      parameters: { type: "object", properties: {} }
    }],
    onToolsUpdate(connection, update) {
      updates.push({
        providerId: connection.providerId,
        before: connection.tools.map((tool) => tool.name),
        after: update.tools.map((tool) => tool.name)
      });
    }
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [{
      name: "new_tool",
      description: "New provider tool",
      parameters: { type: "object", properties: {} }
    }]
  }));

  assert.deepEqual(updates, [{
    providerId: conn.providerId,
    before: ["old_tool"],
    after: ["new_tool"]
  }]);
  assert.deepEqual(conn.tools.map((tool) => tool.name), ["new_tool"]);
  assert.ok(!sentMessages(wsAdapter).some((message) => message.type === MESSAGE_TYPE.ERROR));
});

test("tools.update callback async success updates bound connection tools after settlement", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  let resolveUpdate;
  const updateAccepted = new Promise((resolve) => {
    resolveUpdate = resolve;
  });
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [providerTool("old_tool")],
    onToolsUpdate() {
      return updateAccepted;
    }
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [providerTool("new_tool")]
  }));

  assert.deepEqual(conn.tools.map((tool) => tool.name), ["old_tool"]);
  resolveUpdate();
  await flushMicrotasks();

  assert.deepEqual(conn.tools.map((tool) => tool.name), ["new_tool"]);
  assert.ok(!sentMessages(wsAdapter).some((message) => message.type === MESSAGE_TYPE.ERROR));
});

test("removed provider tool calls reject immediately without sending or leaving pending state", async () => {
  const timerAdapter = createMockTimerAdapter();
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    timerAdapter,
    tools: [providerTool("old_tool", { timeout: 100 })]
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [providerTool("new_tool", { timeout: 25 })]
  }));
  assert.deepEqual(conn.tools.map((tool) => tool.name), ["new_tool"]);

  const sentBeforeRemovedCall = sentMessages(wsAdapter).length;
  const removedCall = conn.sendToolCall("call-removed", "s1", "old_tool", {});
  const removedOutcome = await promiseStateAfterMicrotask(removedCall);

  assert.equal(removedOutcome.status, "rejected");
  assert.equal(removedOutcome.error.code, TOOL_RESULT_ERROR.NOT_FOUND);
  assert.match(removedOutcome.error.message, /old_tool/);
  assert.equal(timerAdapter.pendingCount, 0);
  assert.equal(sentMessages(wsAdapter).length, sentBeforeRemovedCall);
  assert.equal(sentMessages(wsAdapter).filter((message) => (
    message.type === MESSAGE_TYPE.TOOL_CALL &&
    message.tool === "old_tool"
  )).length, 0);

  const currentCall = conn.sendToolCall("call-removed", "s1", "new_tool", {});
  assert.equal(timerAdapter.pendingCount, 1);
  assert.equal(sentMessages(wsAdapter).filter((message) => (
    message.type === MESSAGE_TYPE.TOOL_CALL &&
    message.id === "call-removed" &&
    message.tool === "new_tool"
  )).length, 1);

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOL_RESULT,
    id: "call-removed",
    data: { ok: true }
  }));

  const currentOutcome = await promiseStateAfterMicrotask(currentCall);
  assert.equal(currentOutcome.status, "fulfilled");
  assert.deepEqual(currentOutcome.value.data, { ok: true });
  assert.equal(timerAdapter.pendingCount, 0);
});

test("tools.update failure preserves previous connection tools", () => {
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [{
      name: "stable_tool",
      description: "Stable provider tool",
      parameters: { type: "object", properties: {} }
    }],
    onToolsUpdate() {
      throw new ConflictError("tool name conflict: tap_tool", { code: ERROR_CODE.TOOL_CONFLICT });
    }
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [{
      name: "tap_tool",
      description: "Conflicting provider tool",
      parameters: { type: "object", properties: {} }
    }]
  }));

  assert.deepEqual(conn.tools.map((tool) => tool.name), ["stable_tool"]);
  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.equal(wsAdapter.socket.closed, false);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.TOOL_CONFLICT &&
    message.replyTo === MESSAGE_TYPE.TOOLS_UPDATE
  )));
});

test("tools.update callback promise rejection preserves previous connection tools", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [{
      name: "old_tool",
      description: "Old provider tool",
      parameters: { type: "object", properties: {} }
    }],
    onToolsUpdate() {
      return Promise.reject(new ConflictError("async tool conflict", { code: ERROR_CODE.TOOL_CONFLICT }));
    }
  });

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [{
      name: "new_tool",
      description: "New provider tool",
      parameters: { type: "object", properties: {} }
    }]
  }));

  assert.deepEqual(conn.tools.map((tool) => tool.name), ["old_tool"]);
  await flushMicrotasks();

  assert.deepEqual(conn.tools.map((tool) => tool.name), ["old_tool"]);
  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.equal(wsAdapter.socket.closed, false);
  assert.ok(sentMessages(wsAdapter).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.TOOL_CONFLICT &&
    message.replyTo === MESSAGE_TYPE.TOOLS_UPDATE
  )));
});

test("tool.result callback catches promise rejection after resolving pending call", async () => {
  const wsAdapter = createMockWebSocketAdapter();
  const logs = [];
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    tools: [providerTool("callback_tool")],
    onToolResult() {
      return Promise.reject(new Error("tool result async failed"));
    },
    log(message) {
      logs.push(message);
    }
  });

  const call = conn.sendToolCall("call-async-result-callback", "s1", "callback_tool", {});
  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOL_RESULT,
    id: "call-async-result-callback",
    data: { ok: true }
  }));

  const outcome = await promiseStateAfterMicrotask(call);
  assert.equal(outcome.status, "fulfilled");
  assert.deepEqual(outcome.value.data, { ok: true });
  await flushMicrotasks();

  assert.equal(conn.state, CONNECTION_STATE.BOUND);
  assert.ok(logs.some((message) => (
    message.includes("onToolResult callback error") &&
    message.includes("tool result async failed")
  )));
});

test("duplicate pending tool call id rejects duplicate without orphaning original", async () => {
  const timerAdapter = createMockTimerAdapter();
  const wsAdapter = createMockWebSocketAdapter();
  const { conn } = bindConnection({
    websocketAdapter: wsAdapter,
    timerAdapter,
    tools: [{
      name: "dup_tool",
      description: "Provider tool with duplicate call id coverage",
      parameters: { type: "object", properties: {} },
      timeout: 100
    }]
  });

  const first = conn.sendToolCall("call-duplicate", "s1", "dup_tool", {});
  assert.equal(timerAdapter.pendingCount, 1);

  const duplicate = conn.sendToolCall("call-duplicate", "s1", "dup_tool", {});
  const duplicateOutcome = await promiseStateAfterMicrotask(duplicate);
  assert.equal(duplicateOutcome.status, "rejected");
  assert.equal(duplicateOutcome.error.code, "CONFLICT");
  assert.match(duplicateOutcome.error.message, /already pending/);
  assert.equal(timerAdapter.pendingCount, 1);
  assert.equal(sentMessages(wsAdapter).filter((message) => (
    message.type === MESSAGE_TYPE.TOOL_CALL &&
    message.id === "call-duplicate"
  )).length, 1);

  wsAdapter.emitMessage(JSON.stringify({
    type: MESSAGE_TYPE.TOOL_RESULT,
    id: "call-duplicate",
    data: { ok: true }
  }));

  const firstOutcome = await promiseStateAfterMicrotask(first);
  assert.equal(firstOutcome.status, "fulfilled");
  assert.deepEqual(firstOutcome.value.data, { ok: true });
  assert.equal(timerAdapter.pendingCount, 0);
  assert.equal(sentMessages(wsAdapter).filter((message) => (
    message.type === MESSAGE_TYPE.TOOL_CANCEL &&
    message.id === "call-duplicate"
  )).length, 0);
});

test("wrapped provider tool normalizes nullish args before dispatch", async () => {
  const dispatches = [];
  const wrapped = wrapProviderTool({
    providerId: "p-tool",
    providerName: "provider",
    name: "no_args",
    description: "Provider no-arg tool",
    parameters: { type: "object", properties: {} }
  }, async (providerId, toolName, callId, args) => {
    dispatches.push({ providerId, toolName, callId, args });
    buildToolCall(callId, "s1", toolName, args);
    return { data: { ok: true, args } };
  });

  const undefinedResult = await wrapped.handler(undefined, { callId: "call-undefined" });
  const nullResult = await wrapped.handler(null, { callId: "call-null" });

  assert.deepEqual(undefinedResult, { ok: true, args: {} });
  assert.deepEqual(nullResult, { ok: true, args: {} });
  assert.deepEqual(dispatches, [
    { providerId: "p-tool", toolName: "no_args", callId: "call-undefined", args: {} },
    { providerId: "p-tool", toolName: "no_args", callId: "call-null", args: {} }
  ]);
});

test("wrapped provider tool preserves non-object args validation", async () => {
  const dispatches = [];
  const wrapped = wrapProviderTool({
    providerId: "p-tool",
    providerName: "provider",
    name: "validated_args",
    description: "Provider tool with argument validation",
    parameters: { type: "object", properties: {} }
  }, async (providerId, toolName, callId, args) => {
    dispatches.push({ providerId, toolName, callId, args });
    buildToolCall(callId, "s1", toolName, args);
    return { data: { ok: true } };
  });

  const invalidArgs = [["array"], "string", 1, false];
  for (const [index, args] of invalidArgs.entries()) {
    await assert.rejects(
      wrapped.handler(args, { callId: `call-invalid-${index}` }),
      /args must be a plain object/
    );
  }

  assert.deepEqual(dispatches.map((entry) => entry.args), invalidArgs);
});
