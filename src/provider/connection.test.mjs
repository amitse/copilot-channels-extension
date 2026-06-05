import test from "node:test";
import assert from "node:assert/strict";

import { CONNECTION_STATE, MESSAGE_TYPE, PROTOCOL_VERSION, TOKEN_PREFIX, TOOL_RESULT_ERROR } from "./consts.mjs";
import { computeTransition, CONNECTION_EVENT } from "./connection-state.mjs";
import { createProviderConnection } from "./connection.mjs";
import { createMockTimerAdapter, createMockWebSocketAdapter } from "../test-support/adapters.mjs";

function bindConnection({
  tools = [],
  websocketAdapter = createMockWebSocketAdapter(),
  timerAdapter,
  onToolResult = () => {}
} = {}) {
  const adapters = { websocketAdapter };
  if (timerAdapter) {
    adapters.timerAdapter = timerAdapter;
  }

  const conn = createProviderConnection(websocketAdapter.socket, {
    expectedToken: `${TOKEN_PREFIX}secret`,
    activeSessions: [{ id: "s1", label: "One", cwd: "C:/tmp" }],
    onBound: () => {},
    onUnbound: () => {},
    onToolResult,
    checkToolConflict: () => [],
    log: () => {}
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
