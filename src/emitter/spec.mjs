import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { createEventFilter } from "../format/event-filter.mjs";
import { normalizeDelivery, normalizeName, normalizeLifespan, normalizeOutcome, normalizeOwnership } from "../util/normalize.mjs";
import { parseIntervalSchedule, parseLoopInterval } from "../util/time.mjs";
import { ValidationError } from "../errors/index.mjs";

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function readText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeInteger(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ValidationError(`Invalid emitter spec: ${label} must be a finite number.`);
  }

  const integer = Math.floor(number);
  if (integer < 1) {
    throw new ValidationError(`Invalid emitter spec: ${label} must be 1 or greater.`);
  }

  return integer;
}

function normalizeEventFilter(rawInput, ownership, lifespan) {
  const source = isPlainObject(rawInput?.eventFilter) ? rawInput.eventFilter : isPlainObject(rawInput) ? rawInput : {};
  const rules = Array.isArray(source.rules) ? source.rules : Array.isArray(rawInput.rules) ? rawInput.rules : [];

  return createEventFilter(
    {
      rules,
      ownership: normalizeOwnership(source.ownership ?? rawInput.managedBy, ownership),
      lifespan: normalizeLifespan(source.lifespan ?? rawInput.scope, lifespan)
    },
    ownership,
    lifespan
  );
}

function validateEmitterSpecSchema(rawInput) {
  if (!isPlainObject(rawInput)) {
    throw new ValidationError("Invalid emitter spec: expected a plain object.");
  }

  const name = normalizeName(rawInput.name);
  if (!name) {
    throw new ValidationError("Invalid emitter spec: name is required.");
  }

  const command = readText(rawInput.command);
  const prompt = readText(rawInput.prompt);
  if (!command && !prompt) {
    throw new ValidationError(`Invalid emitter spec '${name}': define either command or prompt.`);
  }
  if (command && prompt) {
    throw new ValidationError(`Invalid emitter spec '${name}': command and prompt are mutually exclusive.`);
  }

  const everyScheduleInput = rawInput.everySchedule;
  if (everyScheduleInput !== undefined && everyScheduleInput !== null && !Array.isArray(everyScheduleInput)) {
    throw new ValidationError(`Invalid emitter spec '${name}': everySchedule must be an array of interval strings.`);
  }
  if (Array.isArray(everyScheduleInput) && everyScheduleInput.length === 0) {
    throw new ValidationError(`Invalid emitter spec '${name}': everySchedule must not be empty.`);
  }

  return { name, command, prompt };
}

function canonicalizeSchedule(value, label, name) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = parseLoopInterval(value);
  if (!parsed) {
    return null;
  }

  if (parsed.idle === true && label === "everySchedule") {
    throw new ValidationError(`Invalid emitter spec '${name}': everySchedule entries cannot be 'idle'.`);
  }

  return parsed;
}

function canonicalizeEverySchedule(rawInput) {
  if (!Array.isArray(rawInput) || rawInput.length === 0) {
    return null;
  }

  const parsed = parseIntervalSchedule(rawInput);
  return {
    everySchedule: parsed.map((item) => item.text),
    everyScheduleMs: parsed.map((item) => item.ms)
  };
}

export function normalizeEmitterSpec(rawInput = {}) {
  const { name, command, prompt } = validateEmitterSpecSchema(rawInput);

  const description = String(rawInput.description ?? "").trim();
  const channel = normalizeName(rawInput.channel, name);
  const cwd = readText(rawInput.cwd);
  const scope = normalizeLifespan(rawInput.scope, LIFESPAN.TEMPORARY);
  const managedBy = normalizeOwnership(rawInput.managedBy, OWNERSHIP.MODEL_OWNED);
  const autoStart = rawInput.autoStart !== false;
  const includeStderr = rawInput.includeStderr !== false;
  const subscribe = rawInput.subscribe !== false;
  const delivery = normalizeDelivery(rawInput.delivery, EVENT_OUTCOME.SURFACE);
  const force = rawInput.force === true;
  const maxRuns = normalizeInteger(rawInput.maxRuns, "maxRuns");
  const eventFilter = normalizeEventFilter(rawInput, managedBy, scope);

  const everyScheduleInput = canonicalizeEverySchedule(rawInput.everySchedule);
  const everySchedule = everyScheduleInput?.everySchedule ?? null;
  const everyScheduleMs = everyScheduleInput?.everyScheduleMs ?? null;

  const every = readText(rawInput.every);
  const parsedEvery = every ? canonicalizeSchedule(every, "every", name) : null;

  if (everySchedule && every) {
    throw new ValidationError(`Invalid emitter spec '${name}': every and everySchedule are mutually exclusive.`);
  }
  if (parsedEvery?.idle && !prompt) {
    throw new ValidationError(`Invalid emitter spec '${name}': every='idle' is only valid for prompt emitters.`);
  }

  const canonical = {
    name,
    description,
    command,
    prompt,
    channel,
    cwd,
    every: parsedEvery?.text ?? null,
    everyMs: parsedEvery?.ms ?? null,
    everySchedule,
    everyScheduleMs,
    scope,
    managedBy,
    autoStart,
    includeStderr,
    eventFilter,
    subscribe,
    delivery,
    maxRuns,
    force
  };

  Object.defineProperty(canonical, "__emitterSpec", {
    value: true,
    enumerable: false
  });

  Object.freeze(canonical.eventFilter);
  return Object.freeze(canonical);
}

export const EmitterSpec = Object.freeze({
  normalize: normalizeEmitterSpec
});
