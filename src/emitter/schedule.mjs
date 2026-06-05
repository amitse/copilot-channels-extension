import { EMITTER_TYPE, RUN_SCHEDULE } from "../consts.mjs";

/**
 * Derive the public runSchedule classification from already-normalized or
 * persisted schedule fields.
 *
 * Callers intentionally decide which fields to pass:
 * - normalized start specs pass parsed interval fields;
 * - configured-emitter projection also passes persisted text/array fields so
 *   older, partially-normalized config entries remain listable as timed.
 */
export function deriveRunSchedule({
  emitterType = null,
  prompt = null,
  every = null,
  everyMs = null,
  everySchedule = null,
  everyScheduleMs = null,
  idle = false
} = {}) {
  if (idle === true) {
    return RUN_SCHEDULE.IDLE;
  }

  if (everyMs !== null || everyScheduleMs !== null) {
    return RUN_SCHEDULE.TIMED;
  }

  if (every || everySchedule) {
    return RUN_SCHEDULE.TIMED;
  }

  const resolvedEmitterType = emitterType ?? (prompt ? EMITTER_TYPE.PROMPT : EMITTER_TYPE.COMMAND);
  return resolvedEmitterType === EMITTER_TYPE.PROMPT
    ? RUN_SCHEDULE.ONE_TIME
    : RUN_SCHEDULE.CONTINUOUS;
}
