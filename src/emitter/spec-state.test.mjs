import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP, RUN_SCHEDULE, EMITTER_TYPE, EMITTER_STATUS } from "../consts.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";
import { normalizeEmitterSpec } from "./spec.mjs";
import { buildEmitterState } from "./state.mjs";

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
