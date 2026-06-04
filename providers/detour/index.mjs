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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_PORT = parseInt(process.env.DETOUR_PORT || "9401", 10);
const MAX_LOG_BUFFER = 500;

// ── Browser client state ────────────────────────────────────────────────
const clients = new Map();
const consoleLogs = [];
const pendingEvals = new Map();
const pageMessages = [];
const pendingPageAsks = new Map();

function firstClientId() {
  const first = clients.keys().next();
  return first.done ? null : first.value;
}

function clientLabel(id) {
  const c = clients.get(id);
  return c ? `${c.title} (${c.url})` : id;
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

const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if ((req.url === "/bridge.js" || req.url === "/") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(bridgeScript);
    return;
  }

  if (req.url === "/eval" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      try {
        const { code, client_id, timeout_ms } = JSON.parse(body);
        const cid = client_id || firstClientId();
        if (!cid) { res.writeHead(400); res.end(JSON.stringify({ error: "No browser clients connected" })); return; }
        const result = await evalOnClient(cid, code, timeout_ms || 15000);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result }));
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }

  if (req.url === "/clients" && req.method === "GET") {
    const list = [...clients].map(([id, c]) => ({ id, url: c.url, title: c.title, connectedAt: c.connectedAt }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list, null, 2));
    return;
  }

  if (req.url.startsWith("/logs") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(consoleLogs.slice(-50), null, 2));
    return;
  }

  if (req.url.startsWith("/messages") && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const ack = parseInt(url.searchParams.get("ack") || "0", 10);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ total: pageMessages.length, messages: pageMessages.slice(ack) }));
    return;
  }

  if (req.url === "/reply" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const { ask_id, reply } = JSON.parse(body);
        const pending = pendingPageAsks.get(ask_id);
        if (!pending) { res.writeHead(404); res.end(JSON.stringify({ error: "No pending ask" })); return; }
        if (pending.ws.readyState === WebSocket.OPEN) pending.ws.send(JSON.stringify({ type: MESSAGE_TYPES.ASK_REPLY, id: ask_id, reply }));
        pendingPageAsks.delete(ask_id);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ── Browser WebSocket server ────────────────────────────────────────────
const browserServer = new WebSocketServer({ server: httpServer });
httpServer.listen(BROWSER_PORT, () => {
  console.log(`🌐 Detour listening on http://localhost:${BROWSER_PORT}`);
  console.log(`   Bridge: http://localhost:${BROWSER_PORT}/bridge.js`);
});

browserServer.on("connection", (ws) => {
  const clientId = randomUUID().slice(0, 8);
  clients.set(clientId, { ws, url: "unknown", title: "unknown", connectedAt: new Date().toISOString() });
  console.log(`🔗 Browser client connected: ${clientId}`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case MESSAGE_TYPES.IDENTIFY:
        clients.get(clientId).url = msg.url || "unknown";
        clients.get(clientId).title = msg.title || "unknown";
        console.log(`   → ${msg.title} (${msg.url})`);
        break;

      case MESSAGE_TYPES.CONSOLE:
        consoleLogs.push({ clientId, level: msg.level || "log", args: msg.args || [], timestamp: msg.timestamp || new Date().toISOString() });
        if (consoleLogs.length > MAX_LOG_BUFFER) consoleLogs.shift();
        break;

      case MESSAGE_TYPES.EVAL_RESULT: {
        const p = pendingEvals.get(msg.id);
        if (p) { clearTimeout(p.timer); pendingEvals.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.value); }
        break;
      }

      case MESSAGE_TYPES.PAGE_MESSAGE: {
        const from = clientLabel(clientId);
        console.log(`📨 [${from}] ${msg.message}`);
        pageMessages.push({ clientId, from, message: msg.message, timestamp: new Date().toISOString() });
        if (pageMessages.length > MAX_LOG_BUFFER) pageMessages.shift();
        provider.push(`[${from}] ${msg.message}`);
        break;
      }

      case MESSAGE_TYPES.PAGE_ASK: {
        const from = clientLabel(clientId);
        console.log(`❓ [ASK from ${from}] ${msg.message}`);
        pendingPageAsks.set(msg.id, { clientId, ws, message: msg.message, from, timestamp: new Date().toISOString() });
        pageMessages.push({ clientId, from, message: msg.message, type: "ask", askId: msg.id, timestamp: new Date().toISOString() });
        if (pageMessages.length > MAX_LOG_BUFFER) pageMessages.shift();
        provider.push(`[ASK from ${from}] ${msg.message} (reply with reply_to_page tool, askId: "${msg.id}")`);
        break;
      }

      case MESSAGE_TYPES.PAGE_CONTEXT: {
        const from = clientLabel(clientId);
        const chatMsg = msg.message ? ` — "${msg.message}"` : "";
        console.log(`📋 [CONTEXT from ${from}] ${msg.annotations?.length || 0} annotations${chatMsg}`);
        const text = msg.markdown || `${msg.annotations?.length || 0} annotations from ${from}${chatMsg}`;
        pageMessages.push({ clientId, from, message: text, type: "context", timestamp: new Date().toISOString() });
        if (pageMessages.length > MAX_LOG_BUFFER) pageMessages.shift();
        provider.push(`[CONTEXT from ${from}]${chatMsg}\n${msg.markdown || ""}`);
        break;
      }

      case MESSAGE_TYPES.PAGE_ANNOTATE: {
        const from = clientLabel(clientId);
        const ann = msg.annotation || {};
        console.log(`📌 [${from}] ${ann.context?.displayName || "element"}: ${ann.intent} — ${ann.comment || "(no comment)"}`);
        break;
      }
    }
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
const provider = createProvider("detour", {
  tools: TOOLS,

  async onToolCall(toolName, args) {
    switch (toolName) {
      case "inject_js": {
        const cid = args.client_id || firstClientId();
        if (!cid) return { error: "No browser clients connected." };
        const result = await evalOnClient(cid, args.code, args.timeout_ms || 15000);
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      }
      case "get_console_logs": {
        let logs = [...consoleLogs];
        if (args.client_id) logs = logs.filter((l) => l.clientId === args.client_id);
        if (args.level) logs = logs.filter((l) => l.level === args.level);
        logs = logs.slice(-(Math.min(args.limit || 50, MAX_LOG_BUFFER)));
        if (args.clear) consoleLogs.length = 0;
        return logs;
      }
      case "list_browser_clients":
        return [...clients].map(([id, c]) => ({ id, url: c.url, title: c.title, connectedAt: c.connectedAt }));
      case "get_page_messages":
        return pageMessages.slice(-(args.limit || 20));
      case "reply_to_page": {
        const pending = pendingPageAsks.get(args.ask_id);
        if (!pending) return { error: "No pending ask with that ID" };
        if (pending.ws.readyState === WebSocket.OPEN) pending.ws.send(JSON.stringify({ type: MESSAGE_TYPES.ASK_REPLY, id: args.ask_id, reply: args.reply }));
        pendingPageAsks.delete(args.ask_id);
        return { ok: true, repliedTo: pending.from };
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  },

  onConnected: () => console.log(`   Tools: ${TOOLS.map((t) => t.name).join(", ")}`),
  onShutdown: () => console.log("Session ending..."),
});
