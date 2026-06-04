import { previewText } from "../util/text.mjs";
import { projectConfiguredEmitter } from "../emitter/projection.mjs";
import { formatEventFilter } from "./event-filter.mjs";

export function describeEmitterWork(emitter) {
  if (emitter.command) {
    return `command=${emitter.command}`;
  }

  return `prompt=${JSON.stringify(previewText(emitter.prompt, 90))}`;
}

export function formatRunningEmitter(emitter, stream) {
  return [
    `- ${emitter.name}:`,
    `  status=${emitter.status}`,
    `  scope=${emitter.lifespan}`,
    `  ownership=${emitter.ownership}`,
    `  emitterType=${emitter.emitterType}`,
    `  runSchedule=${emitter.runSchedule}`,
    `  stream=${emitter.stream}`,
    `  sessionInjector=${stream?.sessionInjector?.enabled ? "on" : "off"}`,
    `  cwd=${emitter.cwd}`,
    `  ${describeEmitterWork(emitter)}`,
    emitter.everySchedule ? `  everySchedule=[${emitter.everySchedule.join(", ")}]` : null,
    emitter.every && !emitter.everySchedule ? `  every=${emitter.every}` : null,
    emitter.maxRuns ? `  maxRuns=${emitter.maxRuns}` : null,
    `  autoStart=${emitter.autoStart}`,
    `  includeStderr=${emitter.includeStderr}`,
    `  runs=${emitter.runCount}`,
    `  acceptedLines=${emitter.lineCount}`,
    `  droppedLines=${emitter.droppedLineCount}`,
    `  eventFilter=${formatEventFilter(emitter.eventFilter)}`,
    emitter.description ? `  description=${emitter.description}` : null,
    emitter.lastRunAt ? `  lastRunAt=${emitter.lastRunAt}` : null,
    emitter.lastRunStatus ? `  lastRunStatus=${emitter.lastRunStatus}` : null,
    emitter.exitCode !== null && emitter.exitCode !== undefined ? `  exitCode=${emitter.exitCode}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatConfiguredEmitter(entry) {
  const emitter = projectConfiguredEmitter(entry);
  const prompt = emitter.prompt ? `  prompt=${JSON.stringify(previewText(emitter.prompt, 90))}` : null;
  const command = emitter.command ? `  command=${emitter.command}` : null;
  const everySchedule = emitter.everySchedule
    ? `  everySchedule=[${emitter.everySchedule.join(", ")}]`
    : null;
  const everyScheduleMs = emitter.everyScheduleMs
    ? `  everyScheduleMs=[${emitter.everyScheduleMs.join(", ")}]`
    : null;
  const every = emitter.every && !emitter.everySchedule && !emitter.everyScheduleMs
    ? `  every=${emitter.every}`
    : null;

  return [
    `- ${emitter.name}:`,
    "  status=configured",
    `  scope=${emitter.scope}`,
    `  ownership=${emitter.ownership}`,
    `  emitterType=${emitter.emitterType}`,
    `  runSchedule=${emitter.runSchedule}`,
    `  stream=${emitter.stream}`,
    `  autoStart=${emitter.autoStart}`,
    emitter.enabled === undefined ? null : `  enabled=${emitter.enabled}`,
    `  includeStderr=${emitter.includeStderr}`,
    emitter.cwd ? `  cwd=${emitter.cwd}` : null,
    command,
    prompt,
    everySchedule,
    everyScheduleMs,
    every,
    emitter.maxRuns ? `  maxRuns=${emitter.maxRuns}` : null,
    `  eventFilter=${formatEventFilter(emitter.eventFilter)}`,
    emitter.description ? `  description=${emitter.description}` : null
  ]
    .filter(Boolean)
    .join("\n");
}
