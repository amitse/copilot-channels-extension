import { nowIso } from "../util/time.mjs";

const DEFAULT_MAX_LOGS = 300;
const DEFAULT_MAX_EVENTS = 300;
const DEFAULT_MAX_RUNTIME_EVENTS = 300;
const MAX_STRING_LENGTH = 1200;
const MAX_COLLECTION_ITEMS = 40;
const MAX_DEPTH = 4;
const SECRET_KEY_PATTERN = /(?:token|secret|password|credential|authorization|api[-_]?key|reconnectToken|expectedToken)/i;

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.floor(number));
}

function createRingBuffer(maxEntries) {
  const entries = [];
  const limit = normalizePositiveInteger(maxEntries, 0);
  let total = 0;
  let dropped = 0;

  function append(entry) {
    total += 1;
    if (limit === 0) {
      dropped += 1;
      return null;
    }

    entries.push(entry);
    if (entries.length > limit) {
      const overflow = entries.length - limit;
      entries.splice(0, overflow);
      dropped += overflow;
    }
    return entry;
  }

  function snapshot(limitOverride) {
    const requested = normalizePositiveInteger(limitOverride, entries.length);
    return entries.slice(Math.max(0, entries.length - requested)).map((entry) => safeClone(entry));
  }

  function stats() {
    return {
      retained: entries.length,
      total,
      dropped,
      capacity: limit
    };
  }

  return { append, snapshot, stats };
}

function truncateString(value, maxLength = MAX_STRING_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... (${text.length - maxLength} chars truncated)`;
}

function safeClone(value, options = {}, depth = 0, seen = new WeakSet()) {
  const maxDepth = normalizePositiveInteger(options.maxDepth, MAX_DEPTH);
  const maxStringLength = normalizePositiveInteger(options.maxStringLength, MAX_STRING_LENGTH);
  const maxCollectionItems = normalizePositiveInteger(options.maxCollectionItems, MAX_COLLECTION_ITEMS);

  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string") {
    return truncateString(value, maxStringLength);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message, maxStringLength),
      stack: truncateString(value.stack ?? "", maxStringLength)
    };
  }
  if (depth >= maxDepth) {
    return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const slice = value.slice(0, maxCollectionItems).map((item) => safeClone(item, options, depth + 1, seen));
    if (value.length > maxCollectionItems) {
      slice.push(`... ${value.length - maxCollectionItems} more items`);
    }
    return slice;
  }

  const output = {};
  const entries = Object.entries(value).slice(0, maxCollectionItems);
  for (const [key, item] of entries) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? "[redacted]"
      : safeClone(item, options, depth + 1, seen);
  }
  const remaining = Object.keys(value).length - entries.length;
  if (remaining > 0) {
    output.__truncatedKeys = remaining;
  }
  return output;
}

function normalizeLevel(value) {
  const level = String(value ?? "info").trim().toLowerCase();
  if (level === "warning" || level === "warn") return "warning";
  if (level === "error") return "error";
  if (level === "debug") return "debug";
  return "info";
}

function createId(prefix, count) {
  return `${prefix}-${count.toString(36)}`;
}

function summarizeSessionEvent(event) {
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  return {
    id: event?.id ?? null,
    timestamp: event?.timestamp ?? nowIso(),
    type: String(event?.type ?? "unknown"),
    ephemeral: event?.ephemeral === true,
    agentId: event?.agentId ?? null,
    dataKeys: Object.keys(data),
    data: safeClone(data, {
      maxDepth: 3,
      maxStringLength: 700,
      maxCollectionItems: 24
    })
  };
}

export function createDiagnosticsStore(options = {}) {
  const logs = createRingBuffer(options.maxLogs ?? DEFAULT_MAX_LOGS);
  const sessionEvents = createRingBuffer(options.maxSessionEvents ?? DEFAULT_MAX_EVENTS);
  const runtimeEvents = createRingBuffer(options.maxRuntimeEvents ?? DEFAULT_MAX_RUNTIME_EVENTS);
  const sessionEventCounts = new Map();
  let logCount = 0;
  let runtimeEventCount = 0;
  let sessionEventCount = 0;
  let cleanupSessionListener = () => {};

  function recordLog(source, message, options = {}) {
    logCount += 1;
    return logs.append({
      id: createId("log", logCount),
      timestamp: nowIso(),
      source: String(source ?? "tap"),
      level: normalizeLevel(options.level),
      message: truncateString(message, options.maxStringLength ?? MAX_STRING_LENGTH),
      metadata: safeClone(options.metadata ?? null, {
        maxDepth: 3,
        maxStringLength: 700,
        maxCollectionItems: 20
      })
    });
  }

  function recordRuntimeEvent(type, message, metadata = {}) {
    runtimeEventCount += 1;
    return runtimeEvents.append({
      id: createId("evt", runtimeEventCount),
      timestamp: nowIso(),
      type: String(type ?? "runtime"),
      message: truncateString(message, MAX_STRING_LENGTH),
      metadata: safeClone(metadata, {
        maxDepth: 3,
        maxStringLength: 700,
        maxCollectionItems: 20
      })
    });
  }

  function recordSessionEvent(event) {
    sessionEventCount += 1;
    const type = String(event?.type ?? "unknown");
    sessionEventCounts.set(type, (sessionEventCounts.get(type) ?? 0) + 1);
    return sessionEvents.append({
      sequence: sessionEventCount,
      ...summarizeSessionEvent(event)
    });
  }

  function detachSession() {
    try {
      cleanupSessionListener();
    } catch {
      // Diagnostics must not interrupt session lifecycle.
    }
    cleanupSessionListener = () => {};
  }

  function attachSession(session) {
    detachSession();
    if (!session || typeof session.on !== "function") {
      recordRuntimeEvent("session-events", "Session event capture unavailable; no session listener attached.");
      return;
    }

    try {
      const unsubscribe = session.on((event) => {
        recordSessionEvent(event);
      });
      cleanupSessionListener = typeof unsubscribe === "function" ? unsubscribe : () => {};
      recordRuntimeEvent("session-events", "Session event capture attached.");
    } catch (error) {
      recordLog("diagnostics", "Failed to attach session event capture.", {
        level: "warning",
        metadata: { error }
      });
    }
  }

  function snapshot(options = {}) {
    return {
      generatedAt: nowIso(),
      logs: logs.snapshot(options.logLimit ?? 140),
      runtimeEvents: runtimeEvents.snapshot(options.runtimeEventLimit ?? 140),
      sessionEvents: sessionEvents.snapshot(options.sessionEventLimit ?? 140),
      sessionEventCounts: Object.fromEntries([...sessionEventCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      stats: {
        logs: logs.stats(),
        runtimeEvents: runtimeEvents.stats(),
        sessionEvents: sessionEvents.stats()
      }
    };
  }

  return {
    log: recordLog,
    event: recordRuntimeEvent,
    attachSession,
    detachSession,
    snapshot
  };
}
