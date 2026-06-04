import { EMITTER_TYPE, LIFESPAN, OWNERSHIP, RUN_SCHEDULE } from "../consts.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";
import { normalizeLifespan, normalizeName, normalizeOwnership } from "../util/normalize.mjs";

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

function resolveRunSchedule({ emitterType, every, idle, everySchedule, everyScheduleMs }) {
  if (idle) {
    return RUN_SCHEDULE.IDLE;
  }

  if (every) {
    return RUN_SCHEDULE.TIMED;
  }

  if (everySchedule || everyScheduleMs) {
    return RUN_SCHEDULE.TIMED;
  }

  return emitterType === EMITTER_TYPE.PROMPT ? RUN_SCHEDULE.ONE_TIME : RUN_SCHEDULE.CONTINUOUS;
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
    runSchedule: resolveRunSchedule({ emitterType, every, idle, everySchedule, everyScheduleMs }),
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
