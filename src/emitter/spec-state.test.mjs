import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP, RUN_SCHEDULE, EMITTER_TYPE, EMITTER_STATUS } from "../consts.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";
import { formatConfiguredEmitter } from "../format/emitter.mjs";
import { normalizeEmitterSpec } from "./spec.mjs";
import { buildEmitterState } from "./state.mjs";
import { projectConfiguredEmitter } from "./projection.mjs";

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
