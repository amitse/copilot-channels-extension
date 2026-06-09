import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP, SOURCE } from "../consts.mjs";
import { ValidationError } from "../errors/index.mjs";
import { createStreamStore } from "../streams/store.mjs";
import { createNotificationDispatcher } from "../streams/notifications.mjs";
import { createMockTimerAdapter } from "../test-support/adapters.mjs";
import { createStreamService } from "./stream-service.mjs";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryStreamConfigStore(initialStreams = []) {
  const entries = initialStreams.map((entry) => cloneJson(entry));

  return {
    getStreams: () => entries,
    upsertStream(stream) {
      const next = {
        name: stream.name,
        description: stream.description,
        sessionInjector: { ...stream.sessionInjector }
      };
      const index = entries.findIndex((entry) => entry.name === next.name);
      if (index === -1) {
        entries.push(next);
        return;
      }

      entries[index] = {
        ...entries[index],
        ...next,
        sessionInjector: {
          ...(entries[index].sessionInjector ?? {}),
          ...next.sessionInjector
        }
      };
    }
  };
}

function createServiceHarness(options = {}) {
  const logs = [];
  const streams = createStreamStore();
  const configStore = options.configStore ?? createMemoryStreamConfigStore();
  const service = createStreamService({
    streams,
    configStore,
    persist: options.persist ?? (() => {}),
    sessionPort: {
      log: async (message, options) => {
        logs.push({ message, options });
      }
    }
  });

  return { configStore, logs, service, streams };
}

test("postToStream rejects whitespace-only messages without creating the stream", () => {
  const { service, streams } = createServiceHarness();

  assert.throws(
    () => service.postToStream({
      channel: "notes",
      message: " \n\t ",
      source: SOURCE.TOOL
    }),
    ValidationError
  );
  assert.equal(streams.get("notes"), undefined);
  assert.equal(streams.size(), 0);
});

test("stream store append ignores whitespace-only entries without creating the stream", () => {
  const streams = createStreamStore();

  assert.equal(streams.append("ghost", { text: " \n\t " }), null);
  assert.equal(streams.get("ghost"), undefined);
  assert.equal(streams.size(), 0);
});

test("stream store append rejects invalid stream names without defaulting to main", () => {
  const streams = createStreamStore();
  streams.append("main", { text: "existing main event", source: SOURCE.SYSTEM });
  const mainEntryCount = streams.get("main").entries.length;

  assert.throws(
    () => streams.append("!!!", { text: "should not reach main", source: SOURCE.PROVIDER }),
    ValidationError
  );

  assert.equal(streams.get("main").entries.length, mainEntryCount);
  assert.equal(streams.size(), 1);
});

test("stream operations reject invalid channels before defaulting to main", () => {
  const { service, streams } = createServiceHarness();
  const { stream } = service.postToStream({
    channel: "main",
    message: "existing main event",
    source: SOURCE.TOOL
  });
  const mainStream = streams.get(stream.name);
  const mainEntryCount = mainStream.entries.length;
  const invalidChannels = [
    undefined,
    "",
    " \n\t ",
    123,
    { name: "main" },
    "!!!"
  ];

  for (const channel of invalidChannels) {
    assert.throws(
      () => service.postToStream({
        channel,
        message: "should not reach main",
        source: SOURCE.TOOL
      }),
      ValidationError
    );
    assert.throws(
      () => service.getStreamHistory(channel, 1),
      ValidationError
    );
    assert.throws(
      () => service.getStreamState(channel),
      ValidationError
    );
    assert.throws(
      () => service.setInjectorPolicy(channel, { enabled: true }),
      ValidationError
    );
    assert.throws(
      () => service.setInjectorPolicy(channel, { enabled: false }),
      ValidationError
    );
  }

  assert.equal(streams.get("main").entries.length, mainEntryCount);
  assert.equal(streams.get("main").sessionInjector.enabled, false);
});

test("stream operations still accept explicit main stream identifiers", () => {
  const { service, streams } = createServiceHarness();

  service.postToStream({
    channel: " Main ",
    message: "hello main",
    source: SOURCE.TOOL
  });
  const { stream } = service.getStreamHistory("MAIN", 1);
  const state = service.getStreamState("MAIN");

  assert.equal(stream.name, "main");
  assert.equal(state.name, "main");
  assert.deepEqual(streams.get("main").entries.map(({ text }) => text), ["hello main"]);

  service.setInjectorPolicy("main", { enabled: true });
  assert.equal(streams.get("main").sessionInjector.enabled, true);
});

test("policy-only injector updates preserve enabled state", () => {
  const { configStore, service, streams } = createServiceHarness();

  service.setInjectorPolicy("ops", { enabled: true });
  service.setInjectorPolicy("ops", {
    delivery: EVENT_OUTCOME.INJECT,
    lifespan: LIFESPAN.PERSISTENT,
    ownership: OWNERSHIP.USER_OWNED
  });

  const injector = streams.get("ops").sessionInjector;
  assert.equal(injector.enabled, true);
  assert.equal(injector.delivery, EVENT_OUTCOME.INJECT);
  assert.equal(injector.lifespan, LIFESPAN.PERSISTENT);
  assert.equal(injector.ownership, OWNERSHIP.USER_OWNED);
  assert.deepEqual(configStore.getStreams().map((entry) => entry.sessionInjector), [
    {
      enabled: true,
      delivery: EVENT_OUTCOME.INJECT,
      lifespan: LIFESPAN.PERSISTENT,
      ownership: OWNERSHIP.USER_OWNED
    }
  ]);
});

test("persistent injector persist failure restores runtime and config state", () => {
  const previousConfigEntry = {
    name: "ops",
    description: "saved stream",
    sessionInjector: {
      enabled: true,
      delivery: EVENT_OUTCOME.KEEP,
      lifespan: LIFESPAN.PERSISTENT,
      ownership: OWNERSHIP.USER_OWNED
    }
  };
  const configStore = createMemoryStreamConfigStore([previousConfigEntry]);
  let persistAttempts = 0;
  const { logs, service, streams } = createServiceHarness({
    configStore,
    persist() {
      persistAttempts += 1;
      throw new Error("disk full");
    }
  });
  streams.applyPersistentStream(previousConfigEntry);

  assert.throws(
    () => service.setInjectorPolicy("ops", {
      enabled: false,
      delivery: EVENT_OUTCOME.INJECT,
      description: "new description",
      lifespan: LIFESPAN.PERSISTENT,
      ownership: OWNERSHIP.USER_OWNED,
      force: true
    }),
    /disk full/
  );

  assert.equal(persistAttempts, 1);
  assert.equal(streams.get("ops").description, previousConfigEntry.description);
  assert.deepEqual(streams.get("ops").sessionInjector, previousConfigEntry.sessionInjector);
  assert.deepEqual(configStore.getStreams(), [previousConfigEntry]);
  assert.deepEqual(logs, []);
});

test("persistent stream application rejects invalid names before touching main", () => {
  const streams = createStreamStore();
  const main = streams.ensure("main");

  assert.throws(
    () => streams.applyPersistentStream({
      sessionInjector: {
        enabled: true
      }
    }),
    ValidationError
  );
  assert.equal(main.sessionInjector.enabled, false);
});

test("bare persistent stream application preserves metadata without protecting injector policy", () => {
  const streams = createStreamStore();

  const stream = streams.applyPersistentStream({
    name: "Ops Stream",
    description: "Operational telemetry"
  });

  assert.equal(stream.name, "ops-stream");
  assert.equal(stream.description, "Operational telemetry");
  assert.deepEqual(stream.sessionInjector, {
    enabled: false,
    delivery: EVENT_OUTCOME.SURFACE,
    lifespan: LIFESPAN.TEMPORARY,
    ownership: OWNERSHIP.MODEL_OWNED
  });

  const updated = streams.configureSessionInjector("ops-stream", {
    enabled: true,
    delivery: EVENT_OUTCOME.INJECT
  });
  assert.equal(updated.sessionInjector.enabled, true);
  assert.equal(updated.sessionInjector.delivery, EVENT_OUTCOME.INJECT);
  assert.equal(updated.sessionInjector.ownership, OWNERSHIP.MODEL_OWNED);
});

test("persistent stream application preserves explicit injector lifespan aliases", () => {
  const streams = createStreamStore();

  const canonical = streams.applyPersistentStream({
    name: "canonical",
    sessionInjector: {
      enabled: true,
      lifespan: LIFESPAN.TEMPORARY,
      ownership: OWNERSHIP.USER_OWNED
    }
  });
  const legacy = streams.applyPersistentStream({
    name: "legacy",
    sessionInjector: {
      enabled: true,
      scope: LIFESPAN.TEMPORARY,
      managedBy: OWNERSHIP.USER_OWNED
    }
  });
  const defaulted = streams.applyPersistentStream({
    name: "defaulted",
    sessionInjector: {
      enabled: true
    }
  });
  const legacySubscription = streams.applyPersistentStream({
    name: "legacy-subscription",
    subscription: {
      enabled: true,
      scope: LIFESPAN.TEMPORARY,
      managedBy: OWNERSHIP.USER_OWNED
    }
  });

  assert.equal(canonical.sessionInjector.lifespan, LIFESPAN.TEMPORARY);
  assert.equal(legacy.sessionInjector.lifespan, LIFESPAN.TEMPORARY);
  assert.equal(defaulted.sessionInjector.lifespan, LIFESPAN.PERSISTENT);
  assert.equal(legacySubscription.sessionInjector.lifespan, LIFESPAN.TEMPORARY);
  assert.equal(legacySubscription.sessionInjector.ownership, OWNERSHIP.USER_OWNED);
});

test("postToStream appends non-empty messages", () => {
  const { service, streams } = createServiceHarness();

  const { stream } = service.postToStream({
    channel: "notes",
    message: "  hello stream  ",
    source: SOURCE.TOOL
  });

  assert.equal(stream.name, "notes");
  assert.deepEqual(streams.get("notes").entries.map(({ source, text }) => ({ source, text })), [
    { source: SOURCE.TOOL, text: "hello stream" }
  ]);
});

test("notification dispatcher retries unattached session sends without dropping queued updates", async () => {
  const timerAdapter = createMockTimerAdapter();
  const sent = [];
  let attached = false;
  let sendAttempts = 0;
  const dispatcher = createNotificationDispatcher({
    retryDelayMs: 100,
    timerAdapter,
    sessionPort: {
      isAttached: () => true,
      async send(prompt) {
        sendAttempts += 1;
        if (!attached) {
          throw new Error("Session is not attached; cannot send prompt.");
        }
        sent.push(prompt);
      },
      async log() {}
    }
  });

  dispatcher.enqueue({
    channel: "ops",
    monitorName: "ops-watch",
    stream: "stdout",
    text: "urgent update"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendAttempts, 1);
  assert.equal(sent.length, 0);
  assert.equal(timerAdapter.pendingCount, 1);

  dispatcher.enqueue({
    channel: "ops",
    monitorName: "ops-watch",
    stream: "stdout",
    text: "second update"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendAttempts, 1);
  assert.equal(sent.length, 0);

  attached = true;
  timerAdapter.advance(100);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendAttempts, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /urgent update/);
  assert.match(sent[0], /second update/);
});

test("notification dispatcher bounds retry queue and preserves FIFO for retained updates", async () => {
  const timerAdapter = createMockTimerAdapter();
  const sent = [];
  const logs = [];
  let attached = false;
  const dispatcher = createNotificationDispatcher({
    maxQueueSize: 2,
    retryDelayMs: 100,
    timerAdapter,
    sessionPort: {
      isAttached: () => attached,
      async send(prompt) {
        sent.push(prompt);
      },
      async log(message, options) {
        logs.push({ message, options });
      }
    }
  });

  dispatcher.enqueue({
    channel: "ops",
    monitorName: "ops-watch",
    stream: "stdout",
    text: "first retained"
  });
  dispatcher.enqueue({
    channel: "ops",
    monitorName: "ops-watch",
    stream: "stdout",
    text: "second retained"
  });
  const dropped = dispatcher.enqueue({
    channel: "ops",
    monitorName: "ops-watch",
    stream: "stdout",
    text: "dropped newest"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(dropped.accepted, false);
  assert.equal(dropped.reason, "queue-full");
  assert.equal(timerAdapter.pendingCount, 1);
  assert.ok(logs.some(({ message, options }) =>
    /Dropped 1 monitor update because notification retry queue is full/.test(message) &&
    options?.level === "warning"
  ));

  attached = true;
  timerAdapter.advance(100);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /first retained/);
  assert.match(sent[0], /second retained/);
  assert.doesNotMatch(sent[0], /dropped newest/);
});

test("notification dispatcher clear cancels stale retries across session generations", async () => {
  const timerAdapter = createMockTimerAdapter();
  const sent = [];
  const logs = [];
  let attached = false;
  const dispatcher = createNotificationDispatcher({
    retryDelayMs: 100,
    timerAdapter,
    sessionPort: {
      isAttached: () => attached,
      async send(prompt) {
        sent.push(prompt);
      },
      async log(message, options) {
        logs.push({ message, options });
      }
    }
  });

  dispatcher.enqueue({
    channel: "ops",
    monitorName: "ops-watch",
    stream: "stdout",
    text: "old session update"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timerAdapter.pendingCount, 1);
  const clearResult = dispatcher.clear({ reason: "session-shutdown", generation: true });

  assert.equal(clearResult.cleared, 1);
  assert.equal(timerAdapter.pendingCount, 0);
  assert.ok(logs.some(({ message, options }) =>
    /Cleared 1 queued monitor update during session-shutdown/.test(message) &&
    options?.level === "info"
  ));

  attached = true;
  timerAdapter.advance(100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);

  dispatcher.enqueue({
    channel: "ops",
    monitorName: "ops-watch",
    stream: "stdout",
    text: "new session update"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /new session update/);
  assert.doesNotMatch(sent[0], /old session update/);
});
