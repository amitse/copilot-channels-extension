import test from "node:test";
import assert from "node:assert/strict";

import { EMITTER_OPERATION_STATUS, EMITTER_TYPE, EVENT_OUTCOME, LIFESPAN, OWNERSHIP, RUN_SCHEDULE } from "../consts.mjs";
import { createStreamTools } from "./channels.mjs";
import { createEmitterTools } from "./monitors.mjs";
import { createDiagnosticsTools } from "./diagnostics.mjs";
import { createGoalVerificationTools } from "./goal-verification.mjs";

test("tap_start_emitter reports canonical snapshot lifespan", async () => {
  const tools = createEmitterTools({
    emitters: {
      async startEmitter() {
        return {
          state: {
            name: "demo",
            lifespan: LIFESPAN.TEMPORARY,
            ownership: OWNERSHIP.MODEL_OWNED,
            emitterType: EMITTER_TYPE.PROMPT,
            runSchedule: RUN_SCHEDULE.ONE_TIME,
            stream: "demo",
            sessionInjector: { enabled: false },
            eventFilter: {
              rules: [],
              lifespan: LIFESPAN.TEMPORARY,
              ownership: OWNERSHIP.MODEL_OWNED
            }
          }
        };
      }
    }
  });

  const startEmitter = tools.find((tool) => tool.name === "tap_start_emitter");
  const output = await startEmitter.handler({ name: "demo" });

  assert.match(output, /^lifespan=temporary$/m);
  assert.doesNotMatch(output, /lifespan=undefined/);
  assert.match(output, /eventFilter=rules=<none> lifespan=temporary ownership=modelOwned/);
});

test("emitter tool handlers forward canonical lifespan and ownership policy fields", async () => {
  const calls = [];
  const tools = createEmitterTools({
    emitters: {
      updateFilter(name, filter, options) {
        calls.push({ operation: "updateFilter", name, filter, options });
        return {
          state: {
            name,
            eventFilter: {
              rules: [],
              lifespan: options.scope,
              ownership: options.managedBy
            }
          }
        };
      },
      async stopEmitter(name, options) {
        calls.push({ operation: "stopEmitter", name, options });
        return {
          result: { status: EMITTER_OPERATION_STATUS.REMOVED_FROM_CONFIG },
          state: null
        };
      }
    }
  });
  const setFilter = tools.find((tool) => tool.name === "tap_set_event_filter");
  const stopEmitter = tools.find((tool) => tool.name === "tap_stop_emitter");

  await setFilter.handler({
    name: "demo",
    eventFilter: { rules: [] },
    lifespan: LIFESPAN.PERSISTENT,
    ownership: OWNERSHIP.USER_OWNED,
    force: true
  });
  await stopEmitter.handler({
    name: "demo",
    lifespan: LIFESPAN.PERSISTENT,
    force: true
  });

  assert.deepEqual(calls, [
    {
      operation: "updateFilter",
      name: "demo",
      filter: { rules: [] },
      options: {
        scope: LIFESPAN.PERSISTENT,
        managedBy: OWNERSHIP.USER_OWNED,
        force: true
      }
    },
    {
      operation: "stopEmitter",
      name: "demo",
      options: {
        scope: LIFESPAN.PERSISTENT,
        force: true
      }
    }
  ]);
  assert.ok(setFilter.parameters.properties.lifespan);
  assert.ok(setFilter.parameters.properties.ownership);
  assert.ok(stopEmitter.parameters.properties.lifespan);
});

test("stream tool handlers forward canonical lifespan and ownership policy fields", async () => {
  const calls = [];
  const tools = createStreamTools({
    streams: {
      setInjectorPolicy(channel, policy) {
        calls.push({ channel, policy });
        return {
          state: {
            name: channel,
            sessionInjector: {
              enabled: policy.enabled,
              delivery: policy.delivery,
              lifespan: policy.scope,
              ownership: policy.managedBy
            }
          }
        };
      }
    }
  });
  const enableInjector = tools.find((tool) => tool.name === "tap_enable_injector");

  await enableInjector.handler({
    channel: "ops",
    delivery: EVENT_OUTCOME.INJECT,
    lifespan: LIFESPAN.PERSISTENT,
    ownership: OWNERSHIP.USER_OWNED,
    force: true
  });

  assert.deepEqual(calls, [
    {
      channel: "ops",
      policy: {
        enabled: true,
        delivery: EVENT_OUTCOME.INJECT,
        description: undefined,
        scope: LIFESPAN.PERSISTENT,
        managedBy: OWNERSHIP.USER_OWNED,
        force: true
      }
    }
  ]);
  assert.ok(enableInjector.parameters.properties.lifespan);
  assert.ok(enableInjector.parameters.properties.ownership);
  assert.ok(enableInjector.parameters.properties.scope);
  assert.ok(enableInjector.parameters.properties.managedBy);
});

test("goal verification tools render verification results", async () => {
  const tools = createGoalVerificationTools({
    verification: {
      verifyGoalOutput() {
        return {
          passed: false,
          results: [
            { index: 0, description: "artifact", passed: false, error: "missing" }
          ]
        };
      },
      auditClaims() {
        return {
          passed: true,
          results: [
            { index: 0, claim: "claim", passed: true }
          ]
        };
      }
    }
  });

  const verify = tools.find((tool) => tool.name === "tap_verify_goal_output");
  const audit = tools.find((tool) => tool.name === "tap_audit_claims");

  assert.ok(verify);
  assert.ok(audit);
  assert.match(await verify.handler({ checks: [] }), /Goal output verification: failed/);
  assert.match(await audit.handler({ claims: [] }), /Claim audit: passed/);
});

test("diagnostics tools include read-only session state when available", async () => {
  const tools = createDiagnosticsTools({
    diagnostics: {
      openCanvas: async () => ({ title: "Tap diagnostics" }),
      getSessionRuntimeState: async () => ({
        sessionId: "s1",
        capabilities: { ui: { elicitation: true } },
        mode: { ok: true, value: "interactive" },
        model: { ok: true, value: { modelId: "gpt-5.5", reasoningEffort: "high", contextTier: "long_context" } },
        tasks: { ok: true, value: { tasks: [1, 2] } },
        schedules: { ok: true, value: { entries: [] } },
        permissions: { ok: true, value: { items: [1] } },
        openCanvases: { ok: true, value: { openCanvases: [] } }
      }),
      queryRecords: () => ({ collection: "traces", records: [{ id: "trace-1" }] }),
      setSessionMode: async (mode) => mode
    }
  });
  const getState = tools.find((tool) => tool.name === "tap_get_session_state");
  const queryRecords = tools.find((tool) => tool.name === "tap_query_records");
  const setMode = tools.find((tool) => tool.name === "tap_set_session_mode");

  assert.ok(getState);
  assert.ok(queryRecords);
  assert.ok(setMode);
  const output = await getState.handler({});
  assert.match(output, /mode=interactive/);
  assert.match(output, /tasks=2/);
  assert.match(output, /pendingPermissions=1/);
  assert.match(output, /elicitation=available/);
  assert.match(await queryRecords.handler({ collection: "traces" }), /trace-1/);
  await assert.rejects(
    () => setMode.handler({ mode: "autopilot", reason: "test", confirm: "wrong" }),
    /Refusing to change session mode/
  );
  assert.match(
    await setMode.handler({ mode: "interactive", reason: "test", confirm: "set-session-mode" }),
    /Session mode set to interactive/
  );
});
