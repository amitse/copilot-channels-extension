import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP, RUN_SCHEDULE, EMITTER_TYPE, EMITTER_STATUS, RUN_STATUS } from "../consts.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import { formatConfiguredEmitter } from "../format/emitter.mjs";
import { ValidationError } from "../errors/index.mjs";
import { normalizeEmitterSpec } from "./spec.mjs";
import { buildEmitterState } from "./state.mjs";
import { projectConfiguredEmitter, projectRunningEmitter } from "./projection.mjs";

test("normalizeEmitterSpec canonicalizes shared emitter fields", () => {
  const raw = {
    name: "  Demo Monitor  ",
    command: "  echo hello  ",
    everySchedule: ["10s", "1m"],
    scope: "persistent",
    managedBy: "userOwned",
    autoStart: false,
    includeStderr: false,
    subscribe: true,
    delivery: "all",
    maxRuns: 2,
    eventFilter: {
      rules: [{ match: "alpha", outcome: EVENT_OUTCOME.KEEP }]
    }
  };

  const spec = normalizeEmitterSpec(raw);

  assert.equal(spec.name, "demo-monitor");
  assert.equal(spec.command, "echo hello");
  assert.equal(spec.prompt, null);
  assert.equal(spec.emitterType, EMITTER_TYPE.COMMAND);
  assert.equal(spec.runSchedule, RUN_SCHEDULE.TIMED);
  assert.equal(spec.scope, LIFESPAN.PERSISTENT);
  assert.equal(spec.managedBy, OWNERSHIP.USER_OWNED);
  assert.equal(spec.autoStart, false);
  assert.equal(spec.includeStderr, false);
  assert.equal(spec.subscribe, true);
  assert.equal(spec.delivery, "all");
  assert.equal(spec.maxRuns, 2);
  assert.deepEqual(spec.everySchedule, ["10s", "1m"]);
  assert.deepEqual(spec.everyScheduleMs, [10_000, 60_000]);
  assert.equal(Object.getOwnPropertyDescriptor(spec, "__emitterSpec")?.enumerable, false);
  assert.equal(spec.__emitterSpec, true);
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(Object.isFrozen(spec.eventFilter), true);
  assert.deepEqual(
    EventFilterService.serialize(spec.eventFilter),
    EventFilterService.serialize(
      EventFilterService.normalize({
        rules: [{ match: "alpha", outcome: EVENT_OUTCOME.KEEP }],
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.PERSISTENT
      })
    )
  );
});

test("normalizeEmitterSpec honors canonical lifespan and ownership aliases", () => {
  const spec = normalizeEmitterSpec({
    name: "Canonical Policy Monitor",
    command: "echo ok",
    lifespan: LIFESPAN.PERSISTENT,
    ownership: OWNERSHIP.USER_OWNED,
    eventFilter: [
      { match: "ok", outcome: EVENT_OUTCOME.SURFACE }
    ]
  });

  assert.equal(spec.scope, LIFESPAN.PERSISTENT);
  assert.equal(spec.managedBy, OWNERSHIP.USER_OWNED);
  assert.deepEqual(EventFilterService.serialize(spec.eventFilter), {
    rules: [{ match: "ok", outcome: EVENT_OUTCOME.SURFACE }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });
});

test("normalizeEmitterSpec accepts documented eventFilter arrays", () => {
  const spec = normalizeEmitterSpec({
    name: "Array Filter",
    command: "node worker.mjs",
    scope: "persistent",
    managedBy: "userOwned",
    eventFilter: [
      { match: "warning|error", outcome: EVENT_OUTCOME.INJECT },
      { match: ".*", outcome: EVENT_OUTCOME.KEEP }
    ]
  });

  assert.deepEqual(EventFilterService.serialize(spec.eventFilter), {
    rules: [
      { match: "warning|error", outcome: EVENT_OUTCOME.INJECT },
      { match: ".*", outcome: EVENT_OUTCOME.KEEP }
    ],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });
});

test("normalizeEmitterSpec maps runInterval to timed every schedule", () => {
  const spec = normalizeEmitterSpec({
    name: "Repo Maintenance",
    prompt: "check repo health",
    runInterval: "15m"
  });

  assert.equal(spec.every, "15m");
  assert.equal(spec.everyMs, 900_000);
  assert.equal(spec.runSchedule, RUN_SCHEDULE.TIMED);
});

test("normalizeEmitterSpec accepts semantically equivalent every and runInterval aliases", () => {
  const minuteAlias = normalizeEmitterSpec({
    name: "Equivalent Minutes",
    prompt: "check repo health",
    every: "every 15 minutes",
    runInterval: "15m"
  });
  const hourAlias = normalizeEmitterSpec({
    name: "Equivalent Hours",
    prompt: "check repo health",
    every: "1h",
    runInterval: "60m"
  });

  assert.equal(minuteAlias.every, "15m");
  assert.equal(minuteAlias.everyMs, 900_000);
  assert.equal(hourAlias.every, "1h");
  assert.equal(hourAlias.everyMs, 3_600_000);
});

test("normalizeEmitterSpec rejects genuinely conflicting every and runInterval aliases", () => {
  assert.throws(
    () => normalizeEmitterSpec({
      name: "Conflicting Schedule",
      prompt: "check repo health",
      every: "15m",
      runInterval: "20m"
    }),
    /every and runInterval must not conflict/
  );
  assert.throws(
    () => normalizeEmitterSpec({
      name: "Conflicting Idle Schedule",
      prompt: "check repo health",
      every: "idle",
      runInterval: "15m"
    }),
    /every and runInterval must not conflict/
  );
});

test("normalizeEmitterSpec routes documented stream over stale legacy channel", () => {
  const conflictSpec = normalizeEmitterSpec({
    name: "Alias Monitor",
    command: "echo ok",
    stream: "Edited Stream",
    channel: "stale-channel"
  });
  const legacySpec = normalizeEmitterSpec({
    name: "Legacy Channel Monitor",
    command: "echo ok",
    channel: "Legacy Channel"
  });

  assert.equal(conflictSpec.channel, "edited-stream");
  assert.equal(buildEmitterState(conflictSpec, "/workspace").stream, "edited-stream");
  assert.equal(legacySpec.channel, "legacy-channel");
});

test("normalizeEmitterSpec rejects invalid explicit stream and channel names", () => {
  const base = {
    name: "Watch",
    command: "echo ok"
  };

  assert.throws(
    () => normalizeEmitterSpec({
      ...base,
      stream: "!!!"
    }),
    ValidationError
  );
  assert.throws(
    () => normalizeEmitterSpec({
      ...base,
      stream: "!!!",
      channel: "valid"
    }),
    ValidationError
  );
  assert.throws(
    () => normalizeEmitterSpec({
      ...base,
      channel: "!!!"
    }),
    ValidationError
  );
  assert.throws(
    () => normalizeEmitterSpec({
      ...base,
      stream: "   ",
      channel: "!!!"
    }),
    ValidationError
  );
});

test("normalizeEmitterSpec falls back for blank stream and channel names", () => {
  const spec = normalizeEmitterSpec({
    name: "Watch",
    command: "echo ok",
    stream: "   ",
    channel: "\t"
  });

  assert.equal(spec.channel, "watch");
});

test("normalizeEmitterSpec rejects non-integer maxRuns", () => {
  assert.throws(
    () => normalizeEmitterSpec({
      name: "Bad Budget",
      prompt: "check once",
      maxRuns: 1.9
    }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /maxRuns/);
      return true;
    }
  );
});

test("buildEmitterState consumes canonical emitter specs", () => {
  const raw = {
    name: "Night Watch",
    prompt: "check in",
    every: "idle",
    scope: "temporary",
    managedBy: "modelOwned",
    eventFilter: {
      rules: [{ match: "sync", outcome: EVENT_OUTCOME.INJECT }]
    }
  };

  const spec = normalizeEmitterSpec(raw);
  const rawState = buildEmitterState(raw, "/workspace");
  const canonicalState = buildEmitterState(spec, "/workspace");

  assert.equal(rawState.name, spec.name);
  assert.equal(rawState.command, spec.command);
  assert.equal(rawState.prompt, spec.prompt);
  assert.equal(rawState.emitterType, spec.emitterType);
  assert.equal(rawState.runSchedule, spec.runSchedule);
  assert.equal(rawState.lifespan, spec.scope);
  assert.equal(rawState.ownership, spec.managedBy);
  assert.equal(rawState.stream, spec.channel);
  assert.equal(rawState.requestedCwd, null);
  assert.equal(rawState.cwd, "/workspace");
  assert.equal(rawState.status, EMITTER_STATUS.QUEUED);
  assert.deepEqual(rawState.eventFilter, spec.eventFilter);

  assert.strictEqual(canonicalState.eventFilter, spec.eventFilter);
  assert.strictEqual(canonicalState.runSchedule, spec.runSchedule);
});

test("projectRunningEmitter exposes public snapshot fields without runtime handles", () => {
  const emitter = buildEmitterState({
    name: "Runtime Boundary",
    command: "node worker.mjs",
    everySchedule: ["10s", "1m"],
    scope: LIFESPAN.TEMPORARY,
    managedBy: OWNERSHIP.MODEL_OWNED,
    eventFilter: {
      rules: [{ match: "ready", outcome: EVENT_OUTCOME.INJECT }]
    },
    maxRuns: 3
  }, "/workspace");
  Object.assign(emitter, {
    status: EMITTER_STATUS.RUNNING,
    timer: { cancel() {} },
    inFlight: true,
    stopRequested: true,
    process: { pid: 1234 },
    stdoutReader: { close() {} },
    stderrReader: { close() {} },
    abortController: { abort() {} },
    controller: { abort() {} },
    pendingPromise: Promise.resolve(),
    runCount: 2,
    lineCount: 5,
    droppedLineCount: 1,
    lastRunAt: "2026-06-05T00:00:00.000Z",
    lastRunStatus: RUN_STATUS.SUCCESS,
    exitCode: 0
  });
  const stream = {
    sessionInjector: {
      enabled: true,
      delivery: "all",
      ownership: OWNERSHIP.MODEL_OWNED,
      lifespan: LIFESPAN.TEMPORARY
    }
  };

  const projected = projectRunningEmitter(emitter, stream);

  assert.equal(projected.name, "runtime-boundary");
  assert.equal(projected.status, EMITTER_STATUS.RUNNING);
  assert.equal(projected.scope, LIFESPAN.TEMPORARY);
  assert.equal(projected.lifespan, LIFESPAN.TEMPORARY);
  assert.equal(projected.ownership, OWNERSHIP.MODEL_OWNED);
  assert.equal(projected.emitterType, EMITTER_TYPE.COMMAND);
  assert.equal(projected.type, EMITTER_TYPE.COMMAND);
  assert.equal(projected.runSchedule, RUN_SCHEDULE.TIMED);
  assert.equal(projected.stream, "runtime-boundary");
  assert.equal(projected.channel, "runtime-boundary");
  assert.equal(projected.cwd, "/workspace");
  assert.equal(projected.command, "node worker.mjs");
  assert.deepEqual(projected.everySchedule, ["10s", "1m"]);
  assert.deepEqual(projected.everyScheduleMs, [10_000, 60_000]);
  assert.equal(projected.maxRuns, 3);
  assert.equal(projected.runCount, 2);
  assert.equal(projected.lineCount, 5);
  assert.equal(projected.droppedLineCount, 1);
  assert.equal(projected.lastRunAt, "2026-06-05T00:00:00.000Z");
  assert.equal(projected.lastRunStatus, RUN_STATUS.SUCCESS);
  assert.equal(projected.exitCode, 0);
  assert.equal(projected.source, "running");
  assert.deepEqual(projected.sessionInjector, stream.sessionInjector);
  assert.notStrictEqual(projected.sessionInjector, stream.sessionInjector);
  assert.deepEqual(EventFilterService.serialize(projected.eventFilter), {
    rules: [{ match: "ready", outcome: EVENT_OUTCOME.INJECT }],
    ownership: OWNERSHIP.MODEL_OWNED,
    lifespan: LIFESPAN.TEMPORARY
  });
  assert.notStrictEqual(projected.eventFilter, emitter.eventFilter);
  assert.notStrictEqual(projected.eventFilter.rules, emitter.eventFilter.rules);
  assert.notStrictEqual(projected.eventFilter.rules[0], emitter.eventFilter.rules[0]);
  assert.notStrictEqual(projected.everySchedule, emitter.everySchedule);
  assert.notStrictEqual(projected.everyScheduleMs, emitter.everyScheduleMs);

  for (const key of [
    "process",
    "timer",
    "stdoutReader",
    "stderrReader",
    "inFlight",
    "stopRequested",
    "abortController",
    "controller",
    "pendingPromise"
  ]) {
    assert.equal(key in projected, false, `projected emitter should not expose ${key}`);
  }
});

test("projectConfiguredEmitter preserves configured schedule fields for formatter display", () => {
  const stream = {
    sessionInjector: {
      enabled: true,
      delivery: "all",
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    }
  };
  const entry = {
    name: "Backoff Monitor",
    channel: "Ops Events",
    command: "node worker.mjs",
    cwd: "services/worker",
    everySchedule: ["10s", "1m"],
    everyScheduleMs: [10_000, 60_000],
    maxRuns: 3,
    autoStart: false,
    includeStderr: false,
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT,
    eventFilter: {
      rules: [{ match: "ready", outcome: EVENT_OUTCOME.SURFACE }],
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    }
  };
  const projected = projectConfiguredEmitter(entry, { stream });

  assert.equal(projected.name, "backoff-monitor");
  assert.equal(projected.stream, "ops-events");
  assert.equal(projected.channel, "ops-events");
  assert.equal(projected.scope, LIFESPAN.PERSISTENT);
  assert.equal(projected.lifespan, LIFESPAN.PERSISTENT);
  assert.equal(projected.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(projected.emitterType, EMITTER_TYPE.COMMAND);
  assert.equal(projected.type, EMITTER_TYPE.COMMAND);
  assert.equal(projected.runSchedule, RUN_SCHEDULE.TIMED);
  assert.equal(projected.autoStart, false);
  assert.equal(projected.includeStderr, false);
  assert.equal(projected.cwd, "services/worker");
  assert.deepEqual(projected.everySchedule, ["10s", "1m"]);
  assert.deepEqual(projected.everyScheduleMs, [10_000, 60_000]);
  assert.equal(projected.maxRuns, 3);
  assert.deepEqual(projected.sessionInjector, stream.sessionInjector);
  assert.notStrictEqual(projected.sessionInjector, stream.sessionInjector);
  assert.deepEqual(EventFilterService.serialize(projected.eventFilter), {
    rules: [{ match: "ready", outcome: EVENT_OUTCOME.SURFACE }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });

  const formatted = formatConfiguredEmitter(projected);
  assert.match(formatted, /runSchedule=timed/);
  assert.match(formatted, /everySchedule=\[10s, 1m\]/);
  assert.match(formatted, /everyScheduleMs=\[10000, 60000\]/);
  assert.match(formatted, /maxRuns=3/);
  assert.match(formatted, /cwd=services\/worker/);
});

test("projectConfiguredEmitter displays documented stream over stale legacy channel", () => {
  const projected = projectConfiguredEmitter({
    name: "Configured Alias Monitor",
    command: "echo ok",
    stream: "Edited Stream",
    channel: "stale-channel"
  });

  assert.equal(projected.stream, "edited-stream");
  assert.equal(projected.channel, "edited-stream");
});

test("projectConfiguredEmitter treats runInterval as a timed configured schedule", () => {
  const projected = projectConfiguredEmitter({
    name: "Repo Maintenance",
    prompt: "check repo health",
    runInterval: "15m",
    eventFilter: [
      { match: "warning|error", outcome: EVENT_OUTCOME.INJECT }
    ]
  });

  assert.equal(projected.every, "15m");
  assert.equal(projected.runSchedule, RUN_SCHEDULE.TIMED);
  assert.deepEqual(EventFilterService.serialize(projected.eventFilter), {
    rules: [{ match: "warning|error", outcome: EVENT_OUTCOME.INJECT }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });
});

test("projectConfiguredEmitter tolerates incomplete configured entries", () => {
  const projected = projectConfiguredEmitter({
    name: "Partial Entry",
    stream: "raw-stream",
    every: "idle",
    enabled: false
  });

  assert.equal(projected.name, "partial-entry");
  assert.equal(projected.stream, "raw-stream");
  assert.equal(projected.command, null);
  assert.equal(projected.prompt, null);
  assert.equal(projected.emitterType, EMITTER_TYPE.COMMAND);
  assert.equal(projected.idle, false);
  assert.equal(projected.runSchedule, RUN_SCHEDULE.TIMED);
  assert.equal(projected.autoStart, true);
  assert.equal(projected.enabled, false);
  assert.doesNotThrow(() => formatConfiguredEmitter(projected));

  const typedPrompt = projectConfiguredEmitter({
    name: "Typed Prompt",
    type: "prompt",
    idle: true
  });
  assert.equal(typedPrompt.emitterType, EMITTER_TYPE.PROMPT);
  assert.equal(typedPrompt.type, EMITTER_TYPE.PROMPT);
  assert.equal(typedPrompt.idle, true);
  assert.equal(typedPrompt.runSchedule, RUN_SCHEDULE.IDLE);
});
