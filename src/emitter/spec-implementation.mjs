import { EVENT_OUTCOME, EMITTER_TYPE, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { normalizeEmitterStreamInput, normalizeOptionalPositiveInteger, readOptionalText } from "../contracts/emitter-input.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import { ValidationError } from "../errors/index.mjs";
import { normalizeDelivery, normalizeName, normalizeLifespan, normalizeOwnership } from "../util/normalize.mjs";
import { parseIntervalSchedule, parseLoopInterval } from "../util/time.mjs";
import { isStrictPlainObject } from "../util/type-guards.mjs";
import { deriveRunSchedule } from "./schedule.mjs";

function normalizeEventFilterInput(rawInput, managedBy, scope) {
  if (Array.isArray(rawInput.eventFilter)) {
    return EventFilterService.normalize({
      rules: rawInput.eventFilter,
      ownership: rawInput.ownership ?? rawInput.managedBy,
      lifespan: rawInput.lifespan ?? rawInput.scope
    }, managedBy, scope);
  }

  return EventFilterService.normalize(rawInput, managedBy, scope);
}

function assertPlainEmitterSpecInput(rawInput) {
  if (!isStrictPlainObject(rawInput)) {
    throw new ValidationError("Invalid emitter spec: expected a plain object.");
  }
}

function readEmitterName(rawInput) {
  const name = normalizeName(rawInput.name);
  if (!name) {
    throw new ValidationError("Invalid emitter spec: name is required.");
  }

  return name;
}

function readEmitterBody(rawInput, name) {
  const command = readOptionalText(rawInput.command);
  const prompt = readOptionalText(rawInput.prompt);
  if (!command && !prompt) {
    throw new ValidationError(`Invalid emitter spec '${name}': define either command or prompt.`);
  }
  if (command && prompt) {
    throw new ValidationError(`Invalid emitter spec '${name}': command and prompt are mutually exclusive.`);
  }

  return { command, prompt };
}

function assertEveryScheduleInput(rawInput, name) {
  const everyScheduleInput = rawInput.everySchedule;
  if (everyScheduleInput !== undefined && everyScheduleInput !== null && !Array.isArray(everyScheduleInput)) {
    throw new ValidationError(`Invalid emitter spec '${name}': everySchedule must be an array of interval strings.`);
  }
  if (Array.isArray(everyScheduleInput) && everyScheduleInput.length === 0) {
    throw new ValidationError(`Invalid emitter spec '${name}': everySchedule must not be empty.`);
  }
}

function validateEmitterSpecSchema(rawInput) {
  assertPlainEmitterSpecInput(rawInput);
  const name = readEmitterName(rawInput);
  const { command, prompt } = readEmitterBody(rawInput, name);
  assertEveryScheduleInput(rawInput, name);

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

function schedulesConflict(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left.idle === true || right.idle === true) {
    return left.idle !== right.idle;
  }
  return left.ms !== right.ms;
}

function resolveEmitterType(prompt) {
  return prompt ? EMITTER_TYPE.PROMPT : EMITTER_TYPE.COMMAND;
}

function resolveLoopSchedule(rawInput, name) {
  const everyInput = readOptionalText(rawInput.every);
  const runInterval = readOptionalText(rawInput.runInterval);
  const parsedEveryInput = everyInput ? canonicalizeSchedule(everyInput, "every", name) : null;
  const parsedRunInterval = runInterval ? canonicalizeSchedule(runInterval, "runInterval", name) : null;
  if (schedulesConflict(parsedEveryInput, parsedRunInterval)) {
    throw new ValidationError(`Invalid emitter spec '${name}': every and runInterval must not conflict.`);
  }

  return parsedEveryInput ?? parsedRunInterval;
}

function assertScheduleCompatibility({ everySchedule, name, parsedEvery, prompt }) {
  if (everySchedule && parsedEvery) {
    throw new ValidationError(`Invalid emitter spec '${name}': every and everySchedule are mutually exclusive.`);
  }
  if (parsedEvery?.idle && !prompt) {
    throw new ValidationError(`Invalid emitter spec '${name}': every='idle' is only valid for prompt emitters.`);
  }
}

function buildRunSchedule({ everyScheduleMs, parsedEvery, prompt }) {
  const emitterType = resolveEmitterType(prompt);
  const runSchedule = deriveRunSchedule({
    emitterType,
    every: parsedEvery?.text ?? null,
    everyMs: parsedEvery?.ms ?? null,
    everyScheduleMs,
    idle: parsedEvery?.idle === true
  });

  return { emitterType, runSchedule };
}

function resolveEmitterScheduleInput(rawInput, { name, prompt }) {
  const everyScheduleInput = canonicalizeEverySchedule(rawInput.everySchedule);
  const everySchedule = everyScheduleInput?.everySchedule ?? null;
  const everyScheduleMs = everyScheduleInput?.everyScheduleMs ?? null;
  const parsedEvery = resolveLoopSchedule(rawInput, name);
  assertScheduleCompatibility({ everySchedule, name, parsedEvery, prompt });
  const { emitterType, runSchedule } = buildRunSchedule({ everyScheduleMs, parsedEvery, prompt });

  return {
    emitterType,
    runSchedule,
    every: parsedEvery?.text ?? null,
    everyMs: parsedEvery?.ms ?? null,
    everySchedule,
    everyScheduleMs
  };
}

export function normalizeEmitterSpec(rawInput = {}) {
  const { name, command, prompt } = validateEmitterSpecSchema(rawInput);

  const description = String(rawInput.description ?? "").trim();
  const channel = normalizeEmitterStreamInput(rawInput, name);
  const cwd = readOptionalText(rawInput.cwd);
  const scope = normalizeLifespan(rawInput.lifespan ?? rawInput.scope, LIFESPAN.TEMPORARY);
  const managedBy = normalizeOwnership(rawInput.ownership ?? rawInput.managedBy, OWNERSHIP.MODEL_OWNED);
  const autoStart = rawInput.autoStart !== false;
  const includeStderr = rawInput.includeStderr !== false;
  const subscribe = rawInput.subscribe !== false;
  const delivery = normalizeDelivery(rawInput.delivery, EVENT_OUTCOME.SURFACE);
  const force = rawInput.force === true;
  const maxRuns = normalizeOptionalPositiveInteger(rawInput.maxRuns, {
    label: "maxRuns",
    errorPrefix: "Invalid emitter spec"
  });
  const eventFilter = normalizeEventFilterInput(rawInput, managedBy, scope);
  const schedule = resolveEmitterScheduleInput(rawInput, { name, prompt });

  const canonical = {
    name,
    description,
    command,
    prompt,
    emitterType: schedule.emitterType,
    runSchedule: schedule.runSchedule,
    channel,
    cwd,
    every: schedule.every,
    everyMs: schedule.everyMs,
    everySchedule: schedule.everySchedule,
    everyScheduleMs: schedule.everyScheduleMs,
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
