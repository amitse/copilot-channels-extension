import {
  EXECUTION_MODE,
  MANAGED_BY,
  MONITOR_STATUS,
  SCOPE,
  WORK_TYPE
} from "../consts.mjs";
import {
  normalizeManagedBy,
  normalizeName,
  normalizeScope
} from "../util/normalize.mjs";
import { nowIso, parseLoopInterval } from "../util/time.mjs";
import { resolveRequestedCwd } from "../util/path.mjs";
import { createClassifier, getClassifierInput } from "../format/classifier.mjs";

export function buildMonitorState(spec, baseCwd, defaults = {}) {
  const name = normalizeName(spec.name);
  if (!name) {
    throw new Error("Monitor name is required.");
  }
  const command = String(spec.command ?? "").trim();
  const prompt = String(spec.prompt ?? "").trim();
  if (!command && !prompt) {
    throw new Error(`Monitor '${name}' must define either a command or a prompt.`);
  }
  if (command && prompt) {
    throw new Error(`Monitor '${name}' cannot define both command and prompt. Choose one work type.`);
  }

  const interval = parseLoopInterval(spec.every);
  const scope = normalizeScope(spec.scope, defaults.scope ?? SCOPE.TEMPORARY);
  const managedBy = normalizeManagedBy(spec.managedBy, defaults.managedBy ?? MANAGED_BY.MODEL);
  const classifier = createClassifier(
    getClassifierInput(spec),
    spec.classifier?.managedBy ?? managedBy,
    scope
  );
  const workType = prompt ? WORK_TYPE.PROMPT : WORK_TYPE.COMMAND;
  const executionMode = interval
    ? EXECUTION_MODE.LOOP
    : prompt
      ? EXECUTION_MODE.ONCE
      : EXECUTION_MODE.PROCESS;

  return {
    name,
    description: String(spec.description ?? "").trim(),
    command: command || null,
    prompt: prompt || null,
    workType,
    executionMode,
    every: interval?.text ?? null,
    everyMs: interval?.ms ?? null,
    requestedCwd: spec.cwd ?? null,
    cwd: resolveRequestedCwd(baseCwd, spec.cwd),
    channel: normalizeName(spec.channel, name),
    autoStart: spec.autoStart !== false,
    includeStderr: spec.includeStderr !== false,
    scope,
    managedBy,
    classifier,
    startedAt: nowIso(),
    stoppedAt: null,
    lineCount: 0,
    droppedLineCount: 0,
    status: executionMode === EXECUTION_MODE.PROCESS ? MONITOR_STATUS.RUNNING : MONITOR_STATUS.QUEUED,
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
