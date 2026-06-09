import test from "node:test";
import assert from "node:assert/strict";

import { createCopilotChannelsRuntime } from "./tap-runtime.mjs";

function createFakeGateway() {
  const broadcasts = [];
  let stopCalls = 0;
  let running = false;
  return {
    broadcasts,
    get stopCalls() {
      return stopCalls;
    },
    onToolsChanged() {},
    isRunning: () => running,
    start() {
      running = true;
    },
    stop() {
      stopCalls += 1;
      running = false;
    },
    getAllTools: (tools) => tools,
    broadcastLifecycle(sessionId, state, deadline) {
      broadcasts.push({ sessionId, state, deadline });
    }
  };
}

function createFakeSession(id = "s1") {
  const handlers = [];
  const logs = [];
  return {
    id,
    logs,
    on(event, handler) {
      if (event !== "session.shutdown") {
        return () => {};
      }
      const entry = { handler, active: true };
      handlers.push(entry);
      return () => {
        entry.active = false;
      };
    },
    emitShutdown() {
      for (const entry of handlers.filter((candidate) => candidate.active)) {
        entry.handler();
      }
    },
    activeShutdownListenerCount() {
      return handlers.filter((candidate) => candidate.active).length;
    },
    async log(message, options) {
      logs.push({ message, options });
    }
  };
}

test("runtime owns one effective shutdown listener and logs cleanup rejection", async () => {
  const gateway = createFakeGateway();
  const session = createFakeSession();
  let stopCalls = 0;
  const supervisor = {
    list: () => [],
    has: () => false,
    get: () => null,
    start: async () => {
      throw new Error("not used");
    },
    stop: async () => {},
    stopAll: async () => {},
    stopAllAndWait: async () => {
      stopCalls += 1;
      throw new Error("cleanup boom");
    },
    updateEventFilter: () => {},
    onSessionIdle() {},
    onSessionActivity() {}
  };
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };

  try {
    const runtime = createCopilotChannelsRuntime({
      cwd: process.cwd(),
      gateway,
      runtimeServiceOptions: { supervisor }
    });

    runtime.attachSession(session);
    runtime.attachSession(session);

    assert.equal(session.activeShutdownListenerCount(), 1);

    session.emitShutdown();
    session.emitShutdown();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stopCalls, 1);
    assert.equal(gateway.broadcasts.length, 1);
    assert.ok(writes.some((entry) => /session\.shutdown cleanup failed:.*cleanup boom/s.test(entry)));
    assert.ok(session.logs.some((entry) => /cleanup boom/.test(entry.message)));
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("session end uses idempotent gateway-aware shutdown and reports emitter outcomes", async () => {
  const gateway = createFakeGateway();
  const session = createFakeSession();
  const clears = [];
  const stopOptions = [];
  const stopOutcomes = [
    { name: "fast", status: "stopped", timedOut: false, outcome: "stopped" },
    { name: "slow", status: "stopping", timedOut: true, outcome: "timedOut" },
    { name: "bad", status: "running", outcome: "failed", error: "stop exploded" }
  ];
  const supervisor = {
    list: () => [],
    has: () => false,
    get: () => null,
    start: async () => {
      throw new Error("not used");
    },
    stop: async () => {},
    stopAll: async () => {},
    stopAllAndWait: async (options) => {
      stopOptions.push(options);
      return stopOutcomes;
    },
    updateEventFilter: () => {},
    onSessionIdle() {},
    onSessionActivity() {}
  };
  const notifications = {
    enqueue() {},
    clear(options) {
      clears.push(options);
      return { cleared: 0 };
    }
  };

  const runtime = createCopilotChannelsRuntime({
    cwd: process.cwd(),
    gateway,
    runtimeServiceOptions: { supervisor, notifications }
  });

  runtime.attachSession(session);

  const summary = await runtime.hooks.onSessionEnd();
  session.emitShutdown();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(gateway.broadcasts.length, 1);
  assert.equal(gateway.broadcasts[0].sessionId, "s1");
  assert.equal(gateway.stopCalls, 1);
  assert.equal(stopOptions.length, 1);
  assert.equal(stopOptions[0].clearNotifications, true);
  assert.equal(clears.length, 1);
  assert.equal(clears[0].reason, "session-shutdown");
  assert.equal(clears[0].generation, true);
  assert.match(summary.cleanupActions.join("\n"), /Stopped 1 session emitter.*fast/);
  assert.match(summary.cleanupActions.join("\n"), /Timed out waiting for 1 session emitter.*slow/);
  assert.match(summary.cleanupActions.join("\n"), /Failed to stop 1 session emitter.*bad.*stop exploded/);
});

test("shutdown idempotency does not suppress cleanup for a newly attached session", async () => {
  const gateway = createFakeGateway();
  const firstSession = createFakeSession("s1");
  const secondSession = createFakeSession("s2");
  const stopOptions = [];
  const releaseStops = [];
  const supervisor = {
    list: () => [],
    has: () => false,
    get: () => null,
    start: async () => {
      throw new Error("not used");
    },
    stop: async () => {},
    stopAll: async () => {},
    stopAllAndWait: async (options) => {
      stopOptions.push(options);
      return await new Promise((resolve) => {
        releaseStops.push(resolve);
      });
    },
    updateEventFilter: () => {},
    onSessionIdle() {},
    onSessionActivity() {}
  };

  const runtime = createCopilotChannelsRuntime({
    cwd: process.cwd(),
    gateway,
    runtimeServiceOptions: { supervisor }
  });

  runtime.attachSession(firstSession);
  firstSession.emitShutdown();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopOptions.length, 1);

  runtime.attachSession(secondSession);
  const secondSummary = runtime.hooks.onSessionEnd();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopOptions.length, 2);
  assert.deepEqual(gateway.broadcasts.map(({ sessionId }) => sessionId), ["s1", "s2"]);

  releaseStops[0]([{ name: "first", status: "stopped", outcome: "stopped" }]);
  releaseStops[1]([{ name: "second", status: "stopped", outcome: "stopped" }]);
  const summary = await secondSummary;

  assert.match(summary.cleanupActions.join("\n"), /second/);
});
