import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { MESSAGE_TYPE, PROTOCOL_VERSION, RELOAD_DEBOUNCE_MS } from "./consts.mjs";
import { createProviderGateway } from "./gateway.mjs";
import { computeTransition, identifyActions, GATEWAY_EVENT, GATEWAY_ACTION } from "./gateway-state.mjs";
import { createMockTimerAdapter, createMockWebSocketAdapter } from "../test-support/adapters.mjs";

function createFakeServerFactory(servers) {
  return () => {
    const server = new EventEmitter();
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
    webSocketServerFactory: createFakeServerFactory(servers)
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

test("gateway clears startup state after bind error and can retry", () => {
  const servers = [];
  const gateway = createProviderGateway({
    tapTools: () => [],
    getSessionInfo: () => null,
    log: () => {}
  }, {
    webSocketServerFactory: createFakeServerFactory(servers)
  });

  gateway.start();
  servers[0].emit("error", new Error("EADDRINUSE"));

  assert.equal(gateway.isRunning(), false);
  assert.equal(gateway.getToken(), null);
  assert.equal(servers[0].closed, true);

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
