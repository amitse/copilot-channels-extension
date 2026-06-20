import {
  EMITTER_STATUS,
  RUN_SCHEDULE,
  RUN_STATUS,
  IDLE_PROMPT_BACKOFF_MS,
  IDLE_PROMPT_DELAY_MS
} from "../consts.mjs";
import { isTerminalEmitterStatus } from "../util/policy.mjs";

export const LIFECYCLE_EVENT = Object.freeze({
  START: "start",
  STOP: "stop",
  SESSION_IDLE: "session.idle",
  SESSION_ACTIVITY: "session.activity",
  ITERATION_RESULT: "iteration.result"
});

export const LIFECYCLE_ACTION = Object.freeze({
  SET_STATUS: "setStatus",
  SET_STOP_REQUESTED: "setStopRequested",
  CLEAR_TIMER: "clearTimer",
  SCHEDULE_TIMER: "scheduleTimer",
  LOG_MESSAGE: "logMessage",
  APPEND_SYSTEM_MESSAGE: "appendSystemMessage"
});

function scheduleIndex(state, length) {
  return Math.min(Math.max(0, (state.runCount ?? 0) - 1), length - 1);
}

function scheduleDelay(state) {
  if (state.runSchedule === RUN_SCHEDULE.IDLE) {
    return IDLE_PROMPT_DELAY_MS;
  }
  if (Array.isArray(state.everyScheduleMs) && state.everyScheduleMs.length > 0) {
    const index = scheduleIndex(state, state.everyScheduleMs.length);
    return state.everyScheduleMs[index];
  }
  return state.everyMs ?? 0;
}

function scheduleLabel(state) {
  if (Array.isArray(state.everySchedule) && state.everySchedule.length > 0) {
    const index = Array.isArray(state.everyScheduleMs) && state.everyScheduleMs.length > 0
      ? scheduleIndex(state, state.everyScheduleMs.length)
      : scheduleIndex(state, state.everySchedule.length);
    const label = state.everySchedule[index];
    if (label !== undefined && label !== null && String(label).trim() !== "") {
      return String(label).trim();
    }
  }

  if (state.every !== undefined && state.every !== null && String(state.every).trim() !== "") {
    return String(state.every).trim();
  }

  return `${scheduleDelay(state)}ms`;
}

function buildCompleteMessage(state) {
  if (state.runSchedule === RUN_SCHEDULE.ONE_TIME) {
    return `Emitter '${state.name}' completed one run of ${state.emitterType} work.`;
  }
  if (state.maxRuns && state.runCount >= state.maxRuns) {
    return `Emitter '${state.name}' reached its run budget (${state.runCount} of ${state.maxRuns} runs). This stops the emitter; goal-style loops must use their final evidence summary to decide whether the objective is complete.`;
  }
  return null;
}

function buildRunBudgetExhaustedMessage(state, result) {
  const budget = `${state.runCount} of ${state.maxRuns}`;
  if (result?.deferred) {
    return `Emitter '${state.name}' exhausted its run budget (${budget} attempts) after a deferred prompt run.`;
  }

  return `Emitter '${state.name}' exhausted its run budget (${budget} attempts) after iteration failed: ${result?.error ?? "unknown error"}.`;
}

function isRunBudgetExhausted(state) {
  return Boolean(state.maxRuns && state.runCount >= state.maxRuns);
}

function buildStopCompletionActions(state) {
  const text = `Emitter '${state.name}' stopped.`;
  return [
    { type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text },
    // Preserve the pre-centralization stream/session contract: completing an
    // in-flight scheduled stop produced a second identical stop system message.
    { type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text }
  ];
}

function buildNoopTransition(currentState, state) {
  return { currentState, nextState: state, actions: [] };
}

function computeStartTransition(currentState, state, event) {
  if (state.runSchedule === RUN_SCHEDULE.CONTINUOUS) {
    return {
      currentState,
      nextState: { ...state, status: EMITTER_STATUS.RUNNING },
      actions: []
    };
  }
  const startStatus = state.runSchedule === RUN_SCHEDULE.IDLE
    ? EMITTER_STATUS.WAITING
    : EMITTER_STATUS.QUEUED;
  return {
    currentState,
    nextState: { ...state, status: startStatus },
    actions: [
      { type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text: event?.message }
    ].filter((action) => action.text)
  };
}

function computeStopTransition(currentState, state, event) {
  if (isTerminalEmitterStatus(state.status)) {
    return buildNoopTransition(currentState, state);
  }
  if (!state.process && !state.inFlight) {
    return {
      currentState,
      nextState: { ...state, status: EMITTER_STATUS.STOPPED, stoppedAt: event?.timestamp ?? null },
      actions: [
        { type: LIFECYCLE_ACTION.CLEAR_TIMER },
        { type: LIFECYCLE_ACTION.LOG_MESSAGE, message: `Emitter '${state.name}' stopped.` },
        { type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text: `Emitter '${state.name}' stopped.` }
      ]
    };
  }
  return {
    currentState,
    nextState: { ...state, status: EMITTER_STATUS.STOPPING, stopRequested: true },
    actions: [
      { type: LIFECYCLE_ACTION.SET_STOP_REQUESTED, value: true },
      { type: LIFECYCLE_ACTION.CLEAR_TIMER }
    ]
  };
}

function computeSessionIdleTransition(currentState, state) {
  const eligible = !state.stopRequested && !state.inFlight && state.runSchedule === RUN_SCHEDULE.IDLE && !isTerminalEmitterStatus(state.status);
  if (!eligible) {
    return buildNoopTransition(currentState, state);
  }
  return {
    currentState,
    nextState: { ...state, status: EMITTER_STATUS.WAITING },
    actions: [{ type: LIFECYCLE_ACTION.SCHEDULE_TIMER, delayMs: IDLE_PROMPT_DELAY_MS }]
  };
}

function computeSessionActivityTransition(currentState, state) {
  const eligible = state.runSchedule === RUN_SCHEDULE.IDLE && !isTerminalEmitterStatus(state.status);
  if (!eligible) {
    return buildNoopTransition(currentState, state);
  }
  const nextState = { ...state };
  if (!state.inFlight) {
    nextState.status = EMITTER_STATUS.WAITING;
  }
  return {
    currentState,
    nextState,
    actions: [{ type: LIFECYCLE_ACTION.CLEAR_TIMER }]
  };
}

function computeSuccessfulIterationTransition(currentState, state, event) {
  const completionMessage = buildCompleteMessage(state);
  if (completionMessage) {
    return {
      currentState,
      nextState: {
        ...state,
        status: EMITTER_STATUS.COMPLETED,
        stoppedAt: event?.timestamp ?? null,
        lastRunStatus: RUN_STATUS.SUCCESS
      },
      actions: [{ type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text: completionMessage }]
    };
  }

  if (state.runSchedule === RUN_SCHEDULE.IDLE) {
    return {
      currentState,
      nextState: { ...state, status: EMITTER_STATUS.WAITING, lastRunStatus: RUN_STATUS.SUCCESS },
      actions: []
    };
  }

  return {
    currentState,
    nextState: { ...state, status: EMITTER_STATUS.WAITING, lastRunStatus: RUN_STATUS.SUCCESS },
    actions: [
      { type: LIFECYCLE_ACTION.SCHEDULE_TIMER, delayMs: scheduleDelay(state) }
    ]
  };
}

function computeRunBudgetExhaustedTransition(currentState, state, event, result) {
  const message = buildRunBudgetExhaustedMessage(state, result);
  return {
    currentState,
    nextState: {
      ...state,
      status: EMITTER_STATUS.ERROR,
      lastRunStatus: RUN_STATUS.FAILURE,
      stoppedAt: event?.timestamp ?? null
    },
    actions: [
      { type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text: message },
      { type: LIFECYCLE_ACTION.LOG_MESSAGE, message }
    ]
  };
}

function computeDeferredIterationTransition(currentState, state) {
  const actions = [
    { type: LIFECYCLE_ACTION.SCHEDULE_TIMER, delayMs: state.runSchedule === RUN_SCHEDULE.IDLE ? IDLE_PROMPT_BACKOFF_MS : scheduleDelay(state) }
  ];
  if (state.runSchedule !== RUN_SCHEDULE.IDLE) {
    actions.push({
      type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE,
      text: `Emitter '${state.name}' deferred this prompt run because the session was still busy. Next attempt in ${scheduleLabel(state)}.`
    });
  }
  return {
    currentState,
    nextState: { ...state, status: EMITTER_STATUS.WAITING },
    actions
  };
}

function computeFailedIterationTransition(currentState, state, event, result) {
  if (result.deferred) {
    return computeDeferredIterationTransition(currentState, state);
  }

  if (isRunBudgetExhausted(state)) {
    return computeRunBudgetExhaustedTransition(currentState, state, event, result);
  }

  if (state.runSchedule === RUN_SCHEDULE.ONE_TIME) {
    return {
      currentState,
      nextState: { ...state, status: EMITTER_STATUS.ERROR, lastRunStatus: RUN_STATUS.FAILURE, stoppedAt: event?.timestamp ?? null },
      actions: [{ type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text: `Emitter '${state.name}' iteration failed: ${result.error ?? "unknown error"}.` }]
    };
  }

  return {
    currentState,
    nextState: { ...state, status: EMITTER_STATUS.WAITING, lastRunStatus: RUN_STATUS.FAILURE },
    actions: [
      { type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text: `Emitter '${state.name}' iteration failed: ${result.error ?? "unknown error"}.` },
      { type: LIFECYCLE_ACTION.LOG_MESSAGE, message: `Emitter '${state.name}' iteration failed: ${result.error ?? "unknown error"}.` },
      { type: LIFECYCLE_ACTION.SCHEDULE_TIMER, delayMs: state.runSchedule === RUN_SCHEDULE.IDLE ? IDLE_PROMPT_BACKOFF_MS : scheduleDelay(state) }
    ]
  };
}

function computeIterationResultTransition(currentState, state, event) {
  const result = event?.result ?? { ok: false };
  if (state.stopRequested) {
    return {
      currentState,
      nextState: { ...state, status: EMITTER_STATUS.STOPPED, stoppedAt: event?.timestamp ?? null },
      actions: buildStopCompletionActions(state)
    };
  }

  if (result.ok) {
    return computeSuccessfulIterationTransition(currentState, state, event);
  }

  return computeFailedIterationTransition(currentState, state, event, result);
}

export function computeTransition(currentState, event) {
  const state = { ...currentState };
  const type = event?.type;

  if (type === LIFECYCLE_EVENT.START) {
    return computeStartTransition(currentState, state, event);
  }

  if (type === LIFECYCLE_EVENT.STOP) {
    return computeStopTransition(currentState, state, event);
  }

  if (type === LIFECYCLE_EVENT.SESSION_IDLE) {
    return computeSessionIdleTransition(currentState, state);
  }

  if (type === LIFECYCLE_EVENT.SESSION_ACTIVITY) {
    return computeSessionActivityTransition(currentState, state);
  }

  if (type === LIFECYCLE_EVENT.ITERATION_RESULT) {
    return computeIterationResultTransition(currentState, state, event);
  }

  return buildNoopTransition(currentState, state);
}

export function identifyActions(transition) {
  return Array.isArray(transition?.actions) ? transition.actions : [];
}
