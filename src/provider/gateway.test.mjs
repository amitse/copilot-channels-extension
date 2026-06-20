import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  EVENT_OUTCOME,
} from "../consts.mjs";
import {
  ERROR_CODE,
  GATEWAY_PORT,
  MESSAGE_TYPE,
  PROTOCOL_VERSION,
  RELOAD_DEBOUNCE_MS,
  SESSION_LIFECYCLE_STATE
} from "./consts.mjs";
import { createProviderGateway } from "./gateway.mjs";
import { computeTransition, identifyActions, GATEWAY_EVENT, GATEWAY_ACTION } from "./gateway-state.mjs";
import { createMockTimerAdapter, createMockWebSocketAdapter } from "../test-support/adapters.mjs";

function createFakeServerFactory(servers) {
  return (options) => {
    const server = new EventEmitter();
    server.options = options;
    server.closed = false;
    server.close = () => {
      if (server.closed) {
        return;
      }
      server.closed = true;
      server.emit("close");
    };
    servers.push(server);
    return server;
  };
}

function createFakeFsAdapter() {
  const operations = [];
  return {
    operations,
    mkdirSync(targetPath, options) {
      operations.push({ type: "mkdirSync", path: targetPath, options });
    },
    writeFileSync(targetPath, data, options) {
      operations.push({ type: "writeFileSync", path: targetPath, data, options });
    },
    chmodSync(targetPath, mode) {
      operations.push({ type: "chmodSync", path: targetPath, mode });
    },
    rmSync(targetPath, options) {
      operations.push({ type: "rmSync", path: targetPath, options });
    }
  };
}

function createIsolatedAdapters(overrides = {}) {
  return {
    fsAdapter: createFakeFsAdapter(),
    pathAdapter: { join: (...parts) => parts.join("/") },
    environment: { COPILOT_HOME: "/copilot-home" },
    homeDirectory: () => "/home/user",
    ...overrides
  };
}

function createFakeSocket(sent = []) {
  const socket = new EventEmitter();
  socket.closed = false;
  socket.send = (payload) => {
    sent.push(payload);
  };
  socket.close = () => {
    if (socket.closed) {
      return;
    }
    socket.closed = true;
    socket.emit("close");
  };
  return socket;
}

function bindProvider(socket, token, { name, toolName, sessionId = "s1" }) {
  socket.emit("message", JSON.stringify({ type: MESSAGE_TYPE.AUTH, token }));
  socket.emit("message", JSON.stringify({
    type: MESSAGE_TYPE.HELLO,
    name,
    protocolVersion: PROTOCOL_VERSION,
    session: sessionId,
    tools: [{
      name: toolName,
      description: "Provider tool",
      parameters: { type: "object", properties: {} }
    }]
  }));
}

test("gateway transition starts and reloads deterministically", () => {
  const started = computeTransition(
    { running: false, reloadPending: false, reloadTimerActive: false, token: null },
    { type: GATEWAY_EVENT.START, token: "ptk-x" }
  );

  assert.equal(started.nextState.running, true);
  assert.equal(identifyActions(started)[0].type, GATEWAY_ACTION.SET_TOKEN);

  const reloaded = computeTransition(
    started.nextState,
    { type: GATEWAY_EVENT.SCHEDULE_RELOAD, delayMs: 10 }
  );

  assert.equal(reloaded.nextState.reloadPending, true);
  assert.equal(identifyActions(reloaded)[0].type, GATEWAY_ACTION.SCHEDULE_TIMER);
});

test("gateway reports running only after websocket server listens", () => {
  const servers = [];
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => null,
    log: () => {}
  }, {
    ...createIsolatedAdapters({
      webSocketServerFactory: createFakeServerFactory(servers)
    })
  });

  gateway.start();

  assert.equal(gateway.isRunning(), false);
  assert.equal(gateway.getToken(), null);

  servers[0].emit("listening");

  assert.equal(gateway.isRunning(), true);
  assert.match(gateway.getToken(), /^ptk-/);

  gateway.stop();

  assert.equal(gateway.isRunning(), false);
  assert.equal(gateway.getToken(), null);
  assert.equal(servers[0].closed, true);
});

test("gateway binds websocket server to loopback host by default", () => {
  const servers = [];
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => null,
    log: () => {}
  }, {
    ...createIsolatedAdapters({
      webSocketServerFactory: createFakeServerFactory(servers)
    })
  });

  gateway.start();

  assert.deepEqual(servers[0].options, {
    port: GATEWAY_PORT,
    host: "127.0.0.1",
    noServer: false
  });

  gateway.stop();
});

test("gateway treats an occupied provider port as an existing mesh owner", () => {
  const servers = [];
  const logs = [];
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => null,
    log: (message) => logs.push(message)
  }, {
    ...createIsolatedAdapters({
      webSocketServerFactory: createFakeServerFactory(servers)
    })
  });

  gateway.start();
  servers[0].emit("error", new Error("EADDRINUSE"));

  assert.equal(gateway.isRunning(), false);
  assert.equal(gateway.getToken(), null);
  assert.equal(servers[0].closed, true);
  assert.match(logs.at(-1), /mesh already has an owner/);
  assert.match(logs.at(-1), /No action is needed unless provider tools are missing/);
  assert.doesNotMatch(logs.at(-1), /Failed|stale|stop the stale process/i);

  gateway.start();

  assert.equal(servers.length, 2);
  servers[1].emit("listening");
  assert.equal(gateway.isRunning(), true);

  gateway.stop();
});

test("gateway tools-changed callback survives stop and restart", () => {
  const servers = [];
  const timerAdapter = createMockTimerAdapter();
  const websocketAdapter = createMockWebSocketAdapter();
  const toolRefreshes = [];
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => ({ id: "s1", label: "One", cwd: "C:/tmp" }),
    log: () => {}
  }, {
    ...createIsolatedAdapters(),
    timerAdapter,
    websocketAdapter,
    webSocketServerFactory: createFakeServerFactory(servers)
  });

  gateway.onToolsChanged((tools) => {
    toolRefreshes.push(tools.map((tool) => tool.name));
  });

  gateway.start();
  servers[0].emit("listening");
  gateway.stop();

  gateway.start();
  servers[1].emit("listening");

  const sent = [];
  const socket = createFakeSocket(sent);
  servers[1].emit("connection", socket);
  socket.emit("message", JSON.stringify({ type: MESSAGE_TYPE.AUTH, token: gateway.getToken() }));
  socket.emit("message", JSON.stringify({
    type: MESSAGE_TYPE.HELLO,
    name: "demo",
    protocolVersion: PROTOCOL_VERSION,
    session: "s1",
    tools: [{
      name: "provider_tool",
      description: "Provider tool",
      parameters: { type: "object", properties: {} }
    }]
  }));

  timerAdapter.advance(RELOAD_DEBOUNCE_MS);

  assert.deepEqual(toolRefreshes, [["provider_tool"]]);

  gateway.stop();
});

test("gateway default connection adapter processes auth and hello", () => {
  const servers = [];
  const sent = [];
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => ({ id: "s1", label: "One", cwd: "C:/tmp" }),
    log: () => {}
  }, {
    ...createIsolatedAdapters({
      webSocketServerFactory: createFakeServerFactory(servers)
    })
  });

  gateway.start();
  servers[0].emit("listening");

  const socket = createFakeSocket(sent);
  servers[0].emit("connection", socket);

  bindProvider(socket, gateway.getToken(), { name: "demo", toolName: "provider_tool" });

  assert.equal(JSON.parse(sent[0]).type, MESSAGE_TYPE.SESSIONS);
  assert.deepEqual(JSON.parse(sent[0]).active, [{ id: "s1", label: "One", cwd: "C:/tmp" }]);
  assert.equal(JSON.parse(sent[1]).type, MESSAGE_TYPE.HELLO_ACK);
  assert.equal(JSON.parse(sent[1]).protocolVersion, PROTOCOL_VERSION);
  assert.match(JSON.parse(sent[1]).providerId, /^p-/);

  gateway.stop();
});

test("gateway writes and removes provider token file with restrictive permissions", () => {
  const servers = [];
  const fsAdapter = createFakeFsAdapter();
  const environment = { COPILOT_HOME: "/custom-copilot" };
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => null,
    log: () => {}
  }, {
    fsAdapter,
    pathAdapter: { join: (...parts) => parts.join("/") },
    environment,
    homeDirectory: () => "/home/user",
    webSocketServerFactory: createFakeServerFactory(servers)
  });

  gateway.start();
  servers[0].emit("listening");

  const token = gateway.getToken();
  assert.match(token, /^ptk-/);
  assert.equal(environment.TAP_PROVIDER_TOKEN, token);
  assert.deepEqual(fsAdapter.operations.slice(0, 3), [
    {
      type: "mkdirSync",
      path: "/custom-copilot/extensions/tap",
      options: { recursive: true, mode: 0o700 }
    },
    {
      type: "writeFileSync",
      path: "/custom-copilot/extensions/tap/.provider-token",
      data: `${token}\n`,
      options: { encoding: "utf8", mode: 0o600 }
    },
    {
      type: "chmodSync",
      path: "/custom-copilot/extensions/tap/.provider-token",
      mode: 0o600
    }
  ]);

  gateway.stop();

  assert.equal(environment.TAP_PROVIDER_TOKEN, undefined);
  assert.deepEqual(fsAdapter.operations.at(-1), {
    type: "rmSync",
    path: "/custom-copilot/extensions/tap/.provider-token",
    options: { force: true }
  });
});

test("gateway keeps providers open until shutdown goodbye or deadline", () => {
  const servers = [];
  const timerAdapter = createMockTimerAdapter();
  const sentA = [];
  const sentB = [];
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => ({ id: "s1", label: "One", cwd: "C:/tmp" }),
    log: () => {}
  }, {
    ...createIsolatedAdapters({
      timerAdapter,
      webSocketServerFactory: createFakeServerFactory(servers)
    })
  });

  gateway.start();
  servers[0].emit("listening");

  const socketA = createFakeSocket(sentA);
  const socketB = createFakeSocket(sentB);
  servers[0].emit("connection", socketA);
  servers[0].emit("connection", socketB);

  bindProvider(socketA, gateway.getToken(), { name: "demo-a", toolName: "provider_tool_a" });
  bindProvider(socketB, gateway.getToken(), { name: "demo-b", toolName: "provider_tool_b" });

  gateway.broadcastLifecycle("s1", SESSION_LIFECYCLE_STATE.SHUTDOWN_PENDING, 50);
  gateway.stop();

  assert.equal(servers[0].closed, true);
  assert.equal(socketA.closed, false);
  assert.equal(socketB.closed, false);

  const lifecycleA = JSON.parse(sentA.at(-1));
  const lifecycleB = JSON.parse(sentB.at(-1));
  assert.deepEqual(lifecycleA, {
    type: MESSAGE_TYPE.SESSION_LIFECYCLE,
    sessionId: "s1",
    state: SESSION_LIFECYCLE_STATE.SHUTDOWN_PENDING,
    deadline: 50
  });
  assert.deepEqual(lifecycleB, lifecycleA);

  socketA.emit("message", JSON.stringify({ type: MESSAGE_TYPE.GOODBYE, reason: "done" }));
  assert.equal(socketA.closed, true);
  assert.equal(socketB.closed, false);

  timerAdapter.advance(49);
  assert.equal(socketB.closed, false);

  timerAdapter.advance(1);
  assert.equal(socketB.closed, true);
  assert.equal(timerAdapter.pendingCount, 0);
});

test("gateway routes provider push through delivery adapter", () => {
  const servers = [];
  const delivered = [];
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => ({ id: "s1", label: "One", cwd: "C:/tmp" }),
    deliverPush(provider, push) {
      delivered.push({ provider, push });
    },
    log: () => {}
  }, {
    ...createIsolatedAdapters({
      webSocketServerFactory: createFakeServerFactory(servers)
    })
  });

  gateway.start();
  servers[0].emit("listening");

  const sent = [];
  const socket = createFakeSocket(sent);
  servers[0].emit("connection", socket);
  bindProvider(socket, gateway.getToken(), { name: "detour", toolName: "reply_to_page" });

  socket.emit("message", JSON.stringify({
    type: MESSAGE_TYPE.PUSH,
    level: EVENT_OUTCOME.INJECT,
    event: "page asks for help",
    stream: "detour",
    metadata: { clientId: "tab-1" }
  }));

  const providerId = JSON.parse(sent[1]).providerId;
  assert.deepEqual(delivered, [{
    provider: { providerId, providerName: "detour", sessionId: "s1" },
    push: {
      level: EVENT_OUTCOME.INJECT,
      event: "page asks for help",
      stream: "detour",
      sessionId: undefined,
      metadata: { clientId: "tab-1" }
    }
  }]);

  gateway.stop();
});

test("gateway applies tools.update and debounces refreshed session tools", () => {
  const servers = [];
  const timerAdapter = createMockTimerAdapter();
  const toolRefreshes = [];
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => ({ id: "s1", label: "One", cwd: "C:/tmp" }),
    log: () => {}
  }, {
    ...createIsolatedAdapters({
      timerAdapter,
      webSocketServerFactory: createFakeServerFactory(servers)
    })
  });

  gateway.onToolsChanged((tools) => {
    toolRefreshes.push(tools.map((tool) => tool.name));
  });

  gateway.start();
  servers[0].emit("listening");

  const sent = [];
  const socket = createFakeSocket(sent);
  servers[0].emit("connection", socket);
  bindProvider(socket, gateway.getToken(), { name: "demo", toolName: "old_tool" });
  timerAdapter.advance(RELOAD_DEBOUNCE_MS);

  const providerId = JSON.parse(sent[1]).providerId;
  socket.emit("message", JSON.stringify({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [{
      name: "new_tool",
      description: "New provider tool",
      parameters: { type: "object", properties: {} }
    }]
  }));
  timerAdapter.advance(RELOAD_DEBOUNCE_MS);

  assert.deepEqual(toolRefreshes, [["old_tool"], ["new_tool"]]);
  assert.deepEqual(
    gateway.getRegistry().getProvider(providerId).tools.map((tool) => tool.name),
    ["new_tool"]
  );

  gateway.stop();
});

test("gateway rejects conflicting tools.update and preserves provider tools", () => {
  const servers = [];
  const timerAdapter = createMockTimerAdapter();
  const toolRefreshes = [];
  const gateway = createProviderGateway({
    tapTools: () => [{ name: "tap_tool", description: "Tap tool", parameters: { type: "object", properties: {} }, handler: async () => "" }],
    getSessionInfo: () => ({ id: "s1", label: "One", cwd: "C:/tmp" }),
    log: () => {}
  }, {
    ...createIsolatedAdapters({
      timerAdapter,
      webSocketServerFactory: createFakeServerFactory(servers)
    })
  });

  gateway.onToolsChanged((tools) => {
    toolRefreshes.push(tools.map((tool) => tool.name));
  });

  gateway.start();
  servers[0].emit("listening");

  const sent = [];
  const socket = createFakeSocket(sent);
  servers[0].emit("connection", socket);
  bindProvider(socket, gateway.getToken(), { name: "demo", toolName: "stable_tool" });
  timerAdapter.advance(RELOAD_DEBOUNCE_MS);

  const providerId = JSON.parse(sent[1]).providerId;
  socket.emit("message", JSON.stringify({
    type: MESSAGE_TYPE.TOOLS_UPDATE,
    tools: [{
      name: "tap_tool",
      description: "Conflicting provider tool",
      parameters: { type: "object", properties: {} }
    }]
  }));
  timerAdapter.advance(RELOAD_DEBOUNCE_MS);

  assert.deepEqual(
    gateway.getRegistry().getProvider(providerId).tools.map((tool) => tool.name),
    ["stable_tool"]
  );
  assert.deepEqual(toolRefreshes, [["tap_tool", "stable_tool"]]);
  assert.ok(sent.map((payload) => JSON.parse(payload)).some((message) => (
    message.type === MESSAGE_TYPE.ERROR &&
    message.code === ERROR_CODE.TOOL_CONFLICT &&
    message.replyTo === MESSAGE_TYPE.TOOLS_UPDATE
  )));

  gateway.stop();
});
