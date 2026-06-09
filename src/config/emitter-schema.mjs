const EMITTER_RUNTIME_KEYS = Object.freeze([
  "emitterType",
  "runSchedule",
  "everyMs",
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
