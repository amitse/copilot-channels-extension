import path from "node:path";

export const GITHUB_DIR = ".github";
export const CONFIG_FILENAME = "copilot-channels.config.json";
export const CONFIG_LOCATIONS = [
  CONFIG_FILENAME,
  `${GITHUB_DIR}${path.sep}${CONFIG_FILENAME}`
];
export const COPILOT_INSTRUCTIONS_PATH = `${GITHUB_DIR}/copilot-instructions.md`;

export const MAX_CHANNEL_ENTRIES = 200;
export const DEFAULT_CHANNEL = "main";
export const DEFAULT_CHANNEL_DESCRIPTION = "Extension events";

export const LOOP_INTERVAL_PATTERN =
  /^\s*(?:every\s+)?(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i;

export const NOTIFICATION_BATCH_SIZE = 4;

export const LOG_PREFIX = "[📎]:";

export const SCOPE = Object.freeze({
  TEMPORARY: "temporary",
  PERSISTENT: "persistent"
});

export const MANAGED_BY = Object.freeze({
  USER: "user",
  MODEL: "model"
});

export const DELIVERY = Object.freeze({
  ALL: "all",
  IMPORTANT: "important"
});

export const WORK_TYPE = Object.freeze({
  COMMAND: "command",
  PROMPT: "prompt"
});

export const EXECUTION_MODE = Object.freeze({
  PROCESS: "process",
  LOOP: "loop",
  ONCE: "once"
});

export const MONITOR_STATUS = Object.freeze({
  QUEUED: "queued",
  WAITING: "waiting",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
  EXITED: "exited",
  COMPLETED: "completed",
  ERROR: "error"
});

export const RUN_STATUS = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure"
});

export const MONITOR_OPERATION_STATUS = Object.freeze({
  REMOVED_FROM_CONFIG: "removed-from-config",
  CONFIGURED: "configured"
});

export const TERMINAL_MONITOR_STATUSES = Object.freeze([
  MONITOR_STATUS.STOPPED,
  MONITOR_STATUS.EXITED,
  MONITOR_STATUS.COMPLETED,
  MONITOR_STATUS.ERROR
]);

export const STREAM = Object.freeze({
  STDOUT: "stdout",
  STDERR: "stderr",
  PROMPT: "prompt",
  SYSTEM: "system"
});

export const SOURCE = Object.freeze({
  SYSTEM: "system",
  TOOL: "tool",
  MONITOR: "monitor",
  MONITOR_STDERR: "monitor:stderr",
  MONITOR_PROMPT: "monitor:prompt"
});
