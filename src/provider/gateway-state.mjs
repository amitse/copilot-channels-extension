export const GATEWAY_EVENT = Object.freeze({
  START: "start",
  STOP: "stop",
  SCHEDULE_RELOAD: "scheduleReload",
  RELOAD_FIRED: "reloadFired"
});

export const GATEWAY_ACTION = Object.freeze({
  SET_RUNNING: "setRunning",
  SET_TOKEN: "setToken",
  CLEAR_TOKEN: "clearToken",
  SCHEDULE_TIMER: "scheduleTimer",
  CANCEL_TIMER: "cancelTimer",
  REFRESH_TOOLS: "refreshTools"
});

export function computeTransition(currentState, event) {
  const state = { ...currentState };
  const actions = [];

  switch (event?.type) {
    case GATEWAY_EVENT.START:
      return {
        currentState,
        nextState: {
          ...state,
          running: true,
          reloadPending: false,
          token: event?.token ?? state.token
        },
        actions: [
          { type: GATEWAY_ACTION.SET_TOKEN, token: event?.token ?? state.token },
          { type: GATEWAY_ACTION.SET_RUNNING, value: true }
        ]
      };
    case GATEWAY_EVENT.STOP:
      return {
        currentState,
        nextState: {
          ...state,
          running: false,
          reloadPending: false,
          reloadTimerActive: false,
          token: null
        },
        actions: [
          { type: GATEWAY_ACTION.CANCEL_TIMER },
          { type: GATEWAY_ACTION.CLEAR_TOKEN },
          { type: GATEWAY_ACTION.SET_RUNNING, value: false }
        ]
      };
    case GATEWAY_EVENT.SCHEDULE_RELOAD:
      if (!state.running) {
        return { currentState, nextState: state, actions };
      }
      return {
        currentState,
        nextState: { ...state, reloadPending: true, reloadTimerActive: true },
        actions: [{ type: GATEWAY_ACTION.SCHEDULE_TIMER, delayMs: event?.delayMs ?? 0 }]
      };
    case GATEWAY_EVENT.RELOAD_FIRED:
      if (!state.running || !state.reloadPending) {
        return { currentState, nextState: state, actions };
      }
      return {
        currentState,
        nextState: { ...state, reloadPending: false, reloadTimerActive: false },
        actions: [{ type: GATEWAY_ACTION.REFRESH_TOOLS }]
      };
    default:
      return { currentState, nextState: state, actions };
  }
}

export function identifyActions(transition) {
  return Array.isArray(transition?.actions) ? transition.actions : [];
}
