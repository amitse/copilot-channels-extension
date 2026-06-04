import test from "node:test";
import assert from "node:assert/strict";

import { EMITTER_STATUS, EMITTER_TYPE, EVENT_OUTCOME, RUN_SCHEDULE, RUN_STATUS, SOURCE, STREAM } from "../consts.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";
import { computeTransition, identifyActions, LIFECYCLE_EVENT, LIFECYCLE_ACTION } from "./lifecycle-state.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { createLineRouter } from "./line-router.mjs";
import { createMockLoggerAdapter, createMockProcessAdapter, createMockTimerAdapter } from "../test-support/adapters.mjs";

function createLineRouterHarness() {
  const appended = [];
  const enqueued = [];
  const streams = {
    append(channel, entry) {
      appended.push({ channel, ...entry });
    },
    ensure() {
      return { sessionInjector: { enabled: true } };
    }
  };
  const notifications = {
    enqueue(entry) {
      enqueued.push(entry);
    }
  };

  return {
    appended,
    enqueued,
    lineRouter: createLineRouter({ streams, notifications })
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
