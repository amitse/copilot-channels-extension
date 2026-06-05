import { EMITTER_TYPE, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import { normalizeLifespan, normalizeName, normalizeOwnership } from "../util/normalize.mjs";
import { deriveRunSchedule } from "./schedule.mjs";

function readOptionalText(value) {
  return value ? String(value) : null;
}

function readOptionalArray(value) {
  return Array.isArray(value) && value.length > 0 ? value.map((item) => String(item)) : null;
}

function readOptionalMsArray(value) {
  return Array.isArray(value) && value.length > 0
    ? value.map((item) => {
        const number = Number(item);
        return Number.isFinite(number) ? number : item;
      })
    : null;
}

function normalizeEmitterType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (normalized === EMITTER_TYPE.PROMPT) {
    return EMITTER_TYPE.PROMPT;
  }
  if (normalized === EMITTER_TYPE.COMMAND) {
    return EMITTER_TYPE.COMMAND;
  }

  return null;
}

function cloneSessionInjector(entry, stream) {
  const sessionInjector = stream?.sessionInjector ?? entry?.sessionInjector;
  return sessionInjector ? { ...sessionInjector } : null;
}

function cloneStreamSessionInjector(stream) {
  return stream?.sessionInjector ? { ...stream.sessionInjector } : null;
}

function cloneEventFilter(eventFilter) {
  return eventFilter
    ? {
        ...eventFilter,
        rules: Array.isArray(eventFilter.rules)
          ? eventFilter.rules.map((rule) => ({ ...rule }))
          : []
      }
    : null;
}

function cloneOptionalArray(value) {
  return Array.isArray(value) ? [...value] : null;
}

/**
 * Project a persisted/configured emitter entry into the display snapshot shape
 * used by tap_list_emitters and formatter code. This intentionally stays more
 * tolerant than EmitterSpec.normalize because old config files may contain
 * incomplete definitions that were historically listable.
 */
export function projectConfiguredEmitter(entry = {}, options = {}) {
  const name = normalizeName(entry.name);
  const channel = normalizeName(entry.channel ?? entry.stream ?? name, name);
  const stream = typeof options.getStream === "function"
    ? options.getStream(channel)
    : options.stream;
  const ownership = normalizeOwnership(entry.ownership, OWNERSHIP.USER_OWNED);
  const lifespan = normalizeLifespan(entry.lifespan ?? entry.scope, LIFESPAN.PERSISTENT);
  const prompt = readOptionalText(entry.prompt);
  const command = readOptionalText(entry.command);
  const every = readOptionalText(entry.every);
  const everySchedule = readOptionalArray(entry.everySchedule);
  const everyScheduleMs = readOptionalMsArray(entry.everyScheduleMs);
  const configuredType = normalizeEmitterType(entry.type ?? entry.emitterType);
  const emitterType = prompt
    ? EMITTER_TYPE.PROMPT
    : command
      ? EMITTER_TYPE.COMMAND
      : configuredType ?? EMITTER_TYPE.COMMAND;
  const idle = (entry.idle === true || every === "idle") && emitterType === EMITTER_TYPE.PROMPT;
  const enabled = entry.enabled === undefined ? undefined : entry.enabled !== false;
  const eventFilter = EventFilterService.normalize(entry, ownership, lifespan);

  return {
    name,
    status: "configured",
    scope: lifespan,
    lifespan,
    ownership,
    type: emitterType,
    emitterType,
    runSchedule: deriveRunSchedule({ emitterType, every, idle, everySchedule, everyScheduleMs }),
    stream: channel,
    channel,
    autoStart: entry.autoStart !== false,
    ...(enabled === undefined ? {} : { enabled }),
    includeStderr: entry.includeStderr !== false,
    cwd: entry.cwd ?? null,
    command,
    prompt,
    every,
    idle,
    everySchedule,
    everyScheduleMs,
    maxRuns: entry.maxRuns ?? null,
    description: entry.description ?? "",
    eventFilter,
    sessionInjector: cloneSessionInjector(entry, stream),
    source: "configured"
  };
}

/**
 * Project a supervisor-owned running emitter into the runtime snapshot shape
 * returned by service APIs. Keep this distinct from configured projection so
 * runtime-only aliases such as scope/channel stay in sync.
 */
export function projectRunningEmitter(emitter, stream) {
  return {
    name: emitter.name,
    description: emitter.description ?? "",
    status: emitter.status,
    scope: emitter.lifespan,
    lifespan: emitter.lifespan,
    ownership: emitter.ownership,
    type: emitter.emitterType,
    emitterType: emitter.emitterType,
    runSchedule: emitter.runSchedule,
    stream: emitter.stream,
    channel: emitter.stream,
    cwd: emitter.cwd ?? null,
    command: emitter.command ?? null,
    prompt: emitter.prompt ?? null,
    every: emitter.every ?? null,
    everyMs: emitter.everyMs ?? null,
    everySchedule: cloneOptionalArray(emitter.everySchedule),
    everyScheduleMs: cloneOptionalArray(emitter.everyScheduleMs),
    maxRuns: emitter.maxRuns ?? null,
    autoStart: emitter.autoStart,
    includeStderr: emitter.includeStderr,
    startedAt: emitter.startedAt ?? null,
    stoppedAt: emitter.stoppedAt ?? null,
    runCount: emitter.runCount ?? 0,
    lineCount: emitter.lineCount ?? 0,
    droppedLineCount: emitter.droppedLineCount ?? 0,
    lastRunAt: emitter.lastRunAt ?? null,
    lastRunStatus: emitter.lastRunStatus ?? null,
    exitCode: emitter.exitCode ?? null,
    eventFilter: cloneEventFilter(emitter.eventFilter),
    sessionInjector: cloneStreamSessionInjector(stream),
    source: "running"
  };
}

/**
 * Project a stream state object into the public snapshot shape.
 */
export function projectStream(stream) {
  if (!stream) {
    return null;
  }

  return {
    ...stream,
    entries: Array.isArray(stream.entries) ? stream.entries.map((entry) => ({ ...entry })) : [],
    sessionInjector: cloneStreamSessionInjector(stream)
  };
}
