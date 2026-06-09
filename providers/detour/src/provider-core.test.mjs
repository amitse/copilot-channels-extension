import assert from "node:assert/strict";
import test from "node:test";

import { MESSAGE_TYPES } from "./contracts.js";
import {
  AUTH_HEADER,
  BRIDGE_TOKEN_PLACEHOLDER,
  MAX_LOG_BUFFER,
  applyCorsHeaders,
  buildMessagesResponse,
  clientLabelFrom,
  firstClientIdFrom,
  getRequestToken,
  isAllowedCorsOrigin,
  isAuthorizedRequest,
  isLoopbackAddress,
  isLoopbackHostHeader,
  listBrowserClients,
  planBrowserMessage,
  planToolCall,
  renderBridgeScript,
  routeHttpRequest,
  selectConsoleLogs,
  selectPageMessages,
} from "./provider-core.js";

test("client helpers preserve map ordering and labels", () => {
  const clients = new Map([
    ["tab-1", { title: "Cart", url: "https://example.test/cart", connectedAt: "t1" }],
    ["tab-2", { title: "Checkout", url: "https://example.test/checkout", connectedAt: "t2" }],
  ]);

  assert.equal(MAX_LOG_BUFFER, 500);
  assert.equal(firstClientIdFrom(clients), "tab-1");
  assert.equal(clientLabelFrom(clients, "tab-2"), "Checkout (https://example.test/checkout)");
  assert.equal(clientLabelFrom(clients, "missing"), "missing");
  assert.deepEqual(listBrowserClients(clients), [
    { id: "tab-1", title: "Cart", url: "https://example.test/cart", connectedAt: "t1" },
    { id: "tab-2", title: "Checkout", url: "https://example.test/checkout", connectedAt: "t2" },
  ]);
});

test("selectors match Detour buffer read behavior", () => {
  const logs = [
    { clientId: "tab-1", level: "log", message: "first" },
    { clientId: "tab-2", level: "warn", message: "second" },
    { clientId: "tab-1", level: "warn", message: "third" },
  ];
  assert.deepEqual(selectConsoleLogs(logs, { client_id: "tab-1", level: "warn", limit: 5 }), [
    { clientId: "tab-1", level: "warn", message: "third" },
  ]);
  assert.deepEqual(selectPageMessages(["a", "b", "c"], { limit: 2 }), ["b", "c"]);
});

test("HTTP request helpers keep route and message response semantics", () => {
  assert.equal(routeHttpRequest("OPTIONS", "/anything"), "options");
  assert.equal(routeHttpRequest("GET", "/bridge.js?token=t"), "bridge");
  assert.equal(routeHttpRequest("POST", "/eval?token=t"), "eval");
  assert.equal(routeHttpRequest("GET", "/clients?token=t"), "clients");
  assert.equal(routeHttpRequest("GET", "/logs?level=warn"), "logs");
  assert.equal(routeHttpRequest("GET", "/messages?ack=1"), "messages");
  assert.equal(routeHttpRequest("POST", "/reply?token=t"), "reply");
  assert.equal(routeHttpRequest("GET", "/missing"), "notFound");

  assert.deepEqual(buildMessagesResponse(["zero", "one", "two"], "/messages?ack=1"), {
    total: 3,
    messages: ["one", "two"],
  });
});

test("bridge auth helpers require loopback and explicit token", () => {
  const reqFromQuery = { url: "/bridge.js?token=secret", headers: { host: "127.0.0.1:9401" } };
  const reqFromHeader = { url: "/messages", headers: { host: "localhost:9401", [AUTH_HEADER]: "secret" } };
  const reqFromBearer = { url: "/messages", headers: { host: "[::1]:9401", authorization: "Bearer secret" } };

  assert.equal(getRequestToken(reqFromQuery), "secret");
  assert.equal(getRequestToken(reqFromHeader), "secret");
  assert.equal(getRequestToken(reqFromBearer), "secret");
  assert.equal(isAuthorizedRequest(reqFromQuery, "secret"), true);
  assert.equal(isAuthorizedRequest({ url: "/bridge.js", headers: {} }, "secret"), false);
  assert.equal(isLoopbackHostHeader("127.0.0.1:9401"), true);
  assert.equal(isLoopbackHostHeader("localhost:9401"), true);
  assert.equal(isLoopbackHostHeader("[::1]:9401"), true);
  assert.equal(isLoopbackHostHeader("evil.test:9401"), false);
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
});

test("bridge script rendering injects an unexposed loopback websocket token", () => {
  const script = `var WS_URL = "${BRIDGE_TOKEN_PLACEHOLDER}";`;
  assert.equal(
    renderBridgeScript(script, 9401, "token with spaces"),
    'var WS_URL = "ws://127.0.0.1:9401?token=token%20with%20spaces";',
  );
});

test("CORS helper only reflects chrome-extension origins", () => {
  assert.equal(isAllowedCorsOrigin("chrome-extension://abc"), true);
  assert.equal(isAllowedCorsOrigin("https://evil.test"), false);

  const headers = new Map();
  const res = { setHeader: (name, value) => headers.set(name, value) };
  applyCorsHeaders({ headers: { origin: "chrome-extension://abc" } }, res);
  assert.equal(headers.get("Access-Control-Allow-Origin"), "chrome-extension://abc");

  headers.clear();
  applyCorsHeaders({ headers: { origin: "https://evil.test" } }, res);
  assert.equal(headers.has("Access-Control-Allow-Origin"), false);
});

test("browser message planner preserves Detour push and log text", () => {
  const timestamps = ["pending-time", "message-time"];
  const plan = planBrowserMessage(JSON.stringify({
    type: MESSAGE_TYPES.PAGE_ASK,
    id: "ask-1",
    message: "Can you review this button?",
  }), {
    clientId: "tab-1",
    from: "Checkout (https://example.test)",
    nowIso: () => timestamps.shift(),
  });

  assert.deepEqual(plan, {
    kind: "pageAsk",
    askId: "ask-1",
    logText: "❓ [ASK from Checkout (https://example.test)] Can you review this button?",
    pendingAsk: {
      clientId: "tab-1",
      message: "Can you review this button?",
      from: "Checkout (https://example.test)",
      timestamp: "pending-time",
    },
    pageMessage: {
      clientId: "tab-1",
      from: "Checkout (https://example.test)",
      message: "Can you review this button?",
      type: "ask",
      askId: "ask-1",
      timestamp: "message-time",
    },
    pushText: "[ASK from Checkout (https://example.test)] Can you review this button? (reply with reply_to_page tool, askId: \"ask-1\")",
  });
});

test("tool-call planner keeps public tool responses side-effect free", () => {
  const clients = new Map([
    ["tab-1", { title: "Cart", url: "https://example.test/cart", connectedAt: "t1" }],
  ]);
  const pending = { from: "Cart (https://example.test/cart)", ws: { readyState: 1 } };
  const state = {
    firstClientId: "tab-1",
    clients,
    consoleLogs: [{ clientId: "tab-1", level: "warn", message: "careful" }],
    pageMessages: ["older", "latest"],
    pendingPageAsks: new Map([["ask-1", pending]]),
  };

  assert.deepEqual(planToolCall("inject_js", { code: "1 + 1", timeout_ms: 0 }, state), {
    kind: "eval",
    clientId: "tab-1",
    code: "1 + 1",
    timeoutMs: 15000,
  });
  assert.deepEqual(planToolCall("get_console_logs", { level: "warn", clear: true }, state), {
    kind: "consoleLogs",
    logs: [{ clientId: "tab-1", level: "warn", message: "careful" }],
    clear: true,
  });
  assert.deepEqual(planToolCall("get_page_messages", { limit: 1 }, state), {
    kind: "result",
    value: ["latest"],
  });
  assert.deepEqual(planToolCall("reply_to_page", { ask_id: "ask-1", reply: "Looks good" }, state), {
    kind: "replyToPage",
    askId: "ask-1",
    pending,
    payload: { type: MESSAGE_TYPES.ASK_REPLY, id: "ask-1", reply: "Looks good" },
    result: { ok: true, repliedTo: "Cart (https://example.test/cart)" },
  });
  assert.deepEqual(planToolCall("missing_tool", {}, state), {
    kind: "unknown",
    toolName: "missing_tool",
  });
});
