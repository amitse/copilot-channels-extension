import { EMITTER_STATUS, RUN_SCHEDULE } from "../consts.mjs";
import { nowIso } from "../util/time.mjs";
import { resolveRequestedCwd } from "../util/path.mjs";
import { normalizeEmitterSpec } from "./spec.mjs";

export const EMITTER_RUNTIME_KEYS = Object.freeze([
  "emitterType",
  "runSchedule",
  "requestedCwd",
  "startedAt",
  "stoppedAt",
  "lineCount",
  "droppedLineCount",
  "status",
  "stopRequested",
  "timer",
  "inFlight",
  "runCount",
  "lastRunAt",
  "lastRunStatus",
  "process",
  "stdoutReader",
  "stderrReader",
  "exitCode"
]);

export function stripEmitterRuntimeFields(emitter) {
  const persisted = { ...(emitter ?? {}) };

  for (const key of EMITTER_RUNTIME_KEYS) {
    delete persisted[key];
  }

  return persisted;
}

export function buildEmitterState(spec, baseCwd) {
  const canonicalSpec = spec?.__emitterSpec === true ? spec : normalizeEmitterSpec(spec);

  return {
   name: canonicalSpec.name,
   description: canonicalSpec.description ?? "",
   command: canonicalSpec.command ?? null,
   prompt: canonicalSpec.prompt ?? null,
   emitterType: canonicalSpec.emitterType,
   runSchedule: canonicalSpec.runSchedule,
   every: canonicalSpec.every ?? null,
   everyMs: canonicalSpec.everyMs ?? null,
   everySchedule: canonicalSpec.everySchedule ?? null,
   everyScheduleMs: canonicalSpec.everyScheduleMs ?? null,
   requestedCwd: canonicalSpec.cwd ?? null,
   cwd: resolveRequestedCwd(baseCwd, canonicalSpec.cwd),
   stream: canonicalSpec.channel,
   autoStart: canonicalSpec.autoStart,
   includeStderr: canonicalSpec.includeStderr,
   lifespan: canonicalSpec.scope,
   ownership: canonicalSpec.managedBy,
   eventFilter: canonicalSpec.eventFilter,
   maxRuns: canonicalSpec.maxRuns,
   startedAt: nowIso(),
   stoppedAt: null,
   lineCount: 0,
   droppedLineCount: 0,
   status: canonicalSpec.runSchedule === RUN_SCHEDULE.CONTINUOUS ? EMITTER_STATUS.RUNNING : EMITTER_STATUS.QUEUED,
   stopRequested: false,
   timer: null,
   inFlight: false,
   runCount: 0,
   lastRunAt: null,
   lastRunStatus: null,
   process: null,
   stdoutReader: null,
   stderrReader: null,
   exitCode: null
  };
}
