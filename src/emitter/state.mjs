import {
  EMITTER_STATUS,
  EMITTER_TYPE,
  RUN_SCHEDULE
} from "../consts.mjs";
import { normalize as normalizeEventFilter } from "../services/event-filter-service.mjs";
import { nowIso } from "../util/time.mjs";
import { resolveRequestedCwd } from "../util/path.mjs";
import { ValidationError } from "../errors/index.mjs";

export function buildEmitterState(spec, baseCwd) {
  const name = spec.name;
  if (!name) {
   throw new ValidationError("Emitter name is required.");
  }
  const command = spec.command;
  const prompt = spec.prompt;
  if (!command && !prompt) {
   throw new ValidationError(`Emitter '${name}' must define either a command or a prompt.`);
  }
  if (command && prompt) {
   throw new ValidationError(`Emitter '${name}' cannot define both command and prompt. Choose one emitter type.`);
  }

  const every = spec.every ?? null;
  const everyMs = spec.everyMs ?? null;
  const everySchedule = spec.everySchedule ?? null;
  const everyScheduleMs = spec.everyScheduleMs ?? null;
  const lifespan = spec.scope;
  const ownership = spec.managedBy;
  const eventFilter = normalizeEventFilter(spec.eventFilter ?? spec);
  const emitterType = prompt ? EMITTER_TYPE.PROMPT : EMITTER_TYPE.COMMAND;

  let runSchedule;
  if (every === "idle") {
   runSchedule = RUN_SCHEDULE.IDLE;
  } else if (everyMs !== null || everyScheduleMs !== null) {
   runSchedule = RUN_SCHEDULE.TIMED;
  } else if (prompt) {
   runSchedule = RUN_SCHEDULE.ONE_TIME;
  } else {
   runSchedule = RUN_SCHEDULE.CONTINUOUS;
  }

  const maxRuns = spec.maxRuns;

  return {
   name,
   description: spec.description ?? "",
   command: command ?? null,
   prompt: prompt ?? null,
   emitterType,
   runSchedule,
   every,
   everyMs,
   everySchedule,
   everyScheduleMs,
   requestedCwd: spec.cwd ?? null,
   cwd: resolveRequestedCwd(baseCwd, spec.cwd),
   stream: spec.channel,
   autoStart: spec.autoStart,
   includeStderr: spec.includeStderr,
   lifespan,
   ownership,
   eventFilter,
   maxRuns,
   startedAt: nowIso(),
   stoppedAt: null,
   lineCount: 0,
   droppedLineCount: 0,
   status: runSchedule === RUN_SCHEDULE.CONTINUOUS ? EMITTER_STATUS.RUNNING : EMITTER_STATUS.QUEUED,
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
