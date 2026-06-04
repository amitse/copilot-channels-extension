import test from "node:test";
import assert from "node:assert/strict";

import { CONNECTION_STATE, MESSAGE_TYPE, PROTOCOL_VERSION, TOKEN_PREFIX } from "./consts.mjs";
import { computeTransition, CONNECTION_EVENT } from "./connection-state.mjs";
import { createProviderConnection } from "./connection.mjs";
import { createMockWebSocketAdapter } from "../test-support/adapters.mjs";

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
