import { EMITTER_STATUS, EMITTER_TYPE, RUN_SCHEDULE, RUN_STATUS, SOURCE, STREAM, IDLE_PROMPT_DELAY_MS } from "../consts.mjs";
import { nowIso } from "../util/time.mjs";
import { isTerminalEmitterStatus } from "../util/policy.mjs";
import { describeEmitterWork } from "../format/emitter.mjs";
import { readLines, spawnEmitterProcess } from "./spawn.mjs";
import { LifecycleError } from "../errors/index.mjs";
import { computeTransition, identifyActions, LIFECYCLE_ACTION, LIFECYCLE_EVENT } from "./lifecycle-state.mjs";

function createDefaultTimerAdapter() {
  return {
    schedule(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    cancel(timerId) {
      clearTimeout(timerId);
    }
  };
}

function createDefaultProcessAdapter() {
  return {
    spawn(command, cwd) {
      return spawnEmitterProcess(command, cwd);
    },
    terminate(child) {
      child?.kill?.();
    },
    readLines
  };
}

function createDefaultLoggerAdapter(sessionPort) {
  return {
    log(message, options) {
      return sessionPort.log(message, options);
    }
  };
}

function snapshotEmitter(emitter) {
  return {
    name: emitter.name,
    emitterType: emitter.emitterType,
    runSchedule: emitter.runSchedule,
    every: emitter.every,
    everyMs: emitter.everyMs,
    everyScheduleMs: emitter.everyScheduleMs,
    maxRuns: emitter.maxRuns,
    runCount: emitter.runCount,
    status: emitter.status,
    stopRequested: emitter.stopRequested,
    inFlight: emitter.inFlight,
    command: emitter.command,
    cwd: emitter.cwd,
    prompt: emitter.prompt,
    process: emitter.process
  };
}

function applyState(emitter, nextState) {
  Object.assign(emitter, nextState);
}

function runAction(emitter, action, context) {
  switch (action.type) {
    case LIFECYCLE_ACTION.CLEAR_TIMER:
      if (emitter.timer) {
        context.timerAdapter.cancel(emitter.timer);
        emitter.timer = null;
      }
      return;
    case LIFECYCLE_ACTION.SCHEDULE_TIMER:
      scheduleIteration(emitter, context, action.delayMs ?? 0);
      return;
    case LIFECYCLE_ACTION.LOG_MESSAGE:
      void context.loggerAdapter.log(action.message, action.options);
      return;
    case LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE:
      context.lineRouter.appendSystemMessage(emitter, action.text, action.notify === true);
      return;
    case LIFECYCLE_ACTION.SET_STOP_REQUESTED:
      emitter.stopRequested = action.value === true;
      return;
    default:
      return;
  }
}

function scheduleIteration(emitter, context, delayMs = 0) {
  if (emitter.stopRequested) {
    return;
  }

  if (emitter.timer) {
    context.timerAdapter.cancel(emitter.timer);
  }

  emitter.status = delayMs > 0 ? EMITTER_STATUS.WAITING : EMITTER_STATUS.QUEUED;
  emitter.timer = context.timerAdapter.schedule(() => {
    emitter.timer = null;
    void runScheduledIteration(emitter, context);
  }, delayMs);
}

function wireStreams(emitter, context) {
  const child = emitter.process;
  emitter.stdoutReader = context.processAdapter.readLines(child.stdout, (line) => {
    context.lineRouter.handleLine(emitter, line, STREAM.STDOUT, SOURCE.EMITTER);
  });
  emitter.stderrReader = context.processAdapter.readLines(child.stderr, (line) => {
    context.lineRouter.handleLine(emitter, line, STREAM.STDERR, SOURCE.EMITTER_STDERR);
  });
}

function closeStreams(emitter) {
  if (emitter.stdoutReader) {
    emitter.stdoutReader.close();
    emitter.stdoutReader = null;
  }
  if (emitter.stderrReader) {
    emitter.stderrReader.close();
    emitter.stderrReader = null;
  }
}

function startContinuousProcess(emitter, context) {
  let child;
  try {
    child = context.processAdapter.spawn(emitter.command, emitter.cwd);
  } catch (error) {
    throw new LifecycleError(`Failed to start emitter '${emitter.name}': ${error.message}`, {
      cause: error,
      context: { emitter: emitter.name, command: emitter.command, cwd: emitter.cwd },
      retryable: true
    });
  }

  emitter.process = child;
  emitter.status = EMITTER_STATUS.RUNNING;
  wireStreams(emitter, context);

  child.on("error", (error) => {
    emitter.status = EMITTER_STATUS.ERROR;
    emitter.process = null;
    context.lineRouter.appendSystemMessage(emitter, `Emitter '${emitter.name}' failed: ${error.message}`, true);
    void context.loggerAdapter.log(`Emitter '${emitter.name}' failed: ${error.message}`, { level: "warning" });
  });

  child.on("exit", (code, signal) => {
    emitter.status = emitter.stopRequested ? EMITTER_STATUS.STOPPED : EMITTER_STATUS.EXITED;
    emitter.exitCode = code;
    emitter.stoppedAt = nowIso();
    emitter.process = null;
    emitter.stdoutReader = null;
    emitter.stderrReader = null;

    const exitMessage = emitter.stopRequested
      ? `Emitter '${emitter.name}' stopped.`
      : `Emitter '${emitter.name}' exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`;
    context.lineRouter.appendSystemMessage(emitter, exitMessage, !emitter.stopRequested);
    void context.loggerAdapter.log(exitMessage);
  });

  context.lineRouter.appendSystemMessage(
    emitter,
    `Emitter '${emitter.name}' started with ${describeEmitterWork(emitter)}.`
  );
}

async function runCommandLoopIteration(emitter, context) {
  let child;
  try {
    child = context.processAdapter.spawn(emitter.command, emitter.cwd);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  emitter.process = child;
  wireStreams(emitter, context);

  return await new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;

      closeStreams(emitter);
      emitter.process = null;
      emitter.exitCode = result.code ?? emitter.exitCode;
      resolve(result);
    };

    child.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });

    child.on("exit", (code, signal) => {
      finish({
        ok: (code ?? 0) === 0 || emitter.stopRequested,
        code,
        signal,
        error: (code ?? 0) === 0 || emitter.stopRequested
          ? null
          : `Command iteration exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`
      });
    });
  });
}

async function runPromptIteration(emitter, context) {
  try {
    await context.sessionPort.send(emitter.prompt);

    if (emitter.stopRequested) {
      return { ok: true };
    }

    emitter.lineCount += 1;
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      deferred:
        (emitter.runSchedule === RUN_SCHEDULE.TIMED || emitter.runSchedule === RUN_SCHEDULE.IDLE) &&
        /\bsession\.idle\b/i.test(String(error?.message ?? ""))
    };
  }
}

async function runScheduledIteration(emitter, context) {
  if (emitter.stopRequested || emitter.inFlight) {
    return;
  }

  if (emitter.runSchedule === RUN_SCHEDULE.IDLE && !context.sessionPort.isIdle()) {
    emitter.status = EMITTER_STATUS.WAITING;
    return;
  }

  emitter.inFlight = true;
  emitter.status = EMITTER_STATUS.RUNNING;
  emitter.runCount += 1;
  emitter.lastRunAt = nowIso();

  const result = emitter.emitterType === EMITTER_TYPE.PROMPT
    ? await runPromptIteration(emitter, context)
    : await runCommandLoopIteration(emitter, context);

  emitter.inFlight = false;

  const transition = computeTransition(snapshotEmitter(emitter), {
    type: LIFECYCLE_EVENT.ITERATION_RESULT,
    result,
    timestamp: nowIso()
  });
  applyState(emitter, transition.nextState);
  for (const action of identifyActions(transition)) {
    runAction(emitter, action, context);
  }

  if (emitter.stopRequested) {
    emitter.status = EMITTER_STATUS.STOPPED;
    emitter.stoppedAt = nowIso();
    context.lineRouter.appendSystemMessage(emitter, `Emitter '${emitter.name}' stopped.`);
    return;
  }

  if (result.ok) {
    emitter.lastRunStatus = RUN_STATUS.SUCCESS;
    if (emitter.runSchedule === RUN_SCHEDULE.IDLE) {
      emitter.status = EMITTER_STATUS.WAITING;
      return;
    }
    return;
  }

  if (result.deferred) {
    emitter.status = EMITTER_STATUS.WAITING;
    if (emitter.runSchedule !== RUN_SCHEDULE.IDLE) {
      context.lineRouter.appendSystemMessage(
        emitter,
        `Emitter '${emitter.name}' deferred this prompt run because the session was still busy. Next attempt in ${emitter.every}.`
      );
    }
    return;
  }

  emitter.lastRunStatus = RUN_STATUS.FAILURE;
  if (emitter.runSchedule === RUN_SCHEDULE.ONE_TIME) {
    emitter.status = EMITTER_STATUS.ERROR;
    emitter.stoppedAt = nowIso();
    return;
  }

  emitter.status = EMITTER_STATUS.WAITING;
}

export function createLifecycle({
  lineRouter,
  sessionPort,
  timerAdapter = createDefaultTimerAdapter(),
  processAdapter = createDefaultProcessAdapter(),
  loggerAdapter = createDefaultLoggerAdapter(sessionPort)
}) {
  function start(emitter) {
    if (emitter.runSchedule === RUN_SCHEDULE.CONTINUOUS) {
      startContinuousProcess(emitter, { lineRouter, processAdapter, loggerAdapter });
      return;
    }

    contextStartScheduled(emitter);
  }

  function contextStartScheduled(emitter) {
    const scheduleLabel = emitter.runSchedule === RUN_SCHEDULE.TIMED
      ? (emitter.everySchedule ? `backoff [${emitter.everySchedule.join(", ")}]` : `every ${emitter.every}`)
      : emitter.runSchedule === RUN_SCHEDULE.IDLE
        ? "when idle"
        : RUN_SCHEDULE.ONE_TIME;
    lineRouter.appendSystemMessage(
      emitter,
      `Emitter '${emitter.name}' queued ${emitter.emitterType} work (${scheduleLabel}) with ${describeEmitterWork(emitter)}.`
    );

    const transition = computeTransition(snapshotEmitter(emitter), { type: LIFECYCLE_EVENT.START });
    applyState(emitter, transition.nextState);
    for (const action of identifyActions(transition)) {
      runAction(emitter, action, { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort });
    }

    if (emitter.runSchedule === RUN_SCHEDULE.IDLE) {
      if (sessionPort.isIdle()) {
        scheduleIteration(emitter, { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort }, IDLE_PROMPT_DELAY_MS);
      }
      return;
    }

    scheduleIteration(emitter, { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort }, 0);
  }

  async function stop(emitter) {
    const transition = computeTransition(snapshotEmitter(emitter), { type: LIFECYCLE_EVENT.STOP, timestamp: nowIso() });
    applyState(emitter, transition.nextState);
    for (const action of identifyActions(transition)) {
      runAction(emitter, action, { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort });
    }

    if (isTerminalEmitterStatus(emitter.status)) {
      return;
    }

    emitter.stopRequested = true;
    void sessionPort.log(`Stop requested for emitter '${emitter.name}'.`);

    if (!emitter.process && !emitter.inFlight) {
      emitter.status = EMITTER_STATUS.STOPPED;
      emitter.stoppedAt = nowIso();
      lineRouter.appendSystemMessage(emitter, `Emitter '${emitter.name}' stopped.`);
      void sessionPort.log(`Emitter '${emitter.name}' stopped.`);
      return;
    }

    emitter.status = EMITTER_STATUS.STOPPING;
    closeStreams(emitter);

    if (emitter.process) {
      processAdapter.terminate(emitter.process);
    }
  }

  function onSessionIdle(emitter) {
    const transition = computeTransition(snapshotEmitter(emitter), { type: LIFECYCLE_EVENT.SESSION_IDLE });
    applyState(emitter, transition.nextState);
    for (const action of identifyActions(transition)) {
      runAction(emitter, action, { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort });
    }
  }

  function onSessionActivity(emitter) {
    const transition = computeTransition(snapshotEmitter(emitter), { type: LIFECYCLE_EVENT.SESSION_ACTIVITY });
    applyState(emitter, transition.nextState);
    for (const action of identifyActions(transition)) {
      runAction(emitter, action, { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort });
    }
  }

  return { start, stop, onSessionIdle, onSessionActivity };
}
