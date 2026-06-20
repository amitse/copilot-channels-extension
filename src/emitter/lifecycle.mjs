import { EMITTER_STATUS, EMITTER_TYPE, RUN_SCHEDULE, SOURCE, STREAM, IDLE_PROMPT_DELAY_MS } from "../consts.mjs";
import { nowIso } from "../util/time.mjs";
import { isTerminalEmitterStatus } from "../util/policy.mjs";
import { describeEmitterWork } from "../format/emitter.mjs";
import { readLines, spawnEmitterProcess } from "./spawn.mjs";
import { LifecycleError } from "../errors/index.mjs";
import { computeTransition, identifyActions, LIFECYCLE_ACTION, LIFECYCLE_EVENT } from "./lifecycle-state.mjs";
import { createDefaultTimerAdapter } from "../util/timer-adapter.mjs";

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

const SESSION_ATTACH_RETRY_MS = 100;
const DEFAULT_STOP_WAIT_TIMEOUT_MS = 10_000;
const STOP_WAIT_POLL_MS = 50;

function errorMessage(error) {
  return error?.message ?? String(error ?? "unknown error");
}

function createDefaultLoggerAdapter(sessionPort) {
  return {
    log(message, options) {
      return sessionPort.log(message, options);
    }
  };
}

function safeAdapterLog(loggerAdapter, message, options = {}) {
  try {
    void Promise.resolve(loggerAdapter?.log?.(message, options)).catch(() => {});
  } catch {
    // Logging must never interrupt lifecycle transitions.
  }
}

function snapshotEmitter(emitter) {
  return {
    name: emitter.name,
    emitterType: emitter.emitterType,
    runSchedule: emitter.runSchedule,
    every: emitter.every,
    everySchedule: emitter.everySchedule,
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

function shouldRouteCommandOutput(emitter, stream) {
  if (stream === STREAM.STDERR) {
    return emitter.includeStderr !== false;
  }

  return true;
}

function isSessionAttached(sessionPort) {
  if (typeof sessionPort?.isAttached === "function") {
    return sessionPort.isAttached() === true;
  }
  if (typeof sessionPort?.current === "function") {
    return Boolean(sessionPort.current());
  }

  return true;
}

function isSessionNotAttachedMessage(message) {
  return /session is not attached|session[^.]*not attached/i.test(String(message ?? ""));
}

function shouldWaitForSessionAttach(emitter, context) {
  return emitter.emitterType === EMITTER_TYPE.PROMPT &&
    emitter.runSchedule !== RUN_SCHEDULE.IDLE &&
    !isSessionAttached(context.sessionPort);
}

function scheduleSessionAttachRetry(emitter, context) {
  scheduleIteration(emitter, context, SESSION_ATTACH_RETRY_MS);
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
      safeAdapterLog(context.loggerAdapter, action.message, action.options);
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

function applyLifecycleTransition(emitter, event, context) {
  const transition = computeTransition(snapshotEmitter(emitter), event);
  applyState(emitter, transition.nextState);
  for (const action of identifyActions(transition)) {
    runAction(emitter, action, context);
  }
  return transition;
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
    void runScheduledIteration(emitter, context).catch((error) => {
      emitter.inFlight = false;
      recordEscapedScheduledIterationFailure(emitter, error, context);
    });
  }, delayMs);
}

function wireStreams(emitter, context) {
  const child = emitter.process;
  emitter.stdoutReader = context.processAdapter.readLines(child.stdout, (line) => {
    context.lineRouter.handleLine(emitter, line, STREAM.STDOUT, SOURCE.EMITTER);
  });
  emitter.stderrReader = context.processAdapter.readLines(child.stderr, (line) => {
    // Keep consuming stderr to avoid process back-pressure, but only route it
    // when the command emitter policy allows stderr through to filtering.
    if (!shouldRouteCommandOutput(emitter, STREAM.STDERR)) {
      return;
    }

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
  let exitResult = null;
  let finalized = false;

  const finalizeExit = (code, signal) => {
    if (finalized) {
      return;
    }
    finalized = true;

    closeStreams(emitter);
    emitter.status = emitter.stopRequested ? EMITTER_STATUS.STOPPED : EMITTER_STATUS.EXITED;
    emitter.exitCode = code;
    emitter.stoppedAt = nowIso();
    emitter.process = null;

    const exitMessage = emitter.stopRequested
      ? `Emitter '${emitter.name}' stopped.`
      : `Emitter '${emitter.name}' exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`;
    context.lineRouter.appendSystemMessage(emitter, exitMessage, !emitter.stopRequested);
    safeAdapterLog(context.loggerAdapter, exitMessage);
  };

  child.on("error", (error) => {
    if (finalized) {
      return;
    }
    finalized = true;
    closeStreams(emitter);
    emitter.status = EMITTER_STATUS.ERROR;
    emitter.process = null;
    emitter.stoppedAt = nowIso();
    context.lineRouter.appendSystemMessage(emitter, `Emitter '${emitter.name}' failed: ${error.message}`, true);
    safeAdapterLog(context.loggerAdapter, `Emitter '${emitter.name}' failed: ${error.message}`, { level: "warning" });
  });

  child.on("exit", (code, signal) => {
    exitResult = { code, signal };
  });

  child.on("close", (code, signal) => {
    finalizeExit(
      code === undefined ? exitResult?.code : code,
      signal === undefined ? exitResult?.signal : signal
    );
  });

  try {
    wireStreams(emitter, context);
    context.lineRouter.appendSystemMessage(
      emitter,
      `Emitter '${emitter.name}' started with ${describeEmitterWork(emitter)}.`
    );
  } catch (error) {
    finalized = true;
    closeStreams(emitter);
    emitter.status = EMITTER_STATUS.ERROR;
    emitter.process = null;
    emitter.stoppedAt = nowIso();

    try {
      context.processAdapter.terminate(child);
    } catch (terminateError) {
      safeAdapterLog(
        context.loggerAdapter,
        `Failed to clean up emitter '${emitter.name}' after start failure: ${errorMessage(terminateError)}`,
        { level: "warning" }
      );
    }

    const message = errorMessage(error);
    const failureMessage = `Emitter '${emitter.name}' failed to start: ${message}`;
    try {
      context.lineRouter.appendSystemMessage(emitter, `${failureMessage}.`, true);
    } catch {
      // Setup failures must still unwind even if reporting the failure fails.
    }
    safeAdapterLog(context.loggerAdapter, failureMessage, { level: "warning" });
    throw new LifecycleError(`Failed to start emitter '${emitter.name}': ${message}`, {
      cause: error,
      context: { emitter: emitter.name, command: emitter.command, cwd: emitter.cwd },
      retryable: true
    });
  }
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

    const buildCloseResult = (code, signal) => {
      const stopped = emitter.stopRequested === true;
      const ok = stopped || (code === 0 && !signal);
      return {
        ok,
        code,
        signal,
        error: ok
          ? null
          : `Command iteration exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`
      };
    };

    child.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });

    // Use 'close' instead of 'exit' so readline has a chance to drain the
    // child's stdio streams before the scheduled iteration is considered done.
    child.on("close", (code, signal) => {
      finish(buildCloseResult(code, signal));
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
    const message = error?.message ?? String(error ?? "unknown error");
    const sessionNotAttached = isSessionNotAttachedMessage(message);
    const deferred =
      sessionNotAttached ||
      (emitter.runSchedule === RUN_SCHEDULE.TIMED || emitter.runSchedule === RUN_SCHEDULE.IDLE) &&
      /\bsession\.idle\b/i.test(message);
    return {
      ok: false,
      error: message,
      deferred,
      consumeRun: deferred ? false : true,
      deferredReason: sessionNotAttached ? "session-not-attached" : null
    };
  }
}

function cleanupFailedScheduledProcess(emitter, context) {
  closeStreams(emitter);
  if (!emitter.process) {
    return;
  }

  const child = emitter.process;
  emitter.process = null;
  try {
    context.processAdapter.terminate(child);
  } catch {
    // Best-effort cleanup for unexpected scheduled iteration failures.
  }
}

function recordEscapedScheduledIterationFailure(emitter, error, context) {
  const message = errorMessage(error);
  cleanupFailedScheduledProcess(emitter, context);
  if (!isTerminalEmitterStatus(emitter.status)) {
    emitter.status = EMITTER_STATUS.ERROR;
    emitter.stoppedAt = nowIso();
  }
  const logMessage = `Emitter '${emitter.name}' scheduled iteration failed unexpectedly: ${message}`;
  try {
    context.lineRouter.appendSystemMessage(emitter, `${logMessage}.`);
  } catch {
    // Keep the escaped rejection handler non-throwing.
  }
  safeAdapterLog(context.loggerAdapter, logMessage, { level: "warning" });
}

function recordScheduledTransitionFailure(emitter, error, context) {
  const message = errorMessage(error);
  if (!isTerminalEmitterStatus(emitter.status)) {
    emitter.status = EMITTER_STATUS.ERROR;
    emitter.stoppedAt = nowIso();
  }
  safeAdapterLog(
    context.loggerAdapter,
    `Emitter '${emitter.name}' failed to record scheduled iteration result: ${message}`,
    { level: "warning" }
  );
}

async function runScheduledIteration(emitter, context) {
  if (emitter.stopRequested || emitter.inFlight) {
    return;
  }

  if (emitter.runSchedule === RUN_SCHEDULE.IDLE && !context.sessionPort.isIdle()) {
    emitter.status = EMITTER_STATUS.WAITING;
    return;
  }

  if (shouldWaitForSessionAttach(emitter, context)) {
    scheduleSessionAttachRetry(emitter, context);
    return;
  }

  const previousRunCount = emitter.runCount;
  const previousLastRunAt = emitter.lastRunAt;
  emitter.inFlight = true;
  emitter.status = EMITTER_STATUS.RUNNING;
  emitter.runCount += 1;
  emitter.lastRunAt = nowIso();

  let result;
  try {
    result = emitter.emitterType === EMITTER_TYPE.PROMPT
      ? await runPromptIteration(emitter, context)
      : await runCommandLoopIteration(emitter, context);
  } catch (error) {
    const message = errorMessage(error);
    cleanupFailedScheduledProcess(emitter, context);
    safeAdapterLog(
      context.loggerAdapter,
      `Emitter '${emitter.name}' scheduled iteration failed unexpectedly: ${message}`,
      { level: "warning" }
    );
    result = { ok: false, error: message, consumeRun: true };
  }

  try {
    if (result?.consumeRun === false) {
      emitter.runCount = previousRunCount;
      emitter.lastRunAt = previousLastRunAt;
      if (emitter.stopRequested) {
        applyLifecycleTransition(emitter, {
          type: LIFECYCLE_EVENT.ITERATION_RESULT,
          result: { ok: true },
          timestamp: nowIso()
        }, context);
        return;
      }
      if (result.deferredReason === "session-not-attached") {
        scheduleSessionAttachRetry(emitter, context);
        return;
      }
    }

    applyLifecycleTransition(emitter, {
      type: LIFECYCLE_EVENT.ITERATION_RESULT,
      result,
      timestamp: nowIso()
    }, context);
  } catch (error) {
    recordScheduledTransitionFailure(emitter, error, context);
  } finally {
    emitter.inFlight = false;
  }
}

function isEmitterStopSettled(emitter) {
  return isTerminalEmitterStatus(emitter.status) || (!emitter.process && !emitter.inFlight);
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

    applyLifecycleTransition(
      emitter,
      { type: LIFECYCLE_EVENT.START },
      { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort }
    );

    if (emitter.runSchedule === RUN_SCHEDULE.IDLE) {
      if (sessionPort.isIdle()) {
        scheduleIteration(emitter, { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort }, IDLE_PROMPT_DELAY_MS);
      }
      return;
    }

    scheduleIteration(emitter, { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort }, 0);
  }

  async function stop(emitter) {
    applyLifecycleTransition(
      emitter,
      { type: LIFECYCLE_EVENT.STOP, timestamp: nowIso() },
      { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort }
    );

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

  async function stopAndWait(emitter, options = {}) {
    await stop(emitter);

    if (isEmitterStopSettled(emitter)) {
      return { name: emitter.name, status: emitter.status, timedOut: false, outcome: "stopped" };
    }

    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(0, options.timeoutMs)
      : DEFAULT_STOP_WAIT_TIMEOUT_MS;
    const pollMs = Number.isFinite(options.pollMs)
      ? Math.max(1, options.pollMs)
      : STOP_WAIT_POLL_MS;

    return await new Promise((resolve) => {
      let settled = false;
      let timeoutTimer = null;
      let pollTimer = null;
      let observedProcess = null;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      const onProcessClosed = () => {
        queueMicrotask(checkSettled);
      };

      const detachObservedProcess = () => {
        if (!observedProcess) {
          return;
        }
        if (typeof observedProcess.off === "function") {
          observedProcess.off("close", onProcessClosed);
          observedProcess.off("error", onProcessClosed);
        } else if (typeof observedProcess.removeListener === "function") {
          observedProcess.removeListener("close", onProcessClosed);
          observedProcess.removeListener("error", onProcessClosed);
        }
        observedProcess = null;
      };

      const attachObservedProcess = () => {
        const child = emitter.process;
        if (!child || child === observedProcess || typeof child.once !== "function") {
          return;
        }
        detachObservedProcess();
        observedProcess = child;
        child.once("close", onProcessClosed);
        child.once("error", onProcessClosed);
      };

      const clearPollTimer = () => {
        if (pollTimer) {
          timerAdapter.cancel(pollTimer);
          pollTimer = null;
        }
      };

      const cleanup = () => {
        if (timeoutTimer) {
          timerAdapter.cancel(timeoutTimer);
          timeoutTimer = null;
        }
        clearPollTimer();
        detachObservedProcess();
      };

      const schedulePoll = () => {
        clearPollTimer();
        pollTimer = timerAdapter.schedule(checkSettled, pollMs);
      };

      function checkSettled() {
        if (settled) {
          return;
        }
        if (isEmitterStopSettled(emitter)) {
          finish({ name: emitter.name, status: emitter.status, timedOut: false, outcome: "stopped" });
          return;
        }
        attachObservedProcess();
        schedulePoll();
      }

      timeoutTimer = timerAdapter.schedule(() => {
        const message = `Emitter '${emitter.name}' did not finish stopping within ${timeoutMs}ms during shutdown; abandoning wait.`;
        safeAdapterLog(loggerAdapter, message, { level: "warning" });
        finish({ name: emitter.name, status: emitter.status, timedOut: true, outcome: "timedOut" });
      }, timeoutMs);

      checkSettled();
    });
  }

  function onSessionIdle(emitter) {
    applyLifecycleTransition(
      emitter,
      { type: LIFECYCLE_EVENT.SESSION_IDLE },
      { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort }
    );
  }

  function onSessionActivity(emitter) {
    applyLifecycleTransition(
      emitter,
      { type: LIFECYCLE_EVENT.SESSION_ACTIVITY },
      { lineRouter, timerAdapter, processAdapter, loggerAdapter, sessionPort }
    );
  }

  return { start, stop, stopAndWait, onSessionIdle, onSessionActivity };
}
