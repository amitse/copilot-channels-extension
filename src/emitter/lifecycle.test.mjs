import test from "node:test";
import assert from "node:assert/strict";

import { EMITTER_STATUS, EMITTER_TYPE, EVENT_OUTCOME, IDLE_PROMPT_BACKOFF_MS, RUN_SCHEDULE, RUN_STATUS, SOURCE, STREAM } from "../consts.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import { computeTransition, identifyActions, LIFECYCLE_EVENT, LIFECYCLE_ACTION } from "./lifecycle-state.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { createLineRouter } from "./line-router.mjs";
import { createMockLoggerAdapter, createMockProcessAdapter, createMockTimerAdapter } from "../test-support/adapters.mjs";

function createLineRouterHarness(options = {}) {
  const appended = [];
  const enqueued = [];
  const surfaced = [];
  const sessionInjector = {
    enabled: true,
    delivery: EVENT_OUTCOME.SURFACE,
    ...(options.sessionInjector ?? {})
  };
  const streams = {
    append(channel, entry) {
      appended.push({ channel, ...entry });
    },
    ensure() {
      return { sessionInjector };
    }
  };
  const notifications = {
    enqueue(entry) {
      enqueued.push(entry);
    }
  };
  const surface = options.surface ?? ((message, meta) => {
    surfaced.push({ message, meta });
  });

  return {
    appended,
    enqueued,
    surfaced,
    lineRouter: createLineRouter({ streams, notifications, surface })
  };
}

function createProcessAdapterWithLineReaders() {
  const processAdapter = createMockProcessAdapter();
  const readers = [];

  processAdapter.readLines = (input, onLine) => {
    input.on("line", onLine);
    const reader = {
      input,
      closed: false,
      close() {
        this.closed = true;
        input.off("line", onLine);
      }
    };
    readers.push(reader);
    return reader;
  };

  return { processAdapter, readers };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createCommandEmitter(overrides = {}) {
  const eventFilter = EventFilterService.normalize({
    rules: [{ match: ".*", outcome: EVENT_OUTCOME.INJECT }]
  });
  const { includeStderr, ...rest } = overrides;
  const emitter = {
    name: "demo",
    emitterType: EMITTER_TYPE.COMMAND,
    runSchedule: RUN_SCHEDULE.CONTINUOUS,
    every: null,
    everyMs: null,
    everyScheduleMs: null,
    maxRuns: null,
    status: EMITTER_STATUS.QUEUED,
    stopRequested: false,
    inFlight: false,
    command: "emit-lines",
    cwd: process.cwd(),
    prompt: null,
    stream: "demo-stream",
    process: null,
    stdoutReader: null,
    stderrReader: null,
    lineCount: 0,
    droppedLineCount: 0,
    runCount: 0,
    eventFilter,
    ...rest
  };

  if (Object.prototype.hasOwnProperty.call(overrides, "includeStderr")) {
    emitter.includeStderr = includeStderr;
  }

  return emitter;
}

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

test("lifecycle transition defers timed prompt retry with system message", () => {
  const transition = computeTransition(
    {
      name: "demo",
      emitterType: EMITTER_TYPE.PROMPT,
      runSchedule: RUN_SCHEDULE.TIMED,
      every: "5m",
      everyMs: 300_000,
      runCount: 1,
      status: EMITTER_STATUS.RUNNING
    },
    {
      type: LIFECYCLE_EVENT.ITERATION_RESULT,
      result: { ok: false, deferred: true }
    }
  );

  assert.equal(transition.nextState.status, EMITTER_STATUS.WAITING);
  assert.deepEqual(identifyActions(transition), [
    { type: LIFECYCLE_ACTION.SCHEDULE_TIMER, delayMs: 300_000 },
    {
      type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE,
      text: "Emitter 'demo' deferred this prompt run because the session was still busy. Next attempt in 5m."
    }
  ]);
});

test("lifecycle transition defers idle prompt retry without system message", () => {
  const transition = computeTransition(
    {
      name: "demo",
      emitterType: EMITTER_TYPE.PROMPT,
      runSchedule: RUN_SCHEDULE.IDLE,
      every: "idle",
      runCount: 1,
      status: EMITTER_STATUS.RUNNING
    },
    {
      type: LIFECYCLE_EVENT.ITERATION_RESULT,
      result: { ok: false, deferred: true }
    }
  );

  assert.equal(transition.nextState.status, EMITTER_STATUS.WAITING);
  assert.deepEqual(identifyActions(transition), [
    { type: LIFECYCLE_ACTION.SCHEDULE_TIMER, delayMs: IDLE_PROMPT_BACKOFF_MS }
  ]);
});

test("lifecycle transition exhausts maxRuns after failed scheduled attempt", () => {
  const stoppedAt = "2026-06-05T00:00:00.000Z";
  const transition = computeTransition(
    {
      name: "demo",
      emitterType: EMITTER_TYPE.PROMPT,
      runSchedule: RUN_SCHEDULE.TIMED,
      every: "5m",
      everyMs: 300_000,
      maxRuns: 2,
      runCount: 2,
      status: EMITTER_STATUS.RUNNING
    },
    {
      type: LIFECYCLE_EVENT.ITERATION_RESULT,
      result: { ok: false, error: "boom" },
      timestamp: stoppedAt
    }
  );

  assert.equal(transition.nextState.status, EMITTER_STATUS.ERROR);
  assert.equal(transition.nextState.lastRunStatus, RUN_STATUS.FAILURE);
  assert.equal(transition.nextState.stoppedAt, stoppedAt);
  assert.deepEqual(identifyActions(transition), [
    {
      type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE,
      text: "Emitter 'demo' exhausted its run budget (2 of 2 attempts) after iteration failed: boom."
    },
    {
      type: LIFECYCLE_ACTION.LOG_MESSAGE,
      message: "Emitter 'demo' exhausted its run budget (2 of 2 attempts) after iteration failed: boom."
    }
  ]);
});

test("lifecycle transition exhausts maxRuns after deferred scheduled attempt", () => {
  const transition = computeTransition(
    {
      name: "demo",
      emitterType: EMITTER_TYPE.PROMPT,
      runSchedule: RUN_SCHEDULE.TIMED,
      every: "5m",
      everyMs: 300_000,
      maxRuns: 1,
      runCount: 1,
      status: EMITTER_STATUS.RUNNING
    },
    {
      type: LIFECYCLE_EVENT.ITERATION_RESULT,
      result: { ok: false, deferred: true }
    }
  );

  assert.equal(transition.nextState.status, EMITTER_STATUS.ERROR);
  assert.equal(transition.nextState.lastRunStatus, RUN_STATUS.FAILURE);
  assert.deepEqual(identifyActions(transition), [
    {
      type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE,
      text: "Emitter 'demo' exhausted its run budget (1 of 1 attempts) after a deferred prompt run."
    },
    {
      type: LIFECYCLE_ACTION.LOG_MESSAGE,
      message: "Emitter 'demo' exhausted its run budget (1 of 1 attempts) after a deferred prompt run."
    }
  ]);
});

test("lifecycle transition stops after in-flight scheduled iteration", () => {
  const stoppedAt = "2026-06-05T00:00:00.000Z";
  const transition = computeTransition(
    {
      name: "demo",
      emitterType: EMITTER_TYPE.PROMPT,
      runSchedule: RUN_SCHEDULE.TIMED,
      every: "5m",
      everyMs: 300_000,
      runCount: 1,
      status: EMITTER_STATUS.STOPPING,
      stopRequested: true,
      inFlight: false
    },
    {
      type: LIFECYCLE_EVENT.ITERATION_RESULT,
      result: { ok: true },
      timestamp: stoppedAt
    }
  );

  assert.equal(transition.nextState.status, EMITTER_STATUS.STOPPED);
  assert.equal(transition.nextState.stoppedAt, stoppedAt);
  const stoppedMessage = "Emitter 'demo' stopped.";
  assert.deepEqual(identifyActions(transition), [
    { type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text: stoppedMessage },
    { type: LIFECYCLE_ACTION.APPEND_SYSTEM_MESSAGE, text: stoppedMessage }
  ]);
});

test("scheduled lifecycle preserves duplicate stop system messages for in-flight stop", async () => {
  const timerAdapter = createMockTimerAdapter();
  const processAdapter = createMockProcessAdapter();
  const loggerAdapter = createMockLoggerAdapter();
  const { appended, enqueued, lineRouter } = createLineRouterHarness();
  const sendDeferred = createDeferred();
  const sessionPort = {
    isIdle: () => false,
    log: async () => {},
    send: () => sendDeferred.promise
  };
  const lifecycle = createLifecycle({ lineRouter, sessionPort, timerAdapter, processAdapter, loggerAdapter });
  const emitter = {
    name: "demo",
    emitterType: EMITTER_TYPE.PROMPT,
    runSchedule: RUN_SCHEDULE.TIMED,
    every: "5m",
    everyMs: 300_000,
    everyScheduleMs: null,
    maxRuns: null,
    status: EMITTER_STATUS.QUEUED,
    stopRequested: false,
    inFlight: false,
    command: null,
    cwd: process.cwd(),
    prompt: "hello",
    stream: "demo-stream",
    process: null,
    stdoutReader: null,
    stderrReader: null,
    lineCount: 0,
    runCount: 0
  };

  lifecycle.start(emitter);
  timerAdapter.advance(0);

  assert.equal(emitter.inFlight, true);
  await lifecycle.stop(emitter);

  const stoppedMessage = "Emitter 'demo' stopped.";
  assert.equal(emitter.status, EMITTER_STATUS.STOPPING);
  assert.equal(emitter.stopRequested, true);
  assert.equal(appended.filter((entry) => entry.text === stoppedMessage).length, 0);

  sendDeferred.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  const stopEntries = appended.filter((entry) => entry.text === stoppedMessage);
  assert.equal(stopEntries.length, 2);
  assert.deepEqual(stopEntries.map((entry) => entry.source), [SOURCE.SYSTEM, SOURCE.SYSTEM]);
  assert.equal(enqueued.filter((entry) => entry.text === stoppedMessage).length, 0);
  assert.equal(emitter.status, EMITTER_STATUS.STOPPED);
  assert.equal(emitter.inFlight, false);
  assert.equal(timerAdapter.pendingCount, 0);
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

test("command emitter stderr routing honors includeStderr policy", () => {
  const cases = [
    {
      label: "includeStderr false",
      overrides: { includeStderr: false },
      expectedEntries: [
        { source: SOURCE.EMITTER, stream: STREAM.STDOUT, text: "stdout line" }
      ]
    },
    {
      label: "includeStderr true",
      overrides: { includeStderr: true },
      expectedEntries: [
        { source: SOURCE.EMITTER, stream: STREAM.STDOUT, text: "stdout line" },
        { source: SOURCE.EMITTER_STDERR, stream: STREAM.STDERR, text: "stderr line" }
      ]
    },
    {
      label: "includeStderr default",
      overrides: {},
      expectedEntries: [
        { source: SOURCE.EMITTER, stream: STREAM.STDOUT, text: "stdout line" },
        { source: SOURCE.EMITTER_STDERR, stream: STREAM.STDERR, text: "stderr line" }
      ]
    }
  ];

  for (const { label, overrides, expectedEntries } of cases) {
    const { appended, enqueued, lineRouter } = createLineRouterHarness();
    const { processAdapter, readers } = createProcessAdapterWithLineReaders();
    const emitter = createCommandEmitter(overrides);
    const lifecycle = createLifecycle({
      lineRouter,
      sessionPort: { isIdle: () => false, log: async () => {}, send: async () => {} },
      timerAdapter: createMockTimerAdapter(),
      processAdapter,
      loggerAdapter: createMockLoggerAdapter()
    });

    lifecycle.start(emitter);
    const child = processAdapter.children.at(-1);

    assert.equal(readers.length, 2, `${label}: stdout and stderr readers are attached`);
    assert.equal(readers[0].input, child.stdout, `${label}: stdout reader consumes stdout`);
    assert.equal(readers[1].input, child.stderr, `${label}: stderr reader consumes stderr`);

    child.stdout.emit("line", "stdout line");
    child.stderr.emit("line", "stderr line");

    const commandEntries = appended
      .filter((entry) => entry.source !== SOURCE.SYSTEM)
      .map(({ source, stream, text }) => ({ source, stream, text }));
    const notifications = enqueued.map(({ stream, text }) => ({ stream, text }));

    assert.deepEqual(commandEntries, expectedEntries, `${label}: routed command output`);
    assert.deepEqual(
      notifications,
      expectedEntries.map(({ stream, text }) => ({ stream, text })),
      `${label}: injected command output`
    );
    assert.equal(emitter.lineCount, expectedEntries.length, `${label}: routed line count`);
  }
});

test("line router does not enqueue when session injector is disabled", () => {
  const { appended, enqueued, surfaced, lineRouter } = createLineRouterHarness({
    sessionInjector: { enabled: false, delivery: "all" }
  });
  const emitter = createCommandEmitter();

  lineRouter.handleLine(emitter, "urgent line", STREAM.STDOUT, SOURCE.EMITTER);
  lineRouter.appendSystemMessage(emitter, "system alert", true);

  assert.deepEqual(appended.map(({ text }) => text), ["urgent line", "system alert"]);
  assert.deepEqual(enqueued, []);
  assert.deepEqual(surfaced, []);
});

test("line router applies delivery modes to inject and surface outcomes", () => {
  const cases = [
    {
      label: "important only injects inject outcomes",
      delivery: "important",
      outcome: EVENT_OUTCOME.SURFACE,
      expectedEnqueued: [],
      expectedSurfaced: []
    },
    {
      label: "surface logs surface outcomes",
      delivery: EVENT_OUTCOME.SURFACE,
      outcome: EVENT_OUTCOME.SURFACE,
      expectedEnqueued: [],
      expectedSurfaced: ["surface line"]
    },
    {
      label: "all surfaces kept outcomes",
      delivery: "all",
      outcome: EVENT_OUTCOME.KEEP,
      expectedEnqueued: [],
      expectedSurfaced: ["keep line"]
    },
    {
      label: "keep suppresses inject outcomes",
      delivery: EVENT_OUTCOME.KEEP,
      outcome: EVENT_OUTCOME.INJECT,
      expectedEnqueued: [],
      expectedSurfaced: []
    },
    {
      label: "inject delivers inject outcomes",
      delivery: EVENT_OUTCOME.INJECT,
      outcome: EVENT_OUTCOME.INJECT,
      expectedEnqueued: ["inject line"],
      expectedSurfaced: []
    }
  ];

  for (const { label, delivery, outcome, expectedEnqueued, expectedSurfaced } of cases) {
    const { enqueued, surfaced, lineRouter } = createLineRouterHarness({
      sessionInjector: { enabled: true, delivery }
    });
    const text = `${outcome} line`;
    const emitter = createCommandEmitter({
      eventFilter: EventFilterService.normalize({
        rules: [{ match: ".*", outcome }]
      })
    });

    lineRouter.handleLine(emitter, text, STREAM.STDOUT, SOURCE.EMITTER);

    assert.deepEqual(enqueued.map((entry) => entry.text), expectedEnqueued, `${label}: enqueued`);
    assert.deepEqual(
      surfaced.map((entry) => entry.message.replace(/^.*: /, "")),
      expectedSurfaced,
      `${label}: surfaced`
    );
  }
});

test("scheduled command iteration waits for close before completing", async () => {
  const timerAdapter = createMockTimerAdapter();
  const loggerAdapter = createMockLoggerAdapter();
  const { appended, lineRouter } = createLineRouterHarness();
  const { processAdapter } = createProcessAdapterWithLineReaders();
  const lifecycle = createLifecycle({
    lineRouter,
    sessionPort: { isIdle: () => false, log: async () => {}, send: async () => {} },
    timerAdapter,
    processAdapter,
    loggerAdapter
  });
  const emitter = createCommandEmitter({
    runSchedule: RUN_SCHEDULE.TIMED,
    every: "5m",
    everyMs: 300_000,
    maxRuns: 1
  });

  lifecycle.start(emitter);
  timerAdapter.advance(0);
  const child = processAdapter.children.at(-1);

  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(emitter.inFlight, true);
  assert.equal(emitter.status, EMITTER_STATUS.RUNNING);

  child.stdout.emit("line", "trailing stdout");
  child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(emitter.inFlight, false);
  assert.equal(emitter.status, EMITTER_STATUS.COMPLETED);
  assert.ok(appended.some((entry) => entry.text === "trailing stdout"));
});

test("scheduled command signal termination fails unless stop was requested", async () => {
  const timerAdapter = createMockTimerAdapter();
  const loggerAdapter = createMockLoggerAdapter();
  const { appended, lineRouter } = createLineRouterHarness();
  const { processAdapter } = createProcessAdapterWithLineReaders();
  const lifecycle = createLifecycle({
    lineRouter,
    sessionPort: { isIdle: () => false, log: async () => {}, send: async () => {} },
    timerAdapter,
    processAdapter,
    loggerAdapter
  });
  const emitter = createCommandEmitter({
    runSchedule: RUN_SCHEDULE.TIMED,
    every: "5m",
    everyMs: 300_000,
    maxRuns: 1
  });

  lifecycle.start(emitter);
  timerAdapter.advance(0);
  const child = processAdapter.children.at(-1);

  child.emit("close", null, "SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(emitter.inFlight, false);
  assert.equal(emitter.status, EMITTER_STATUS.ERROR);
  assert.equal(emitter.lastRunStatus, RUN_STATUS.FAILURE);
  assert.ok(appended.some((entry) => /SIGTERM/.test(entry.text)));
});
