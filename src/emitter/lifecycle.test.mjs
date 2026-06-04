import test from "node:test";
import assert from "node:assert/strict";

import { EMITTER_STATUS, EMITTER_TYPE, RUN_SCHEDULE, RUN_STATUS } from "../consts.mjs";
import { computeTransition, identifyActions, LIFECYCLE_EVENT, LIFECYCLE_ACTION } from "./lifecycle-state.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { createMockLoggerAdapter, createMockProcessAdapter, createMockTimerAdapter } from "../test-support/adapters.mjs";

test("lifecycle transition schedules timed rerun", () => {
  const transition = computeTransition(
    {
      name: "demo",
      emitterType: EMITTER_TYPE.PROMPT,
      runSchedule: RUN_SCHEDULE.TIMED,
      runCount: 1,
      everyScheduleMs: [100],
      status: EMITTER_STATUS.RUNNING
    },
    {
      type: LIFECYCLE_EVENT.ITERATION_RESULT,
      result: { ok: true }
    }
  );

  assert.equal(transition.nextState.status, EMITTER_STATUS.WAITING);
  assert.deepEqual(identifyActions(transition), [{ type: LIFECYCLE_ACTION.SCHEDULE_TIMER, delayMs: 100 }]);
  assert.equal(transition.nextState.lastRunStatus, RUN_STATUS.SUCCESS);
});

test("mock timer advances scheduled prompt emitter", async () => {
  const timerAdapter = createMockTimerAdapter();
  const processAdapter = createMockProcessAdapter();
  const loggerAdapter = createMockLoggerAdapter();
  const sent = [];
  const lineRouter = {
    appendSystemMessage() {},
    handleLine() {}
  };
  const sessionPort = {
    isIdle: () => false,
    log: async (message) => {
      sent.push(message);
    },
    send: async (prompt) => {
      sent.push(prompt);
    }
  };
  const lifecycle = createLifecycle({ lineRouter, sessionPort, timerAdapter, processAdapter, loggerAdapter });
  const emitter = {
    name: "demo",
    emitterType: EMITTER_TYPE.PROMPT,
    runSchedule: RUN_SCHEDULE.ONE_TIME,
    every: null,
    everyMs: null,
    everyScheduleMs: null,
    maxRuns: null,
    status: EMITTER_STATUS.QUEUED,
    stopRequested: false,
    inFlight: false,
    command: null,
    cwd: process.cwd(),
    prompt: "hello",
    process: null,
    stdoutReader: null,
    stderrReader: null,
    lineCount: 0,
    runCount: 0
  };

  lifecycle.start(emitter);
  timerAdapter.advance(0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.at(-1), "hello");
  assert.equal(emitter.status, EMITTER_STATUS.COMPLETED);
  assert.equal(emitter.lineCount, 1);
});
