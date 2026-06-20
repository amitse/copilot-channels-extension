import { createServer } from "node:http";
import { createCanvas } from "@github/copilot-sdk/extension";

import { TAP_DIAGNOSTICS_CANVAS_ID } from "./consts.mjs";
const DEFAULT_REFRESH_MS = 1200;

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function textResponse(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sanitizeSnapshotOptions(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const limit = Number(source.limit);
  return {
    streamEntryLimit: Number.isFinite(limit) ? Math.max(10, Math.min(200, Math.floor(limit))) : 80,
    logLimit: Number.isFinite(limit) ? Math.max(20, Math.min(300, Math.floor(limit))) : 160,
    sessionEventLimit: Number.isFinite(limit) ? Math.max(20, Math.min(300, Math.floor(limit))) : 160,
    runtimeEventLimit: Number.isFinite(limit) ? Math.max(20, Math.min(300, Math.floor(limit))) : 160
  };
}

function summarizeSnapshot(snapshot) {
  const runningEmitters = Array.isArray(snapshot?.emitters?.running) ? snapshot.emitters.running.length : 0;
  const configuredEmitters = Array.isArray(snapshot?.emitters?.configured) ? snapshot.emitters.configured.length : 0;
  const streams = Array.isArray(snapshot?.streams) ? snapshot.streams.length : 0;
  const providers = Array.isArray(snapshot?.gateway?.providers) ? snapshot.gateway.providers.length : 0;
  const logs = snapshot?.diagnostics?.stats?.logs?.retained ?? 0;
  const sessionEvents = snapshot?.diagnostics?.stats?.sessionEvents?.retained ?? 0;

  return { streams, runningEmitters, configuredEmitters, providers, logs, sessionEvents };
}

function createHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>tap diagnostics</title>
  <style>
    :root {
      color-scheme: light;
      --paper: oklch(96% 0.018 86);
      --paper-2: oklch(91% 0.025 82);
      --ink: oklch(18% 0.026 70);
      --muted: oklch(43% 0.04 73);
      --line: oklch(72% 0.052 76);
      --amber: oklch(70% 0.15 72);
      --amber-dark: oklch(42% 0.12 67);
      --red: oklch(55% 0.18 30);
      --green: oklch(55% 0.13 145);
      --blue: oklch(48% 0.1 245);
      --surface: oklch(99% 0.012 88);
      --shadow: 0 24px 80px oklch(28% 0.04 70 / 0.14);
      --font-display: "Bahnschrift", "Aptos Display", "Segoe UI Variable Display", sans-serif;
      --font-body: "Aptos", "Segoe UI Variable Text", sans-serif;
      --font-mono: "Cascadia Code", "Consolas", monospace;
    }

    * { box-sizing: border-box; }
    html { min-height: 100%; background: var(--paper); color: var(--ink); }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font-body);
      background:
        linear-gradient(90deg, oklch(34% 0.08 68 / 0.08) 1px, transparent 1px) 0 0 / 42px 42px,
        linear-gradient(0deg, oklch(34% 0.08 68 / 0.055) 1px, transparent 1px) 0 0 / 42px 42px,
        radial-gradient(circle at 8% 12%, oklch(76% 0.13 74 / 0.35), transparent 28rem),
        var(--paper);
    }

    button, input { font: inherit; }
    button:focus-visible, input:focus-visible {
      outline: 3px solid var(--amber-dark);
      outline-offset: 3px;
    }

    .shell {
      width: min(1540px, calc(100vw - clamp(18px, 4vw, 64px)));
      margin: 0 auto;
      padding: clamp(22px, 4vw, 54px) 0;
    }

    .masthead {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 22px;
      align-items: end;
      border-bottom: 3px solid var(--ink);
      padding-bottom: clamp(18px, 3vw, 34px);
    }

    .mark {
      width: 72px;
      aspect-ratio: 1;
      display: grid;
      place-items: center;
      border: 3px solid var(--ink);
      background: var(--amber);
      box-shadow: 8px 8px 0 var(--ink);
      font-family: var(--font-display);
      font-size: 44px;
      line-height: 1;
    }

    .title-wrap {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: clamp(16px, 3vw, 28px);
      align-items: center;
    }

    h1 {
      margin: 0;
      font-family: var(--font-display);
      font-size: clamp(2.4rem, 7vw, 6.8rem);
      line-height: 0.82;
      letter-spacing: -0.08em;
      text-transform: uppercase;
      max-width: 11ch;
    }

    .dek {
      margin: 12px 0 0;
      max-width: 78ch;
      color: var(--muted);
      font-size: clamp(0.98rem, 1.8vw, 1.18rem);
      line-height: 1.45;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
    }

    .filter-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .chip, .button {
      border: 2px solid var(--ink);
      background: var(--surface);
      color: var(--ink);
      min-height: 40px;
      padding: 8px 13px;
      box-shadow: 3px 3px 0 var(--ink);
      cursor: pointer;
      transition: transform 140ms ease, box-shadow 140ms ease, background 140ms ease;
    }

    .chip[aria-pressed="true"], .button.primary {
      background: var(--ink);
      color: var(--paper);
    }

    @media (hover: hover) {
      .chip:hover, .button:hover { transform: translate(-1px, -1px); box-shadow: 5px 5px 0 var(--ink); }
    }

    .search {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: min(100%, 380px);
      border: 2px solid var(--ink);
      background: var(--surface);
      box-shadow: 3px 3px 0 var(--ink);
      padding: 8px 12px;
    }

    .search input {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--ink);
      outline: 0;
    }

    .dashboard {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: clamp(18px, 3vw, 34px);
      margin-top: clamp(22px, 4vw, 48px);
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .metric {
      min-height: 118px;
      border: 2px solid var(--ink);
      background: var(--surface);
      box-shadow: var(--shadow);
      padding: 16px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .metric b {
      font-family: var(--font-display);
      font-size: clamp(2rem, 5vw, 4.2rem);
      line-height: 0.9;
      letter-spacing: -0.05em;
    }

    .metric span {
      color: var(--muted);
      text-transform: uppercase;
      font-size: 0.72rem;
      letter-spacing: 0.14em;
      font-weight: 800;
    }

    .panel {
      border: 2px solid var(--ink);
      background: oklch(98% 0.014 88 / 0.96);
      box-shadow: 8px 8px 0 oklch(18% 0.026 70 / 0.22);
      min-width: 0;
    }

    .panel-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 2px solid var(--ink);
      background: var(--paper-2);
    }

    .panel-head h2 {
      margin: 0;
      font-family: var(--font-display);
      font-size: clamp(1.2rem, 2vw, 1.7rem);
      letter-spacing: -0.03em;
      text-transform: uppercase;
    }

    .panel-head small {
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: 0.75rem;
    }

    .panel-body {
      padding: 14px;
      max-height: min(62vh, 720px);
      overflow: auto;
    }

    .stream-grid, .emitter-grid, .provider-grid {
      display: grid;
      gap: 12px;
    }

    .record {
      border-left: 4px solid var(--line);
      background: color-mix(in oklch, var(--surface), var(--paper) 24%);
      padding: 11px 12px;
    }

    .record strong {
      display: inline-flex;
      gap: 8px;
      align-items: baseline;
      font-family: var(--font-display);
      letter-spacing: -0.01em;
    }

    .meta {
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: 0.72rem;
      overflow-wrap: anywhere;
    }

    .entry {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed var(--line);
      font-family: var(--font-mono);
      font-size: 0.78rem;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .timeline {
      display: grid;
      gap: 9px;
    }

    .tick {
      display: grid;
      grid-template-columns: 90px minmax(0, 1fr);
      gap: 12px;
      border-bottom: 1px dashed var(--line);
      padding: 9px 0;
    }

    .tick time {
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: 0.72rem;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 7px;
      border: 1px solid var(--ink);
      background: var(--paper);
      font-family: var(--font-mono);
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .badge.error { background: color-mix(in oklch, var(--red), var(--paper) 72%); }
    .badge.warning { background: color-mix(in oklch, var(--amber), var(--paper) 54%); }
    .badge.ready, .badge.running, .badge.success { background: color-mix(in oklch, var(--green), var(--paper) 70%); }
    .badge.info, .badge.debug { background: color-mix(in oklch, var(--blue), var(--paper) 76%); }

    .details {
      margin-top: 6px;
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: 0.78rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .empty {
      border: 2px dashed var(--line);
      padding: 18px;
      color: var(--muted);
      background: color-mix(in oklch, var(--surface), var(--paper) 45%);
    }

    .footer {
      margin-top: 24px;
      color: var(--muted);
      font-size: 0.86rem;
    }

    @media (min-width: 780px) {
      .masthead { grid-template-columns: minmax(0, 1fr) auto; }
      .dashboard { grid-template-columns: minmax(280px, 0.62fr) minmax(0, 1fr); align-items: start; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .timeline-panel { grid-column: 1 / -1; }
    }

    @media (min-width: 1180px) {
      .dashboard { grid-template-columns: 360px minmax(0, 1fr) 420px; }
      .timeline-panel { grid-column: auto; }
      .metrics { grid-template-columns: 1fr; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="masthead">
      <div class="title-wrap">
        <div class="mark" aria-hidden="true">※</div>
        <div>
          <h1>Tap flight recorder</h1>
          <p class="dek">A live canvas for streams, emitters, provider gateway state, injection queues, session events, and tap diagnostics. Bounded, redacted, and built for incident-speed inspection.</p>
        </div>
      </div>
      <div class="controls" aria-label="Diagnostics controls">
        <div class="filter-row" role="group" aria-label="Timeline filter">
          <button class="chip" data-filter="all" aria-pressed="true">All</button>
          <button class="chip" data-filter="streams" aria-pressed="false">Streams</button>
          <button class="chip" data-filter="logs" aria-pressed="false">Logs</button>
          <button class="chip" data-filter="session" aria-pressed="false">Session</button>
          <button class="chip" data-filter="runtime" aria-pressed="false">Runtime</button>
        </div>
        <label class="search">
          <span aria-hidden="true">⌕</span>
          <input id="search" type="search" placeholder="Filter evidence..." autocomplete="off" />
        </label>
        <button id="pause" class="button" type="button">Pause</button>
        <button id="refresh" class="button primary" type="button">Refresh</button>
      </div>
    </header>

    <section class="dashboard" aria-live="polite">
      <aside>
        <div class="metrics" id="metrics"></div>
        <p class="footer" id="heartbeat">Waiting for first snapshot...</p>
      </aside>

      <section class="panel">
        <div class="panel-head">
          <h2>Streams and emitters</h2>
          <small id="stream-count">0 streams</small>
        </div>
        <div class="panel-body">
          <div class="stream-grid" id="streams"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Providers</h2>
          <small id="provider-count">0 providers</small>
        </div>
        <div class="panel-body">
          <div class="provider-grid" id="providers"></div>
        </div>
      </section>

      <section class="panel timeline-panel">
        <div class="panel-head">
          <h2>Evidence timeline</h2>
          <small id="timeline-count">0 events</small>
        </div>
        <div class="panel-body">
          <div class="timeline" id="timeline"></div>
        </div>
      </section>
    </section>
  </main>

  <script>
    const state = { snapshot: null, paused: false, filter: "all", query: "" };
    const el = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const timeOnly = (value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour12: false });
    };
    const compactJson = (value) => {
      if (value === null || value === undefined) return "";
      if (typeof value === "string") return value;
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    };

    function metric(label, value, tone = "") {
      return '<article class="metric ' + tone + '"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></article>';
    }

    function renderMetrics(snapshot) {
      const running = snapshot.emitters?.running?.length ?? 0;
      const configured = snapshot.emitters?.configured?.length ?? 0;
      const streams = snapshot.streams?.length ?? 0;
      const providers = snapshot.gateway?.providers?.length ?? 0;
      const queue = snapshot.notifications?.queueSize ?? 0;
      const sessionEvents = snapshot.diagnostics?.stats?.sessionEvents?.retained ?? 0;
      el("metrics").innerHTML = [
        metric("streams", streams),
        metric("running emitters", running),
        metric("providers", providers),
        metric("queued injections", queue),
        metric("configured emitters", configured),
        metric("session events", sessionEvents)
      ].join("");
      el("heartbeat").textContent = "Snapshot " + timeOnly(snapshot.generatedAt) + " | pid " + (snapshot.process?.pid ?? "?") + " | gateway " + (snapshot.gateway?.running ? "ready" : "stopped");
    }

    function renderStreams(snapshot) {
      const streams = snapshot.streams ?? [];
      el("stream-count").textContent = streams.length + " streams";
      if (streams.length === 0) {
        el("streams").innerHTML = '<div class="empty">No streams are currently retained.</div>';
        return;
      }
      const emitterRows = [...(snapshot.emitters?.running ?? []), ...(snapshot.emitters?.configured ?? [])]
        .map((emitter) => '<div class="record"><strong>' + escapeHtml(emitter.name) + ' <span class="badge ' + escapeHtml(emitter.status) + '">' + escapeHtml(emitter.status) + '</span></strong><div class="meta">' + escapeHtml(emitter.emitterType) + ' | ' + escapeHtml(emitter.runSchedule) + ' | stream=' + escapeHtml(emitter.stream) + '</div><div class="meta">lines=' + escapeHtml(emitter.lineCount ?? 0) + ' dropped=' + escapeHtml(emitter.droppedLineCount ?? 0) + '</div></div>')
        .join("");
      const streamRows = streams.map((stream) => {
        const latest = (stream.entries ?? []).slice(-3).reverse().map((entry) => '<div class="entry"><span class="meta">' + escapeHtml(timeOnly(entry.timestamp)) + ' ' + escapeHtml(entry.source) + (entry.monitorName ? ' / ' + escapeHtml(entry.monitorName) : '') + '</span>\\n' + escapeHtml(entry.text) + '</div>').join("");
        return '<div class="record"><strong>' + escapeHtml(stream.name) + ' <span class="badge ' + (stream.sessionInjector?.enabled ? 'ready' : 'info') + '">' + (stream.sessionInjector?.enabled ? 'injector on' : 'kept') + '</span></strong><div class="meta">' + escapeHtml(stream.entries?.length ?? 0) + ' retained entries | delivery=' + escapeHtml(stream.sessionInjector?.delivery ?? 'surface') + '</div>' + (latest || '<div class="entry">No entries retained for this stream.</div>') + '</div>';
      }).join("");
      el("streams").innerHTML = streamRows + (emitterRows ? '<div class="panel-head" style="margin:14px -14px 12px"><h2>Emitter roll call</h2><small>' + ((snapshot.emitters?.running?.length ?? 0) + (snapshot.emitters?.configured?.length ?? 0)) + ' emitters</small></div><div class="emitter-grid">' + emitterRows + '</div>' : "");
    }

    function renderProviders(snapshot) {
      const gateway = snapshot.gateway ?? {};
      const providers = gateway.providers ?? [];
      el("provider-count").textContent = providers.length + " providers";
      const gatewayRecord = '<div class="record"><strong>gateway <span class="badge ' + (gateway.running ? 'ready' : 'error') + '">' + (gateway.running ? 'running' : 'stopped') + '</span></strong><div class="meta">port=' + escapeHtml(gateway.port ?? "?") + ' connections=' + escapeHtml(gateway.connectionCount ?? 0) + ' reloadPending=' + escapeHtml(gateway.reloadPending ?? false) + ' token=' + (gateway.tokenPresent ? 'present' : 'absent') + '</div></div>';
      if (providers.length === 0) {
        el("providers").innerHTML = gatewayRecord + '<div class="empty">No external providers are bound. The canvas still shows tap-native streams and emitters.</div>';
        return;
      }
      const rows = providers.map((provider) => {
        const tools = (provider.tools ?? []).map((tool) => tool.name).join(", ") || "no tools";
        return '<div class="record"><strong>' + escapeHtml(provider.name) + ' <span class="badge ready">' + escapeHtml(provider.id) + '</span></strong><div class="meta">session=' + escapeHtml(provider.sessionId ?? "none") + ' | tools=' + escapeHtml(provider.toolCount ?? 0) + '</div><div class="details">' + escapeHtml(tools) + '</div></div>';
      }).join("");
      el("providers").innerHTML = gatewayRecord + rows;
    }

    function collectTimeline(snapshot) {
      const items = [];
      for (const stream of snapshot.streams ?? []) {
        for (const entry of stream.entries ?? []) {
          items.push({ group: "streams", timestamp: entry.timestamp, source: "stream/" + stream.name, level: "info", message: entry.text, detail: entry.monitorName ? entry.monitorName + " " + (entry.stream ?? "") : entry.source });
        }
      }
      for (const log of snapshot.diagnostics?.logs ?? []) {
        items.push({ group: "logs", timestamp: log.timestamp, source: log.source, level: log.level, message: log.message, detail: compactJson(log.metadata) });
      }
      for (const event of snapshot.diagnostics?.sessionEvents ?? []) {
        items.push({ group: "session", timestamp: event.timestamp, source: "session", level: "debug", message: event.type, detail: compactJson(event.data) });
      }
      for (const event of snapshot.diagnostics?.runtimeEvents ?? []) {
        items.push({ group: "runtime", timestamp: event.timestamp, source: event.type, level: "info", message: event.message, detail: compactJson(event.metadata) });
      }
      return items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    function renderTimeline(snapshot) {
      const query = state.query.trim().toLowerCase();
      const items = collectTimeline(snapshot).filter((item) => {
        if (state.filter !== "all" && item.group !== state.filter) return false;
        if (!query) return true;
        return [item.source, item.level, item.message, item.detail].join(" ").toLowerCase().includes(query);
      }).slice(0, 260);
      el("timeline-count").textContent = items.length + " visible";
      if (items.length === 0) {
        el("timeline").innerHTML = '<div class="empty">No evidence matches the current filter.</div>';
        return;
      }
      el("timeline").innerHTML = items.map((item) => '<div class="tick"><time>' + escapeHtml(timeOnly(item.timestamp)) + '</time><div><span class="badge ' + escapeHtml(item.level) + '">' + escapeHtml(item.group) + '</span> <span class="meta">' + escapeHtml(item.source) + '</span><div><strong>' + escapeHtml(item.message) + '</strong></div>' + (item.detail ? '<div class="details">' + escapeHtml(item.detail) + '</div>' : '') + '</div></div>').join("");
    }

    function render(snapshot) {
      state.snapshot = snapshot;
      renderMetrics(snapshot);
      renderStreams(snapshot);
      renderProviders(snapshot);
      renderTimeline(snapshot);
    }

    async function refresh() {
      if (state.paused) return;
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (response.ok) render(await response.json());
    }

    function connectEvents() {
      if (!("EventSource" in window)) {
        setInterval(refresh, 1800);
        refresh();
        return;
      }
      const source = new EventSource("/events");
      source.addEventListener("snapshot", (event) => {
        if (!state.paused) render(JSON.parse(event.data));
      });
      source.onerror = () => {
        setTimeout(refresh, 2000);
      };
    }

    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        document.querySelectorAll("[data-filter]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        if (state.snapshot) renderTimeline(state.snapshot);
      });
    });
    el("search").addEventListener("input", (event) => {
      state.query = event.target.value;
      if (state.snapshot) renderTimeline(state.snapshot);
    });
    el("pause").addEventListener("click", () => {
      state.paused = !state.paused;
      el("pause").textContent = state.paused ? "Resume" : "Pause";
      if (!state.paused) refresh();
    });
    el("refresh").addEventListener("click", () => refresh());
    connectEvents();
  </script>
</body>
</html>`;
}

export function createTapDiagnosticsCanvas({ getSnapshot, diagnostics } = {}) {
  const instances = new Map();

  function snapshot(options = {}) {
    return typeof getSnapshot === "function"
      ? getSnapshot(sanitizeSnapshotOptions(options))
      : { generatedAt: new Date().toISOString(), error: "No diagnostics snapshot provider configured." };
  }

  function log(message, level = "info", metadata = {}) {
    diagnostics?.log?.("canvas", message, { level, metadata });
  }

  async function startServer(instanceId) {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        textResponse(res, 200, createHtml(), "text/html; charset=utf-8");
        return;
      }
      if (url.pathname === "/api/snapshot") {
        jsonResponse(res, 200, snapshot({ limit: url.searchParams.get("limit") }));
        return;
      }
      if (url.pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        const send = () => {
          res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
        };
        send();
        const interval = setInterval(send, DEFAULT_REFRESH_MS);
        req.on("close", () => clearInterval(interval));
        return;
      }
      jsonResponse(res, 404, { error: "not_found" });
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const entry = { server, url: `http://127.0.0.1:${port}/` };
    instances.set(instanceId, entry);
    log(`Diagnostics canvas server started for instance '${instanceId}'.`, "info", { url: entry.url });
    return entry;
  }

  async function stopServer(instanceId) {
    const entry = instances.get(instanceId);
    if (!entry) {
      return;
    }
    instances.delete(instanceId);
    await new Promise((resolve) => entry.server.close(() => resolve()));
    log(`Diagnostics canvas server stopped for instance '${instanceId}'.`);
  }

  return createCanvas({
    id: TAP_DIAGNOSTICS_CANVAS_ID,
    displayName: "Tap diagnostics",
    description: "Live tap flight recorder for streams, emitters, provider gateway state, logs, and session events.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 10, maximum: 300, description: "Maximum retained rows to show per diagnostics section." }
      }
    },
    actions: [
      {
        name: "refresh_snapshot",
        description: "Return a fresh summary of the tap diagnostics canvas data.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 10, maximum: 300 }
          }
        },
        handler: async ({ input }) => ({
          ok: true,
          summary: summarizeSnapshot(snapshot(input))
        })
      },
      {
        name: "export_snapshot",
        description: "Return the current tap diagnostics snapshot as structured JSON.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 10, maximum: 300 }
          }
        },
        handler: async ({ input }) => snapshot(input)
      }
    ],
    open: async (ctx) => {
      let entry = instances.get(ctx.instanceId);
      if (!entry) {
        entry = await startServer(ctx.instanceId);
      }
      return {
        title: "Tap diagnostics",
        status: "live flight recorder",
        url: entry.url
      };
    },
    onClose: async (ctx) => {
      await stopServer(ctx.instanceId);
    }
  });
}
