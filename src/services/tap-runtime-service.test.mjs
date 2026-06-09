import test from "node:test";
import assert from "node:assert/strict";

import { EMITTER_STATUS, EVENT_OUTCOME, LIFESPAN, OWNERSHIP, SOURCE } from "../consts.mjs";
import { ValidationError } from "../errors/index.mjs";
import { createTapRuntimeService } from "./tap-runtime-service.mjs";

function createSessionPortHarness() {
  const logs = [];
  const prompts = [];
  return {
    logs,
    prompts,
    port: {
      attach() {},
      current: () => ({ id: "s1", label: "Test session" }),
      isAttached: () => true,
      setIdle() {},
      isIdle: () => false,
      async log(message, options = {}) {
        logs.push({ message, options });
      },
      async send(prompt) {
        prompts.push(prompt);
      },
      async sendAndWait() {
        return "";
      },
      registerTools() {},
      async reloadExtension() {}
    }
  };
}

test("runtime attach nudges waiting idle emitters after registering session listeners", () => {
  const calls = [];
  const registeredEvents = [];
  let idle = false;
  const sessionPort = {
    attach(session) {
      calls.push(["attach", session.id]);
      idle = false;
    },
    current: () => ({ id: "s1", label: "Test session" }),
    isAttached: () => true,
    setIdle(nextIdle) {
      calls.push(["setIdle", nextIdle]);
      idle = nextIdle === true;
    },
    isIdle: () => idle,
    async log() {},
    async send() {},
    async sendAndWait() {
      return "";
    },
    registerTools() {},
    async reloadExtension() {}
  };
  const supervisor = {
    onSessionIdle() {
      calls.push(["onSessionIdle"]);
    },
    onSessionActivity() {
      calls.push(["onSessionActivity"]);
    }
  };
  const runtime = createTapRuntimeService({
    cwd: "C:/repo",
    sessionPort,
    supervisor
  });
  const session = {
    id: "s1",
    on(eventType) {
      registeredEvents.push(eventType);
      calls.push(["on", eventType]);
      return () => {};
    }
  };

  runtime.attachSession(session);

  assert.equal(idle, true);
  assert.equal(calls[0][0], "attach");
  assert.deepEqual(calls.slice(-2), [["setIdle", true], ["onSessionIdle"]]);
  assert.ok(registeredEvents.includes("session.idle"));
  assert.ok(registeredEvents.includes("user.message"));
  assert.ok(calls.slice(1, -2).every(([type]) => type === "on"));
});

test("runtime startEmitter forwards explicit options while applying base cwd fallback", async () => {
  const calls = [];
  const supervisor = {
    list: () => [],
    has: () => false,
    get: () => null,
    async start(spec, options) {
      calls.push({ spec, options });
      return {
        name: spec.name,
        description: spec.description,
        status: EMITTER_STATUS.QUEUED,
        lifespan: spec.scope,
        ownership: spec.managedBy,
        emitterType: spec.emitterType,
        runSchedule: spec.runSchedule,
        stream: spec.channel,
        cwd: options.baseCwd,
        command: spec.command,
        prompt: spec.prompt,
        every: spec.every,
        everyMs: spec.everyMs,
        everySchedule: spec.everySchedule,
        everyScheduleMs: spec.everyScheduleMs,
        maxRuns: spec.maxRuns,
        autoStart: spec.autoStart,
        includeStderr: spec.includeStderr,
        eventFilter: spec.eventFilter
      };
    },
    stop: async () => {},
    stopAll: async () => {},
    stopAllAndWait: async () => [],
    updateEventFilter: () => {},
    onSessionIdle() {},
    onSessionActivity() {}
  };
  const runtime = createTapRuntimeService({
    cwd: "C:/repo",
    supervisor,
    sessionPort: createSessionPortHarness().port
  });

  await runtime.startEmitter(
    {
      name: "Explicit Options",
      prompt: "check status",
      lifespan: LIFESPAN.PERSISTENT,
      ownership: OWNERSHIP.USER_OWNED
    },
    {
      baseCwd: "C:/custom",
      persistConfig: false,
      preserveExistingSessionInjector: true,
      force: true,
      subscribe: false,
      delivery: EVENT_OUTCOME.INJECT
    }
  );
  await runtime.startEmitter(
    {
      name: "Fallback Cwd",
      prompt: "check status"
    },
    {
      persistConfig: false
    }
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, {
    baseCwd: "C:/custom",
    persistConfig: false,
    preserveExistingSessionInjector: true,
    force: true,
    subscribe: false,
    delivery: EVENT_OUTCOME.INJECT
  });
  assert.deepEqual(calls[1].options, {
    persistConfig: false,
    baseCwd: "C:/repo"
  });
});

test("runtime delivers provider push levels to streams, timeline, and injector", async () => {
  const sessionPort = createSessionPortHarness();
  const runtime = createTapRuntimeService({
    cwd: "C:/repo",
    sessionPort: sessionPort.port
  });

  runtime.provider.deliverPush(
    { providerId: "p-detour", providerName: "detour", sessionId: "s1" },
    { level: EVENT_OUTCOME.KEEP, event: "stored only", stream: "detour", metadata: { clientId: "tab-1" } }
  );
  runtime.provider.deliverPush(
    { providerId: "p-detour", providerName: "detour", sessionId: "s1" },
    { level: EVENT_OUTCOME.SURFACE, event: "show this", stream: "detour" }
  );
  runtime.provider.deliverPush(
    { providerId: "p-detour", providerName: "detour", sessionId: "s1" },
    { level: EVENT_OUTCOME.INJECT, event: "interrupt for this", stream: "detour" }
  );

  await Promise.resolve();
  await Promise.resolve();

  const stream = runtime.getStreamState("detour");
  assert.deepEqual(stream.entries.map((entry) => ({
    source: entry.source,
    text: entry.text,
    monitorName: entry.monitorName,
    stream: entry.stream,
    metadata: entry.metadata
  })), [
    {
      source: SOURCE.PROVIDER,
      text: "stored only",
      monitorName: "detour",
      stream: EVENT_OUTCOME.KEEP,
      metadata: { clientId: "tab-1" }
    },
    {
      source: SOURCE.PROVIDER,
      text: "show this",
      monitorName: "detour",
      stream: EVENT_OUTCOME.SURFACE,
      metadata: undefined
    },
    {
      source: SOURCE.PROVIDER,
      text: "interrupt for this",
      monitorName: "detour",
      stream: EVENT_OUTCOME.INJECT,
      metadata: undefined
    }
  ]);
  assert.equal(sessionPort.logs.length, 2);
  assert.match(sessionPort.logs[0].message, /show this/);
  assert.match(sessionPort.logs[1].message, /interrupt for this/);
  assert.equal(sessionPort.prompts.length, 1);
  assert.match(sessionPort.prompts[0], /interrupt for this/);
});

test("runtime canonicalizes provider push stream names consistently", async () => {
  const sessionPort = createSessionPortHarness();
  const runtime = createTapRuntimeService({
    cwd: "C:/repo",
    sessionPort: sessionPort.port
  });

  const result = runtime.provider.deliverPush(
    { providerId: "p-detour", providerName: "detour", sessionId: "s1" },
    { level: EVENT_OUTCOME.SURFACE, event: "canonical destination", stream: " Detour Events " }
  );

  await Promise.resolve();

  assert.equal(result.stream, "detour-events");
  assert.equal(runtime.getStreamState("detour-events").entries[0].text, "canonical destination");
  assert.match(sessionPort.logs[0].message, /stream 'detour-events'/);
  assert.deepEqual(runtime.listStreams().map((stream) => stream.name), ["detour-events", "main"]);
});

test("runtime rejects invalid provider push stream without appending to main", () => {
  const sessionPort = createSessionPortHarness();
  const runtime = createTapRuntimeService({
    cwd: "C:/repo",
    sessionPort: sessionPort.port
  });

  runtime.appendStreamMessage("main", {
    source: SOURCE.SYSTEM,
    text: "existing main event"
  });
  const beforeMainEntries = runtime.getStreamState("main").entries.length;

  assert.throws(
    () => runtime.provider.deliverPush(
      { providerId: "p-detour", providerName: "detour", sessionId: "s1" },
      { level: EVENT_OUTCOME.SURFACE, event: "should not reach main", stream: "!!!" }
    ),
    ValidationError
  );

  assert.equal(runtime.getStreamState("main").entries.length, beforeMainEntries);
  assert.equal(sessionPort.logs.length, 0);
  assert.equal(sessionPort.prompts.length, 0);
});

test("runtime provider push surfacing swallows rejected session logging", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  const sessionPort = createSessionPortHarness();
  sessionPort.port.log = async () => {
    throw new Error("timeline unavailable");
  };
  const runtime = createTapRuntimeService({
    cwd: "C:/repo",
    sessionPort: sessionPort.port
  });

  const result = runtime.provider.deliverPush(
    { providerId: "p-detour", providerName: "detour", sessionId: "s1" },
    { level: EVENT_OUTCOME.SURFACE, event: "show despite log failure", stream: "detour" }
  );

  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.stream, "detour");
  assert.equal(runtime.getStreamState("detour").entries[0].text, "show despite log failure");
  assert.deepEqual(unhandled, []);
});
