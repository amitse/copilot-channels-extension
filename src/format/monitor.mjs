import { MANAGED_BY, SCOPE, WORK_TYPE, EXECUTION_MODE } from "../consts.mjs";
import { normalizeManagedBy, normalizeName } from "../util/normalize.mjs";
import { previewText } from "../util/text.mjs";
import { createClassifier, formatClassifier, getClassifierInput } from "./classifier.mjs";

export function describeMonitorWork(monitor) {
  if (monitor.command) {
    return `command=${monitor.command}`;
  }

  return `prompt=${JSON.stringify(previewText(monitor.prompt, 90))}`;
}

export function formatRunningMonitor(monitor, channel) {
  return [
    `- ${monitor.name}:`,
    `  status=${monitor.status}`,
    `  scope=${monitor.scope}`,
    `  managedBy=${monitor.managedBy}`,
    `  workType=${monitor.workType}`,
    `  execution=${monitor.executionMode}`,
    `  channel=${monitor.channel}`,
    `  subscription=${channel?.subscription?.enabled ? "on" : "off"}`,
    `  cwd=${monitor.cwd}`,
    `  ${describeMonitorWork(monitor)}`,
    monitor.every ? `  every=${monitor.every}` : null,
    `  autoStart=${monitor.autoStart}`,
    `  includeStderr=${monitor.includeStderr}`,
    `  runs=${monitor.runCount}`,
    `  acceptedLines=${monitor.lineCount}`,
    `  droppedLines=${monitor.droppedLineCount}`,
    `  classifier=${formatClassifier(monitor.classifier)}`,
    monitor.description ? `  description=${monitor.description}` : null,
    monitor.lastRunAt ? `  lastRunAt=${monitor.lastRunAt}` : null,
    monitor.lastRunStatus ? `  lastRunStatus=${monitor.lastRunStatus}` : null,
    monitor.exitCode !== null && monitor.exitCode !== undefined ? `  exitCode=${monitor.exitCode}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatConfiguredMonitor(entry) {
  const classifier = createClassifier(
    getClassifierInput(entry),
    entry.classifier?.managedBy ?? entry.managedBy ?? MANAGED_BY.USER,
    SCOPE.PERSISTENT
  );
  const prompt = entry.prompt ? `  prompt=${JSON.stringify(previewText(entry.prompt, 90))}` : null;
  const command = entry.command ? `  command=${entry.command}` : null;
  const every = entry.every ? `  every=${entry.every}` : null;
  const workType = entry.prompt ? WORK_TYPE.PROMPT : WORK_TYPE.COMMAND;
  const executionMode = entry.every
    ? EXECUTION_MODE.LOOP
    : entry.prompt
      ? EXECUTION_MODE.ONCE
      : EXECUTION_MODE.PROCESS;
  return [
    `- ${normalizeName(entry.name)}:`,
    "  status=configured",
    `  scope=${SCOPE.PERSISTENT}`,
    `  managedBy=${normalizeManagedBy(entry.managedBy, MANAGED_BY.USER)}`,
    `  workType=${workType}`,
    `  execution=${executionMode}`,
    `  channel=${normalizeName(entry.channel, normalizeName(entry.name))}`,
    `  autoStart=${entry.autoStart !== false}`,
    `  includeStderr=${entry.includeStderr !== false}`,
    entry.cwd ? `  cwd=${entry.cwd}` : null,
    command,
    prompt,
    every,
    `  classifier=${formatClassifier(classifier)}`,
    entry.description ? `  description=${entry.description}` : null
  ]
    .filter(Boolean)
    .join("\n");
}
