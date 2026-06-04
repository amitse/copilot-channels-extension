import test from "node:test";
import assert from "node:assert/strict";

import { computeTransition, identifyActions, GATEWAY_EVENT, GATEWAY_ACTION } from "./gateway-state.mjs";

test("gateway transition starts and reloads deterministically", () => {
  const started = computeTransition(
    { running: false, reloadPending: false, reloadTimerActive: false, token: null },
    { type: GATEWAY_EVENT.START, token: "ptk-x" }
  );

  assert.equal(started.nextState.running, true);
  assert.equal(identifyActions(started)[0].type, GATEWAY_ACTION.SET_TOKEN);

  const reloaded = computeTransition(
    started.nextState,
    { type: GATEWAY_EVENT.SCHEDULE_RELOAD, delayMs: 10 }
  );

  assert.equal(reloaded.nextState.reloadPending, true);
  assert.equal(identifyActions(reloaded)[0].type, GATEWAY_ACTION.SCHEDULE_TIMER);
});
