import { MESSAGE_TYPES } from "./contracts.js";

/**
 * Detour ↔ Agent Bridge (v2)
 *
 * Injected by the Detour Chrome extension via "Inject on load" rules.
 * Single bundled file that includes:
 *   - WebSocket connection to provider
 *   - Console log capture
 *   - Remote JS eval from agent
 *   - Context panel (element picker, annotations, chat, detail chooser)
 *   - React component extraction (best-effort via bippy)
 */

var _createPanel = null;
try {
  var panelModule = require("./panel.js");
  _createPanel = panelModule.createPanel;
} catch (e) {
  // Panel module failed to load — core bridge still works
  if (typeof console !== "undefined") console.warn("[Detour] Panel module failed to load:", e.message);
}

(function () {
  "use strict";
  if (window.__detourBridge) return;

  var WS_URL = "ws://localhost:9401";
  var RECONNECT_MS = 3000;
  var ws = null;

  var bridgeAPI = {
    connected: false,
    send: null,
    ask: null,
    sendMessage: sendMessage,
  };
  window.__detourBridge = bridgeAPI;

  // ── Console intercept ─────────────────────────────────────────────────
  var orig = {};
  ["log", "warn", "error", "info", "debug"].forEach(function (level) {
    orig[level] = console[level].bind(console);
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      orig[level].apply(console, args);
      sendConsole(level, args);
    };
  });

  window.addEventListener("error", function (e) {
    sendConsole("error", ["Uncaught: " + e.message + " at " + e.filename + ":" + e.lineno + ":" + e.colno]);
  });

  window.addEventListener("unhandledrejection", function (e) {
    sendConsole("error", ["Unhandled rejection: " + e.reason]);
  });

  function sendConsole(level, args) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    var serialized = args.map(function (a) {
      try {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.name + ": " + a.message;
        if (a instanceof HTMLElement) return a.outerHTML.slice(0, 200);
        return JSON.stringify(a);
      } catch (e) { return String(a); }
    });
    try {
      ws.send(JSON.stringify({
        type: MESSAGE_TYPES.CONSOLE,
        level: level,
        args: serialized,
        timestamp: new Date().toISOString(),
      }));
    } catch (e) { /* ignore */ }
  }

  // ── Serializer ────────────────────────────────────────────────────────
  function serialize(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (value instanceof HTMLElement) return value.outerHTML.slice(0, 5000);
    if (typeof value === "object") {
      try { return JSON.stringify(value, null, 2); }
      catch (e) { return String(value); }
    }
    return String(value);
  }

  // ── Eval handler ──────────────────────────────────────────────────────
  function handleEval(msg) {
    var result = { type: MESSAGE_TYPES.EVAL_RESULT, id: msg.id };
    try {
      var value = (0, eval)(msg.code);
      if (value && typeof value.then === "function") {
        value.then(
          function (resolved) { result.value = serialize(resolved); ws.send(JSON.stringify(result)); },
          function (rejected) { result.error = String(rejected); ws.send(JSON.stringify(result)); }
        );
      } else {
        result.value = serialize(value);
        ws.send(JSON.stringify(result));
      }
    } catch (err) {
      result.error = err.name + ": " + err.message;
      ws.send(JSON.stringify(result));
    }
  }

  // ── Messaging ─────────────────────────────────────────────────────────
  function sendMessage(type, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      orig.warn("[Detour] Not connected — message not sent");
      return false;
    }
    try {
      var payload = JSON.stringify({ type: type, ...data });
      ws.send(payload);
      orig.log("[Detour] Sent:", type, "(" + payload.length + " bytes)");
      return true;
    } catch (e) {
      orig.error("[Detour] Send failed:", e.message);
      return false;
    }
  }

  var pendingAsks = {};
  var askIdCounter = 0;

  bridgeAPI.send = function (message) {
    sendMessage(MESSAGE_TYPES.PAGE_MESSAGE, { message });
  };

  bridgeAPI.ask = function (message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("Detour bridge not connected"));
      }
      var id = "ask-" + (++askIdCounter);
      var timer = setTimeout(function () {
        delete pendingAsks[id];
        reject(new Error("Ask timed out"));
      }, timeoutMs || 30000);
      pendingAsks[id] = { resolve, reject, timer };
      ws.send(JSON.stringify({ type: MESSAGE_TYPES.PAGE_ASK, id, message }));
    });
  };

  // ── Status badge ──────────────────────────────────────────────────────
  // Minimal badge shown before panel loads, replaced by FAB once panel mounts
  var badge = document.createElement("div");
  badge.id = "__detour-badge";
  badge.setAttribute("style",
    "position:fixed;bottom:12px;right:12px;z-index:2147483646;" +
    "padding:6px 12px;border-radius:20px;font:600 12px/1 system-ui,sans-serif;" +
    "color:#fff;background:#d44;opacity:0.92;pointer-events:none;" +
    "transition:background .3s,opacity .3s;box-shadow:0 2px 8px rgba(0,0,0,.3);"
  );
  badge.textContent = "⚡ connecting…";

  function showBadge() {
    if (!badge.parentNode) (document.body || document.documentElement).appendChild(badge);
  }
  function hideBadge() {
    if (badge.parentNode) badge.parentNode.removeChild(badge);
  }
  function setBadgeState(state) {
    if (state === "connected") {
      badge.textContent = "⚡ Detour: connected";
      badge.style.background = "#1a8c3a";
      badge.style.opacity = "0.92";
      clearTimeout(badge._t);
      badge._t = setTimeout(function () { badge.style.opacity = "0"; }, 3000);
    } else if (state === "disconnected") {
      badge.textContent = "⚡ Detour: disconnected";
      badge.style.background = "#d44";
      badge.style.opacity = "0.92";
      clearTimeout(badge._t);
    } else {
      badge.textContent = "⚡ connecting…";
      badge.style.background = "#c90";
      badge.style.opacity = "0.92";
      clearTimeout(badge._t);
    }
  }

  // ── Context panel ─────────────────────────────────────────────────────
  var panel = null;
  function initPanel() {
    if (panel || !_createPanel) return;
    try {
      panel = _createPanel(bridgeAPI);
      panel.mount();
      hideBadge();
    } catch (e) {
      orig.warn("[Detour] Panel init failed:", e.message);
    }
  }

  // ── WebSocket connection ──────────────────────────────────────────────
  function connect() {
    setBadgeState("connecting");
    showBadge();
    try { ws = new WebSocket(WS_URL); } catch (e) {
      setBadgeState("disconnected");
      setTimeout(connect, RECONNECT_MS);
      return;
    }

    ws.onopen = function () {
      bridgeAPI.connected = true;
      setBadgeState("connected");
      orig.log("%c⚡ Detour bridge connected", "color:#0f0;font-weight:bold;font-size:13px");
      orig.log("%c  Panel: click ⚡ FAB (bottom-right)", "color:#aaa");
      ws.send(JSON.stringify({
        type: MESSAGE_TYPES.IDENTIFY,
        url: location.href,
        title: document.title || location.hostname,
      }));
      // Init panel once connected
      setTimeout(initPanel, 100);
    };

    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }

      if (msg.type === MESSAGE_TYPES.EVAL) handleEval(msg);
      if (msg.type === MESSAGE_TYPES.ASK_REPLY) {
        var pending = pendingAsks[msg.id];
        if (pending) {
          clearTimeout(pending.timer);
          delete pendingAsks[msg.id];
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.reply);
        }
      }
      if (msg.type === MESSAGE_TYPES.AGENT_REPLY && panel) {
        panel.showAgentReply(msg.message);
      }
    };

    ws.onclose = function () {
      bridgeAPI.connected = false;
      setBadgeState("disconnected");
      showBadge();
      orig.log("%c⚡ Detour bridge disconnected, reconnecting...", "color:#f80");
      setTimeout(connect, RECONNECT_MS);
    };

    ws.onerror = function () { /* onclose fires */ };
  }

  connect();
})();
