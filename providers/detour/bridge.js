/**
 * Detour ↔ Agent Bridge
 *
 * Injected by the Detour Chrome extension via "Inject on load" rules.
 * Connects to the Detour provider over WebSocket and enables:
 *   - Remote JS execution from the Copilot agent
 *   - Console log capture (log, warn, error, info, debug)
 *   - Uncaught error + unhandled rejection capture
 *   - Floating status badge showing connection state
 */
(function () {
  "use strict";
  if (window.__detourBridge) return;

  var WS_URL = "__DET0UR_WS_URL__";
  var RECONNECT_MS = 3000;
  var ws = null;

  window.__detourBridge = { connected: false };

  // ── Status badge ──────────────────────────────────────────────────────
  var badge = document.createElement("div");
  badge.id = "__detour-badge";
  badge.setAttribute("style", [
    "position:fixed", "bottom:12px", "right:12px", "z-index:2147483647",
    "padding:6px 12px", "border-radius:20px",
    "font:600 12px/1 -apple-system,system-ui,sans-serif",
    "color:#fff", "background:#d44", "opacity:0.92",
    "pointer-events:none", "transition:background .3s,opacity .3s",
    "box-shadow:0 2px 8px rgba(0,0,0,.3)",
  ].join(";"));
  badge.textContent = "⚡ Detour: connecting…";

  function showBadge() {
    if (!badge.parentNode) {
      (document.body || document.documentElement).appendChild(badge);
    }
  }

  function setBadgeState(state) {
    if (state === "connected") {
      badge.textContent = "⚡ Detour: connected";
      badge.style.background = "#1a8c3a";
      // Fade out after 3s
      clearTimeout(badge._hideTimer);
      badge.style.opacity = "0.92";
      badge._hideTimer = setTimeout(function () { badge.style.opacity = "0"; }, 3000);
    } else if (state === "disconnected") {
      badge.textContent = "⚡ Detour: disconnected";
      badge.style.background = "#d44";
      badge.style.opacity = "0.92";
      clearTimeout(badge._hideTimer);
    } else {
      badge.textContent = "⚡ Detour: connecting…";
      badge.style.background = "#c90";
      badge.style.opacity = "0.92";
      clearTimeout(badge._hideTimer);
    }
  }

  // Show badge once DOM is ready
  if (document.body) showBadge();
  else document.addEventListener("DOMContentLoaded", showBadge);

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
        type: "console",
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

  // ── Eval handler (supports async/Promise results) ─────────────────────
  function handleEval(msg) {
    var result = { type: "eval.result", id: msg.id };
    try {
      var value = (0, eval)(msg.code);
      if (value && typeof value.then === "function") {
        value.then(
          function (resolved) {
            result.value = serialize(resolved);
            ws.send(JSON.stringify(result));
          },
          function (rejected) {
            result.error = String(rejected);
            ws.send(JSON.stringify(result));
          }
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

  // ── Pending asks (browser→agent with response) ────────────────────────
  var pendingAsks = {};
  var askIdCounter = 0;

  // Fire-and-forget message to agent
  window.__detourBridge.send = function (message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      orig.warn("[Detour] Not connected — message not sent");
      return;
    }
    ws.send(JSON.stringify({ type: "page.message", message: message }));
  };

  // Ask agent a question, returns a Promise that resolves with the response
  window.__detourBridge.ask = function (message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("Detour bridge not connected"));
      }
      var id = "ask-" + (++askIdCounter);
      var timer = setTimeout(function () {
        delete pendingAsks[id];
        reject(new Error("Ask timed out after " + (timeoutMs || 30000) + "ms"));
      }, timeoutMs || 30000);
      pendingAsks[id] = { resolve: resolve, reject: reject, timer: timer };
      ws.send(JSON.stringify({ type: "page.ask", id: id, message: message }));
    });
  };

  // ── WebSocket connection ──────────────────────────────────────────────
  function connect() {
    setBadgeState("connecting");
    try { ws = new WebSocket(WS_URL); } catch (e) {
      setBadgeState("disconnected");
      setTimeout(connect, RECONNECT_MS);
      return;
    }

    ws.onopen = function () {
      window.__detourBridge.connected = true;
      setBadgeState("connected");
      orig.log("%c⚡ Detour bridge connected", "color:#0f0;font-weight:bold;font-size:13px");
      orig.log("%c  window.__detourBridge.send('msg')  — send to agent", "color:#aaa");
      orig.log("%c  window.__detourBridge.ask('msg')   — ask agent (returns Promise)", "color:#aaa");
      ws.send(JSON.stringify({
        type: "identify",
        url: location.href,
        title: document.title || location.hostname,
      }));
    };

    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === "eval") handleEval(msg);
      if (msg.type === "ask.reply") {
        var pending = pendingAsks[msg.id];
        if (pending) {
          clearTimeout(pending.timer);
          delete pendingAsks[msg.id];
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.reply);
        }
      }
    };

    ws.onclose = function () {
      window.__detourBridge.connected = false;
      setBadgeState("disconnected");
      orig.log("%c⚡ Detour bridge disconnected, reconnecting...", "color:#f80");
      setTimeout(connect, RECONNECT_MS);
    };

    ws.onerror = function () { /* onclose will fire */ };
  }

  connect();
})();
