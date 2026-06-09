/**
 * Detour Provider — browser↔agent bridge built on tap-provider-sdk.
 *
 * Serves bridge.js over HTTP, manages browser WS connections,
 * and registers tools with the Copilot session via the SDK.
 */
import { createProvider } from "../../sdk/index.mjs";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MESSAGE_TYPES } from "./src/contracts.js";
import {
  AUTH_HEADER,
  MAX_LOG_BUFFER,
  applyCorsHeaders,
  buildMessagesResponse,
  clientLabelFrom,
  firstClientIdFrom,
  isAuthorizedRequest,
  isLoopbackAddress,
  isLoopbackHostHeader,
  listBrowserClients,
  planBrowserMessage,
  planToolCall,
  renderBridgeScript,
  routeHttpRequest,
} from "./src/provider-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_PORT = parseInt(process.env.DETOUR_PORT || "9401", 10);
const BROWSER_HOST = "127.0.0.1";
const BRIDGE_TOKEN = process.env.DETOUR_BRIDGE_TOKEN || randomUUID();

// ── Browser client state ────────────────────────────────────────────────
const clients = new Map();
const consoleLogs = [];
const pendingEvals = new Map();
const pageMessages = [];
const pendingPageAsks = new Map();

function firstClientId() {
  return firstClientIdFrom(clients);
}

function clientLabel(id) {
  return clientLabelFrom(clients, id);
}

function appendBounded(buffer, item) {
  buffer.push(item);
  if (buffer.length > MAX_LOG_BUFFER) buffer.shift();
}

function evalOnClient(clientId, code, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error(`Client ${clientId} not connected`));
    }
    const id = randomUUID().slice(0, 12);
    const timer = setTimeout(() => { pendingEvals.delete(id); reject(new Error(`Eval timed out after ${timeoutMs}ms`)); }, timeoutMs);
    pendingEvals.set(id, { resolve, reject, timer });
    client.ws.send(JSON.stringify({ type: MESSAGE_TYPES.EVAL, id, code }));
  });
}

// ── HTTP server (serves bridge.js + REST API) ───────────────────────────
const distBridge = path.join(__dirname, "dist", "bridge.js");
const srcBridge = path.join(__dirname, "bridge.js");
const bridgeScript = fs.existsSync(distBridge)
  ? fs.readFileSync(distBridge, "utf8")
  : fs.readFileSync(srcBridge, "utf8");
const renderedBridgeScript = renderBridgeScript(bridgeScript, BROWSER_PORT, BRIDGE_TOKEN);

function writeJson(res, statusCode, value, spacing) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value, null, spacing));
}

function readRequestBody(req, onBody) {
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => onBody(body));
}

function rejectUnauthorized(res) {
  writeJson(res, 401, { error: "Unauthorized" });
}

function isSafeHttpRequest(req) {
  return isLoopbackHostHeader(req.headers.host) && isLoopbackAddress(req.socket.remoteAddress);
}

function requireHttpAuth(req, res) {
  if (isSafeHttpRequest(req) && isAuthorizedRequest(req, BRIDGE_TOKEN)) {
    return true;
  }
  rejectUnauthorized(res);
  return false;
}

function handleEvalRequest(req, res) {
  if (!requireHttpAuth(req, res)) return;
  readRequestBody(req, async (body) => {
    try {
      const { code, client_id, timeout_ms } = JSON.parse(body);
      const cid = client_id || firstClientId();
      if (!cid) { res.writeHead(400); res.end(JSON.stringify({ error: "No browser clients connected" })); return; }
      const result = await evalOnClient(cid, code, timeout_ms || 15000);
      writeJson(res, 200, { result });
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
  });
}

function handleReplyRequest(req, res) {
  if (!requireHttpAuth(req, res)) return;
  readRequestBody(req, (body) => {
    try {
      const { ask_id, reply } = JSON.parse(body);
      const pending = pendingPageAsks.get(ask_id);
      if (!pending) { res.writeHead(404); res.end(JSON.stringify({ error: "No pending ask" })); return; }
      if (pending.ws.readyState === WebSocket.OPEN) pending.ws.send(JSON.stringify({ type: MESSAGE_TYPES.ASK_REPLY, id: ask_id, reply }));
      pendingPageAsks.delete(ask_id);
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
  });
}

function handleHttpRequest(req, res) {
  applyCorsHeaders(req, res);
  res.setHeader("Cache-Control", "no-store");

  switch (routeHttpRequest(req.method, req.url)) {
    case "options":
      res.writeHead(204); res.end(); return;
    case "bridge":
      if (!requireHttpAuth(req, res)) return;
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(renderedBridgeScript);
      return;
    case "eval":
      handleEvalRequest(req, res);
      return;
    case "clients":
      if (!requireHttpAuth(req, res)) return;
      writeJson(res, 200, listBrowserClients(clients), 2);
      return;
    case "logs":
      if (!requireHttpAuth(req, res)) return;
      writeJson(res, 200, consoleLogs.slice(-50), 2);
      return;
    case "messages":
      if (!requireHttpAuth(req, res)) return;
      writeJson(res, 200, buildMessagesResponse(pageMessages, req.url));
      return;
    case "reply":
      handleReplyRequest(req, res);
      return;
    default:
      res.writeHead(404); res.end("Not found");
  }
}

const httpServer = http.createServer(handleHttpRequest);

// ── Browser WebSocket server ────────────────────────────────────────────
const browserServer = new WebSocketServer({
  server: httpServer,
  verifyClient: ({ req }, done) => {
    const ok = isSafeHttpRequest(req) && isAuthorizedRequest(req, BRIDGE_TOKEN);
    done(ok, ok ? undefined : 401, ok ? undefined : "Unauthorized");
  },
});
httpServer.listen(BROWSER_PORT, BROWSER_HOST, () => {
  console.log(`🌐 Detour listening on http://${BROWSER_HOST}:${BROWSER_PORT}`);
  console.log(`   Bridge: http://${BROWSER_HOST}:${BROWSER_PORT}/bridge.js?token=${encodeURIComponent(BRIDGE_TOKEN)}`);
  console.log(`   HTTP API: pass ?token=... or ${AUTH_HEADER}: ...`);
});

function applyBrowserMessagePlan(plan, clientId, ws) {
  switch (plan.kind) {
    case "identify": {
      const client = clients.get(clientId);
      client.url = plan.url;
      client.title = plan.title;
      console.log(plan.logText);
      break;
    }
    case "console":
      appendBounded(consoleLogs, plan.entry);
      break;
    case "evalResult": {
      const pending = pendingEvals.get(plan.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingEvals.delete(plan.id);
        plan.error ? pending.reject(new Error(plan.error)) : pending.resolve(plan.value);
      }
      break;
    }
    case "pageMessage":
      console.log(plan.logText);
      appendBounded(pageMessages, plan.pageMessage);
      provider.surface(plan.pushText);
      break;
    case "pageAsk":
      console.log(plan.logText);
      pendingPageAsks.set(plan.askId, { ...plan.pendingAsk, ws });
      appendBounded(pageMessages, plan.pageMessage);
      provider.surface(plan.pushText);
      break;
    case "pageContext":
      console.log(plan.logText);
      appendBounded(pageMessages, plan.pageMessage);
      provider.surface(plan.pushText);
      break;
    case "pageAnnotate":
      console.log(plan.logText);
      break;
  }
}

browserServer.on("connection", (ws) => {
  const clientId = randomUUID().slice(0, 8);
  clients.set(clientId, { ws, url: "unknown", title: "unknown", connectedAt: new Date().toISOString() });
  console.log(`🔗 Browser client connected: ${clientId}`);

  ws.on("message", (raw) => {
    const plan = planBrowserMessage(raw, {
      clientId,
      from: clientLabel(clientId),
      nowIso: () => new Date().toISOString(),
    });
    applyBrowserMessagePlan(plan, clientId, ws);
  });

  ws.on("close", () => { clients.delete(clientId); console.log(`💔 Disconnected: ${clientId}`); });
  ws.on("error", (err) => console.error(`Client ${clientId} error:`, err.message));
});

// ── Tools ───────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "inject_js",
    description: "Execute JavaScript on a browser page connected to Detour. Returns the result.",
    parameters: { type: "object", properties: {
      code: { type: "string", description: "JavaScript to evaluate in page context." },
      client_id: { type: "string", description: "Target client ID. Omit for first connected." },
      timeout_ms: { type: "number", description: "Max wait time in ms (default 15000)." },
    }, required: ["code"] },
  },
  {
    name: "get_console_logs",
    description: "Get captured console logs from connected browser pages.",
    parameters: { type: "object", properties: {
      client_id: { type: "string", description: "Filter by client." },
      level: { type: "string", description: "Filter by level (log/warn/error/info/debug)." },
      limit: { type: "number", description: "Max entries (default 50)." },
      clear: { type: "boolean", description: "Clear buffer after reading." },
    }, required: [] },
  },
  {
    name: "list_browser_clients",
    description: "List connected browser pages with URL, title, and client ID.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_page_messages",
    description: "Get messages sent from browser pages via __detourBridge.send() or .ask().",
    parameters: { type: "object", properties: { limit: { type: "number", description: "Max messages (default 20)." } }, required: [] },
  },
  {
    name: "reply_to_page",
    description: "Reply to a pending browser .ask() question. Resolves the Promise on the page.",
    parameters: { type: "object", properties: {
      ask_id: { type: "string", description: "The askId from the pending question." },
      reply: { type: "string", description: "Reply text." },
    }, required: ["ask_id", "reply"] },
  },
];

// ── Provider (SDK handles auth, reconnect, protocol) ────────────────────
async function handleToolCall(toolName, args) {
  const plan = planToolCall(toolName, args, {
    firstClientId: firstClientId(),
    clients,
    consoleLogs,
    pageMessages,
    pendingPageAsks,
  });

  switch (plan.kind) {
    case "result":
      return plan.value;
    case "eval": {
      const result = await evalOnClient(plan.clientId, plan.code, plan.timeoutMs);
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    }
    case "consoleLogs":
      if (plan.clear) consoleLogs.length = 0;
      return plan.logs;
    case "replyToPage":
      if (plan.pending.ws.readyState === WebSocket.OPEN) plan.pending.ws.send(JSON.stringify(plan.payload));
      pendingPageAsks.delete(plan.askId);
      return plan.result;
    default:
      throw new Error(`Unknown tool: ${plan.toolName}`);
  }
}

const provider = createProvider("detour", {
  tools: TOOLS,

  onToolCall: handleToolCall,

  onConnected: () => console.log(`   Tools: ${TOOLS.map((t) => t.name).join(", ")}`),
  onShutdown: () => console.log("Session ending..."),
});
