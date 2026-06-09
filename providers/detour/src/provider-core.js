import { MESSAGE_TYPES } from "./contracts.js";

export const MAX_LOG_BUFFER = 500;
export const BRIDGE_TOKEN_PLACEHOLDER = "__DET0UR_WS_URL__";
export const AUTH_HEADER = "x-detour-token";
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function firstClientIdFrom(clients) {
  const first = clients.keys().next();
  return first.done ? null : first.value;
}

export function clientLabelFrom(clients, id) {
  const client = clients.get(id);
  return client ? `${client.title} (${client.url})` : id;
}

export function listBrowserClients(clients) {
  return [...clients].map(([id, client]) => ({
    id,
    url: client.url,
    title: client.title,
    connectedAt: client.connectedAt,
  }));
}

export function selectConsoleLogs(consoleLogs, args = {}, max = MAX_LOG_BUFFER) {
  let logs = [...consoleLogs];
  if (args.client_id) logs = logs.filter((log) => log.clientId === args.client_id);
  if (args.level) logs = logs.filter((log) => log.level === args.level);
  return logs.slice(-(Math.min(args.limit || 50, max)));
}

export function selectPageMessages(pageMessages, args = {}) {
  return pageMessages.slice(-(args.limit || 20));
}

export function buildMessagesResponse(pageMessages, requestUrl) {
  const url = new URL(requestUrl, "http://localhost");
  const ack = parseInt(url.searchParams.get("ack") || "0", 10);
  return {
    total: pageMessages.length,
    messages: pageMessages.slice(ack),
  };
}

export function routeHttpRequest(method, requestUrl) {
  const { pathname } = new URL(requestUrl || "/", "http://localhost");
  if (method === "OPTIONS") return "options";
  if ((pathname === "/bridge.js" || pathname === "/") && method === "GET") return "bridge";
  if (pathname === "/eval" && method === "POST") return "eval";
  if (pathname === "/clients" && method === "GET") return "clients";
  if (pathname === "/logs" && method === "GET") return "logs";
  if (pathname === "/messages" && method === "GET") return "messages";
  if (pathname === "/reply" && method === "POST") return "reply";
  return "notFound";
}

export function renderBridgeScript(template, browserPort, token) {
  const wsUrl = `ws://127.0.0.1:${browserPort}?token=${encodeURIComponent(token)}`;
  return template.replaceAll(BRIDGE_TOKEN_PLACEHOLDER, wsUrl);
}

export function getRequestToken(req) {
  const url = new URL(req.url || "/", "http://localhost");
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken;

  const headerToken = req.headers?.[AUTH_HEADER];
  if (Array.isArray(headerToken)) return headerToken[0] || "";
  if (typeof headerToken === "string") return headerToken;

  const authorization = req.headers?.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = typeof value === "string" ? /^Bearer\s+(.+)$/i.exec(value) : null;
  return match ? match[1] : "";
}

export function isAuthorizedRequest(req, expectedToken) {
  return Boolean(expectedToken) && getRequestToken(req) === expectedToken;
}

export function isLoopbackHostHeader(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader) return false;
  const lowerHost = hostHeader.toLowerCase();
  if (lowerHost === "[::1]" || lowerHost.startsWith("[::1]:")) return true;
  const host = lowerHost.split(":")[0];
  return LOOPBACK_HOSTS.has(host);
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isAllowedCorsOrigin(origin) {
  return typeof origin === "string" && origin.startsWith("chrome-extension://");
}

export function applyCorsHeaders(req, res) {
  const origin = req.headers?.origin;
  if (!isAllowedCorsOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, Authorization, ${AUTH_HEADER}`);
  res.setHeader("Vary", "Origin");
}

export function planBrowserMessage(raw, { clientId, from, nowIso }) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }

  switch (msg.type) {
    case MESSAGE_TYPES.IDENTIFY:
      return {
        kind: "identify",
        url: msg.url || "unknown",
        title: msg.title || "unknown",
        logText: `   → ${msg.title} (${msg.url})`,
      };

    case MESSAGE_TYPES.CONSOLE:
      return {
        kind: "console",
        entry: {
          clientId,
          level: msg.level || "log",
          args: msg.args || [],
          timestamp: msg.timestamp || nowIso(),
        },
      };

    case MESSAGE_TYPES.EVAL_RESULT:
      return {
        kind: "evalResult",
        id: msg.id,
        error: msg.error,
        value: msg.value,
      };

    case MESSAGE_TYPES.PAGE_MESSAGE:
      return {
        kind: "pageMessage",
        logText: `📨 [${from}] ${msg.message}`,
        pageMessage: { clientId, from, message: msg.message, timestamp: nowIso() },
        pushText: `[${from}] ${msg.message}`,
      };

    case MESSAGE_TYPES.PAGE_ASK:
      return {
        kind: "pageAsk",
        askId: msg.id,
        logText: `❓ [ASK from ${from}] ${msg.message}`,
        pendingAsk: { clientId, message: msg.message, from, timestamp: nowIso() },
        pageMessage: { clientId, from, message: msg.message, type: "ask", askId: msg.id, timestamp: nowIso() },
        pushText: `[ASK from ${from}] ${msg.message} (reply with reply_to_page tool, askId: "${msg.id}")`,
      };

    case MESSAGE_TYPES.PAGE_CONTEXT: {
      const chatMsg = msg.message ? ` — "${msg.message}"` : "";
      const annotationCount = msg.annotations?.length || 0;
      return {
        kind: "pageContext",
        logText: `📋 [CONTEXT from ${from}] ${annotationCount} annotations${chatMsg}`,
        pageMessage: {
          clientId,
          from,
          message: msg.markdown || `${annotationCount} annotations from ${from}${chatMsg}`,
          type: "context",
          timestamp: nowIso(),
        },
        pushText: `[CONTEXT from ${from}]${chatMsg}\n${msg.markdown || ""}`,
      };
    }

    case MESSAGE_TYPES.PAGE_ANNOTATE: {
      const ann = msg.annotation || {};
      return {
        kind: "pageAnnotate",
        logText: `📌 [${from}] ${ann.context?.displayName || "element"}: ${ann.intent} — ${ann.comment || "(no comment)"}`,
      };
    }

    default:
      return { kind: "ignore" };
  }
}

export function planToolCall(toolName, args = {}, state) {
  switch (toolName) {
    case "inject_js": {
      const clientId = args.client_id || state.firstClientId;
      if (!clientId) return { kind: "result", value: { error: "No browser clients connected." } };
      return {
        kind: "eval",
        clientId,
        code: args.code,
        timeoutMs: args.timeout_ms || 15000,
      };
    }

    case "get_console_logs":
      return {
        kind: "consoleLogs",
        logs: selectConsoleLogs(state.consoleLogs, args),
        clear: args.clear,
      };

    case "list_browser_clients":
      return { kind: "result", value: listBrowserClients(state.clients) };

    case "get_page_messages":
      return { kind: "result", value: selectPageMessages(state.pageMessages, args) };

    case "reply_to_page": {
      const pending = state.pendingPageAsks.get(args.ask_id);
      if (!pending) return { kind: "result", value: { error: "No pending ask with that ID" } };
      return {
        kind: "replyToPage",
        askId: args.ask_id,
        pending,
        payload: { type: MESSAGE_TYPES.ASK_REPLY, id: args.ask_id, reply: args.reply },
        result: { ok: true, repliedTo: pending.from },
      };
    }

    default:
      return { kind: "unknown", toolName };
  }
}
