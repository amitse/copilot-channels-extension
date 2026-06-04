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

function scheduleDelay(state) {
  if (state.runSchedule === RUN_SCHEDULE.IDLE) {
    return IDLE_PROMPT_DELAY_MS;
  }
  if (Array.isArray(state.everyScheduleMs) && state.everyScheduleMs.length > 0) {
    const index = Math.min(Math.max(0, (state.runCount ?? 0) - 1), state.everyScheduleMs.length - 1);
    return state.everyScheduleMs[index];
  }
  return state.everyMs ?? 0;
}

function buildCompleteMessage(state) {
  if (state.runSchedule === RUN_SCHEDULE.ONE_TIME) {
    return `Emitter '${state.name}' completed one run of ${state.emitterType} work.`;
  }
  if (state.maxRuns && state.runCount >= state.maxRuns) {
    return `Emitter '${state.name}' completed ${state.runCount} of ${state.maxRuns} runs.`;
  }
  return null;
}

export function computeTransition(currentState, event) {
  const state = { ...currentState };
  const actions = [];
  const type = event?.type;

  if (type === LIFECYCLE_EVENT.START) {
    if (state.runSchedule === RUN_SCHEDULE.CONTINUOUS) {
      return {
        currentState,
        nextState: { ...state, status: EMITTER_STATUS.RUNNING },
        actions
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

  if (type === LIFECYCLE_EVENT.STOP) {
    if (isTerminalEmitterStatus(state.status)) {
      return { currentState, nextState: state, actions };
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

  if (type === LIFECYCLE_EVENT.SESSION_IDLE) {
    const eligible = !state.stopRequested && !state.inFlight && state.runSchedule === RUN_SCHEDULE.IDLE && !isTerminalEmitterStatus(state.status);
    if (!eligible) {
      return { currentState, nextState: state, actions };
    }
    return {
      currentState,
      nextState: { ...state, status: EMITTER_STATUS.WAITING },
      actions: [{ type: LIFECYCLE_ACTION.SCHEDULE_TIMER, delayMs: IDLE_PROMPT_DELAY_MS }]
    };
  }

  if (type === LIFECYCLE_EVENT.SESSION_ACTIVITY) {
    const eligible = state.runSchedule === RUN_SCHEDULE.IDLE && !isTerminalEmitterStatus(state.status);
    if (!eligible) {
      return { currentState, nextState: state, actions };
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

  if (type === LIFECYCLE_EVENT.ITERATION_RESULT) {
    const result = event?.result ?? { ok: false };
    if (state.stopRequested) {
      return {
        currentState,
        nextState: { ...state, status: EMITTER_STATUS.STOPPED, stoppedAt: event?.timestamp ?? null },
        actions: [{ type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text: `Emitter '${state.name}' stopped.` }]
      };
    }

    if (result.ok) {
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

    if (result.deferred) {
      const actions = [
        { type: LIFECYCLE_ACTION.SCHEDULE_TIMER, delayMs: state.runSchedule === RUN_SCHEDULE.IDLE ? IDLE_PROMPT_BACKOFF_MS : scheduleDelay(state) }
      ];
      if (state.runSchedule !== RUN_SCHEDULE.IDLE) {
        actions.push({
          type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE,
          text: `Emitter '${state.name}' deferred this prompt run because the session was still busy. Next attempt in ${state.every}.`
        });
      }
      return {
        currentState,
        nextState: { ...state, status: EMITTER_STATUS.WAITING },
        actions
      };
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

  return { currentState, nextState: state, actions };
}

export function identifyActions(transition) {
  return Array.isArray(transition?.actions) ? transition.actions : [];
}
