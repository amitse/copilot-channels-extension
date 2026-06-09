import test from "node:test";
import assert from "node:assert/strict";

import { EMITTER_OPERATION_STATUS, EMITTER_STATUS, EVENT_OUTCOME, LIFESPAN, OWNERSHIP, SOURCE } from "../consts.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import { createConfigBootstrapService } from "../services/config-bootstrap-service.mjs";
import { createRuntimeSessionContext } from "../session/runtime-context.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { createEmitterSupervisor } from "./supervisor.mjs";

function entryFromEmitter(emitter) {
  return {
    name: emitter.name,
    command: emitter.command,
    prompt: emitter.prompt,
    stream: emitter.stream,
    channel: emitter.stream,
    autoStart: emitter.autoStart,
    includeStderr: emitter.includeStderr,
    ...(emitter.subscribe === false ? { subscribe: false } : {}),
    ...(emitter.delivery !== undefined && emitter.delivery !== EVENT_OUTCOME.SURFACE ? { delivery: emitter.delivery } : {}),
    ownership: emitter.ownership,
    lifespan: emitter.lifespan,
    eventFilter: EventFilterService.serialize(emitter.eventFilter)
  };
}

function createSupervisorHarness(initialEmitters = [], options = {}) {
  const streamEntries = new Map();
  const persistentStreamEntries = options.initialStreams ?? [];
  const emitterEntries = new Map(
    initialEmitters.map((entry) => [normalizeName(entry.name), { ...entry }])
  );
  const persistCalls = [];
  const logs = [];
  const enqueued = [];
  const streams = {
    ensure(rawName, description = "") {
      const name = normalizeName(rawName, "main");
      if (!streamEntries.has(name)) {
        streamEntries.set(name, {
          name,
          description: String(description ?? "").trim(),
          entries: [],
          sessionInjector: {
            enabled: false,
            delivery: EVENT_OUTCOME.SURFACE,
            ownership: OWNERSHIP.MODEL_OWNED,
            lifespan: LIFESPAN.TEMPORARY
          }
        });
      }
      return streamEntries.get(name);
    },
    get(rawName) {
      return streamEntries.get(normalizeName(rawName));
    },
    applyPersistentStream(entry) {
      const stream = this.ensure(entry.name, entry.description ?? "");
      const configInjector = Object.prototype.toString.call(entry?.sessionInjector) === "[object Object]"
        ? entry.sessionInjector
        : Object.prototype.toString.call(entry?.subscription) === "[object Object]"
          ? entry.subscription
          : null;
      if (Object.hasOwn(entry ?? {}, "description")) {
        stream.description = String(entry.description ?? "").trim();
      }
      if (!configInjector) {
        stream.sessionInjector = {
          enabled: false,
          delivery: EVENT_OUTCOME.SURFACE,
          ownership: OWNERSHIP.MODEL_OWNED,
          lifespan: LIFESPAN.TEMPORARY
        };
        return stream;
      }
      stream.sessionInjector = {
        enabled: configInjector.enabled === true,
        delivery: configInjector.delivery ?? EVENT_OUTCOME.SURFACE,
        ownership: configInjector.ownership ?? configInjector.managedBy ?? OWNERSHIP.USER_OWNED,
        lifespan: configInjector.lifespan ?? configInjector.scope ?? LIFESPAN.PERSISTENT
      };
      return stream;
    },
    append(rawName, entry) {
      const stream = this.ensure(rawName);
      stream.entries.push({
        source: entry.source ?? SOURCE.SYSTEM,
        text: String(entry.text ?? "").trim(),
        monitorName: entry.monitorName ?? null,
        stream: entry.stream ?? null
      });
    },
    configureSessionInjector(rawName, injectorOptions = {}) {
      const stream = this.ensure(rawName, injectorOptions.description ?? "");
      const defaultConfigure = () => {
        stream.sessionInjector = {
          enabled: injectorOptions.enabled === true,
          delivery: injectorOptions.delivery ?? stream.sessionInjector.delivery,
          ownership: injectorOptions.managedBy ?? injectorOptions.ownership ?? stream.sessionInjector.ownership,
          lifespan: injectorOptions.scope ?? injectorOptions.lifespan ?? stream.sessionInjector.lifespan
        };
        return stream;
      };

      if (typeof options.configureSessionInjector === "function") {
        return options.configureSessionInjector(rawName, injectorOptions, defaultConfigure, stream);
      }

      return defaultConfigure();
    }
  };
  const configStore = {
    load() {
      return options.configLoad ?? { found: true, filePath: "tap.config.json" };
    },
    getStreams() {
      return persistentStreamEntries;
    },
    getEmitters() {
      return [...emitterEntries.values()];
    },
    findEmitter(name) {
      return emitterEntries.get(normalizeName(name)) ?? null;
    },
    upsertEmitter(emitter) {
      const defaultUpsertEmitter = () => {
        emitterEntries.set(normalizeName(emitter.name), entryFromEmitter(emitter));
      };
      if (typeof options.upsertEmitter === "function") {
        return options.upsertEmitter(emitter, defaultUpsertEmitter);
      }
      return defaultUpsertEmitter();
    },
    upsertStream(stream) {
      const defaultUpsertStream = () => {
        const entry = {
          name: stream.name,
          description: stream.description,
          sessionInjector: { ...stream.sessionInjector }
        };
        const index = persistentStreamEntries.findIndex((candidate) => normalizeName(candidate.name) === normalizeName(stream.name));
        if (index === -1) {
          persistentStreamEntries.push(entry);
        } else {
          persistentStreamEntries[index] = entry;
        }
      };
      if (typeof options.upsertStream === "function") {
        return options.upsertStream(stream, defaultUpsertStream);
      }
      return defaultUpsertStream();
    },
    removeEmitter(name) {
      const normalized = normalizeName(name);
      if (!emitterEntries.has(normalized)) {
        return false;
      }
      emitterEntries.delete(normalized);
      return true;
    }
  };
  const sessionPort = {
    isIdle: () => false,
    send: async () => {},
    log: async (message, options) => {
      logs.push({ message, options });
    }
  };
  const notifications = options.notifications ?? {
    enqueue(entry) {
      enqueued.push(entry);
    }
  };
  const lifecycle = typeof options.lifecycle === "function"
    ? options.lifecycle({ streams, notifications, logs })
    : options.lifecycle;
  const sessionContext = options.sessionContext ?? createRuntimeSessionContext({ cwd: options.cwd ?? process.cwd() });
  const supervisor = createEmitterSupervisor({
    streams,
    configStore,
    notifications,
    sessionPort,
    emitterWorkspace: sessionContext.emitterWorkspace,
    persist: options.persist ?? (() => {
      persistCalls.push(true);
    }),
    lifecycle
  });

  return { supervisor, configStore, persistCalls, logs, enqueued, streams, streamEntries, sessionPort, sessionContext };
}

test("subscribe setup failure leaves no running emitter and restores injector state", async () => {
  let lifecycleStarts = 0;
  const { supervisor, streamEntries } = createSupervisorHarness([], {
    configureSessionInjector(_rawName, _injectorOptions, defaultConfigure) {
      defaultConfigure();
      throw new Error("policy failed");
    },
    lifecycle: {
      start() {
        lifecycleStarts += 1;
      },
      stop: async () => {},
      onSessionIdle() {},
      onSessionActivity() {}
    }
  });

  await assert.rejects(
    () => supervisor.start({
      name: "Sub Fail",
      prompt: "hello",
      subscribe: true
    }),
    /policy failed/
  );

  assert.equal(lifecycleStarts, 0);
  assert.equal(supervisor.has("sub-fail"), false);
  assert.equal(streamEntries.get("sub-fail").sessionInjector.enabled, false);
  assert.equal(streamEntries.get("sub-fail").sessionInjector.ownership, OWNERSHIP.MODEL_OWNED);
  assert.equal(streamEntries.get("sub-fail").sessionInjector.lifespan, LIFESPAN.TEMPORARY);
});

test("subscribe=true policy is active before lifecycle can route first output", async () => {
  const { supervisor, enqueued, streamEntries } = createSupervisorHarness([], {
    lifecycle: ({ streams, notifications }) => ({
      start(emitter) {
        const stream = streams.ensure(emitter.stream);
        assert.equal(stream.sessionInjector.enabled, true);
        assert.equal(stream.sessionInjector.delivery, EVENT_OUTCOME.INJECT);

        streams.append(emitter.stream, {
          source: SOURCE.EMITTER,
          text: "first fast line",
          monitorName: emitter.name
        });
        notifications.enqueue({
          channel: emitter.stream,
          monitorName: emitter.name,
          text: "first fast line"
        });
      },
      stop: async () => {},
      onSessionIdle() {},
      onSessionActivity() {}
    })
  });

  await supervisor.start({
    name: "Fast Output",
    command: "emit immediately",
    subscribe: true,
    delivery: EVENT_OUTCOME.INJECT
  });

  assert.deepEqual(
    streamEntries.get("fast-output").entries.map((entry) => entry.text),
    ["first fast line"]
  );
  assert.deepEqual(enqueued.map((entry) => entry.text), ["first fast line"]);
});

test("bootstrap auto-start preserves default subscription when no stream injector is configured", async () => {
  const { supervisor, configStore, enqueued, streams, streamEntries, sessionPort, sessionContext } = createSupervisorHarness([
    {
      name: "Ops Watch",
      command: "emit urgently",
      stream: "ops-watch",
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT,
      eventFilter: {
        rules: [{ match: "urgent", outcome: EVENT_OUTCOME.INJECT }],
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.PERSISTENT
      }
    }
  ], {
    lifecycle: ({ streams: lifecycleStreams, notifications }) => ({
      start(emitter) {
        const stream = lifecycleStreams.ensure(emitter.stream);
        assert.equal(stream.sessionInjector.enabled, true);
        assert.equal(stream.sessionInjector.lifespan, LIFESPAN.PERSISTENT);
        notifications.enqueue({
          channel: emitter.stream,
          monitorName: emitter.name,
          text: "urgent line"
        });
      },
      stop: async () => {},
      onSessionIdle() {},
      onSessionActivity() {}
    })
  });
  const bootstrap = createConfigBootstrapService({
    streams,
    configStore,
    supervisor,
    sessionPort,
    configWorkspace: sessionContext.configWorkspace
  });

  await bootstrap.loadPersistentConfig(process.cwd());

  assert.equal(streamEntries.get("ops-watch").sessionInjector.enabled, true);
  assert.deepEqual(enqueued.map((entry) => entry.text), ["urgent line"]);
});

test("bootstrap auto-start does not override an existing persistent stream injector", async () => {
  const { supervisor, configStore, streams, streamEntries, sessionPort, sessionContext } = createSupervisorHarness([
    {
      name: "Ops Watch",
      command: "emit urgently",
      stream: "ops-watch",
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT,
      eventFilter: {
        rules: [{ match: "urgent", outcome: EVENT_OUTCOME.INJECT }],
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.PERSISTENT
      }
    }
  ], {
    initialStreams: [
      {
        name: "ops-watch",
        sessionInjector: {
          enabled: false,
          delivery: EVENT_OUTCOME.SURFACE,
          ownership: OWNERSHIP.USER_OWNED,
          lifespan: LIFESPAN.PERSISTENT
        }
      }
    ],
    lifecycle: ({ streams: lifecycleStreams }) => ({
      start(emitter) {
        const injector = lifecycleStreams.ensure(emitter.stream).sessionInjector;
        assert.equal(injector.enabled, false);
        assert.equal(injector.delivery, EVENT_OUTCOME.SURFACE);
        assert.equal(injector.ownership, OWNERSHIP.USER_OWNED);
        assert.equal(injector.lifespan, LIFESPAN.PERSISTENT);
      },
      stop: async () => {},
      onSessionIdle() {},
      onSessionActivity() {}
    })
  });
  const bootstrap = createConfigBootstrapService({
    streams,
    configStore,
    supervisor,
    sessionPort,
    configWorkspace: sessionContext.configWorkspace
  });

  await bootstrap.loadPersistentConfig(process.cwd());

  assert.equal(supervisor.get("ops-watch").subscribe, true);
  assert.equal("subscribe" in configStore.findEmitter("ops-watch"), false);
  assert.deepEqual(streamEntries.get("ops-watch").sessionInjector, {
    enabled: false,
    delivery: EVENT_OUTCOME.SURFACE,
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });
});

test("bootstrap auto-start respects explicit subscribe false without stream config", async () => {
  const { supervisor, configStore, streams, streamEntries, sessionPort, sessionContext } = createSupervisorHarness([
    {
      name: "Quiet Watch",
      command: "emit quietly",
      stream: "quiet-watch",
      subscribe: false,
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT,
      eventFilter: {
        rules: [{ match: "urgent", outcome: EVENT_OUTCOME.INJECT }],
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.PERSISTENT
      }
    }
  ], {
    lifecycle: ({ streams: lifecycleStreams }) => ({
      start(emitter) {
        assert.equal(lifecycleStreams.ensure(emitter.stream).sessionInjector.enabled, false);
      },
      stop: async () => {},
      onSessionIdle() {},
      onSessionActivity() {}
    })
  });
  const bootstrap = createConfigBootstrapService({
    streams,
    configStore,
    supervisor,
    sessionPort,
    configWorkspace: sessionContext.configWorkspace
  });

  await bootstrap.loadPersistentConfig(process.cwd());

  assert.equal(streamEntries.get("quiet-watch").sessionInjector.enabled, false);
  assert.equal(streamEntries.get("quiet-watch").sessionInjector.lifespan, LIFESPAN.TEMPORARY);
});

test("bootstrap auto-start restoration does not rewrite already persisted config", async () => {
  const persistedEmitter = {
    name: "Restored Watch",
    command: "echo ok",
    stream: "restored-watch",
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT,
    eventFilter: {
      rules: [{ match: "ok", outcome: EVENT_OUTCOME.INJECT }],
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    }
  };
  let upsertEmitterAttempts = 0;
  let upsertStreamAttempts = 0;
  let persistAttempts = 0;
  const { supervisor, configStore, streams, sessionPort, logs, sessionContext } = createSupervisorHarness([persistedEmitter], {
    upsertEmitter() {
      upsertEmitterAttempts += 1;
      throw new Error("auto-start should not rewrite emitter config");
    },
    upsertStream() {
      upsertStreamAttempts += 1;
      throw new Error("auto-start should not rewrite stream config");
    },
    persist() {
      persistAttempts += 1;
      throw new Error("auto-start should not save config");
    },
    lifecycle: ({ streams: lifecycleStreams }) => ({
      start(emitter) {
        const injector = lifecycleStreams.ensure(emitter.stream).sessionInjector;
        assert.equal(injector.enabled, true);
        assert.equal(injector.lifespan, LIFESPAN.PERSISTENT);
      },
      stop: async () => {},
      onSessionIdle() {},
      onSessionActivity() {}
    })
  });
  const bootstrap = createConfigBootstrapService({
    streams,
    configStore,
    supervisor,
    sessionPort,
    configWorkspace: sessionContext.configWorkspace
  });

  const summary = await bootstrap.loadPersistentConfig(process.cwd());

  assert.match(summary, /Auto-started 1\./);
  assert.equal(supervisor.has("restored-watch"), true);
  assert.equal(upsertEmitterAttempts, 0);
  assert.equal(upsertStreamAttempts, 0);
  assert.equal(persistAttempts, 0);
  assert.equal(logs.some(({ message }) => message.includes("Failed to auto-start")), false);
  assert.equal(configStore.findEmitter("restored-watch").command, persistedEmitter.command);
});

test("persistent start cannot overwrite a config-only user-owned temporary emitter without force", async () => {
  let lifecycleStarts = 0;
  const { supervisor, configStore } = createSupervisorHarness([
    {
      name: "Guarded Watch",
      prompt: "old prompt",
      stream: "guarded-watch",
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.TEMPORARY,
      eventFilter: {
        rules: [{ match: "old", outcome: EVENT_OUTCOME.SURFACE }],
        ownership: OWNERSHIP.MODEL_OWNED,
        lifespan: LIFESPAN.TEMPORARY
      }
    }
  ], {
    lifecycle: {
      start() {
        lifecycleStarts += 1;
      },
      stop: async () => {},
      onSessionIdle() {},
      onSessionActivity() {}
    }
  });

  await assert.rejects(
    () => supervisor.start({
      name: "Guarded Watch",
      prompt: "new prompt",
      scope: LIFESPAN.PERSISTENT,
      managedBy: OWNERSHIP.MODEL_OWNED,
      subscribe: false
    }),
    /Emitter 'guarded-watch' is user-controlled/
  );

  assert.equal(lifecycleStarts, 0);
  assert.equal(supervisor.has("guarded-watch"), false);
  assert.equal(configStore.findEmitter("guarded-watch").prompt, "old prompt");
});

test("persistent start cannot overwrite a config-only user-owned event filter under temporary emitter without force", async () => {
  let lifecycleStarts = 0;
  const { supervisor, configStore } = createSupervisorHarness([
    {
      name: "Filter Guard",
      prompt: "old prompt",
      stream: "filter-guard",
      ownership: OWNERSHIP.MODEL_OWNED,
      lifespan: LIFESPAN.TEMPORARY,
      eventFilter: {
        rules: [{ match: "old", outcome: EVENT_OUTCOME.SURFACE }],
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.TEMPORARY
      }
    }
  ], {
    lifecycle: {
      start() {
        lifecycleStarts += 1;
      },
      stop: async () => {},
      onSessionIdle() {},
      onSessionActivity() {}
    }
  });

  await assert.rejects(
    () => supervisor.start({
      name: "Filter Guard",
      prompt: "new prompt",
      scope: LIFESPAN.PERSISTENT,
      managedBy: OWNERSHIP.MODEL_OWNED,
      subscribe: false,
      eventFilter: {
        rules: [{ match: "new", outcome: EVENT_OUTCOME.INJECT }]
      }
    }),
    /Event filter for emitter 'filter-guard' is user-controlled/
  );

  assert.equal(lifecycleStarts, 0);
  assert.equal(supervisor.has("filter-guard"), false);
  assert.deepEqual(configStore.findEmitter("filter-guard").eventFilter, {
    rules: [{ match: "old", outcome: EVENT_OUTCOME.SURFACE }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.TEMPORARY
  });
});

test("persistent start persists explicit subscribe false and delivery policy", async () => {
  const { supervisor, configStore } = createSupervisorHarness([], {
    lifecycle: {
      start() {},
      stop: async () => {},
      onSessionIdle() {},
      onSessionActivity() {}
    }
  });

  await supervisor.start({
    name: "Quiet Delivery",
    prompt: "check quietly",
    scope: LIFESPAN.PERSISTENT,
    managedBy: OWNERSHIP.MODEL_OWNED,
    subscribe: false,
    delivery: EVENT_OUTCOME.INJECT
  });

  assert.equal(configStore.findEmitter("quiet-delivery").subscribe, false);
  assert.equal(configStore.findEmitter("quiet-delivery").delivery, EVENT_OUTCOME.INJECT);
});

test("persistent start persistence failure rolls back newly-started emitter with wait path", async () => {
  const waited = [];
  const { supervisor, configStore, streamEntries } = createSupervisorHarness([], {
    persist() {
      throw new Error("disk full");
    },
    lifecycle: {
      start() {},
      async stop(emitter) {
        throw new Error(`plain stop should not roll back ${emitter.name}`);
      },
      async stopAndWait(emitter, options) {
        waited.push({ name: emitter.name, options });
        emitter.status = EMITTER_STATUS.STOPPED;
      },
      onSessionIdle() {},
      onSessionActivity() {}
    }
  });

  await assert.rejects(
    () => supervisor.start({
      name: "Persist Fail",
      prompt: "check status",
      scope: LIFESPAN.PERSISTENT,
      managedBy: OWNERSHIP.USER_OWNED,
      subscribe: true
    }),
    /disk full/
  );

  assert.deepEqual(waited, [{ name: "persist-fail", options: { timeoutMs: 10_000 } }]);
  assert.equal(supervisor.has("persist-fail"), false);
  assert.equal(configStore.findEmitter("persist-fail"), null);
  assert.equal(configStore.getStreams().some((stream) => stream.name === "persist-fail"), false);
  assert.equal(streamEntries.get("persist-fail").sessionInjector.enabled, false);
  assert.equal(streamEntries.get("persist-fail").sessionInjector.lifespan, LIFESPAN.TEMPORARY);
});

test("persistent start rollback timeout leaves runtime emitter reachable", async () => {
  const { supervisor, configStore } = createSupervisorHarness([], {
    persist() {
      throw new Error("disk full");
    },
    lifecycle: {
      start(emitter) {
        emitter.status = EMITTER_STATUS.RUNNING;
      },
      async stop() {
        throw new Error("plain stop should not run after rollback timeout");
      },
      async stopAndWait(emitter) {
        emitter.status = EMITTER_STATUS.STOPPING;
        return { name: emitter.name, status: emitter.status, timedOut: true };
      },
      onSessionIdle() {},
      onSessionActivity() {}
    }
  });

  await assert.rejects(
    () => supervisor.start({
      name: "Rollback Timeout",
      prompt: "check status",
      scope: LIFESPAN.PERSISTENT,
      managedBy: OWNERSHIP.USER_OWNED,
      subscribe: false
    }),
    /disk full/
  );

  assert.equal(supervisor.get("rollback-timeout").status, EMITTER_STATUS.STOPPING);
  assert.equal(configStore.findEmitter("rollback-timeout"), null);
});

test("persistent stop checks temporary config ownership before stopping runtime emitter", async () => {
  let stopCalls = 0;
  const { supervisor } = createSupervisorHarness([
    {
      name: "Guarded Stop",
      prompt: "persisted prompt",
      stream: "guarded-stop",
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.TEMPORARY,
      eventFilter: {
        rules: [],
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.TEMPORARY
      }
    }
  ], {
    lifecycle: {
      start() {},
      async stop() {
        stopCalls += 1;
      },
      onSessionIdle() {},
      onSessionActivity() {}
    }
  });
  await supervisor.start({
    name: "Guarded Stop",
    prompt: "temporary runtime",
    subscribe: false
  });

  await assert.rejects(
    () => supervisor.stop("Guarded Stop", { scope: LIFESPAN.PERSISTENT }),
    /Emitter 'guarded-stop' is user-controlled/
  );

  assert.equal(stopCalls, 0);
});

test("persistent stop restores config entry when persistence fails after removal", async () => {
  const previousEntry = {
    name: "ops-watch",
    prompt: "check status",
    stream: "ops-watch",
    ownership: OWNERSHIP.MODEL_OWNED,
    lifespan: LIFESPAN.PERSISTENT,
    subscribe: false,
    delivery: EVENT_OUTCOME.INJECT,
    eventFilter: {
      rules: [{ match: "old", outcome: EVENT_OUTCOME.SURFACE }],
      ownership: OWNERSHIP.MODEL_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    }
  };
  const { supervisor, configStore } = createSupervisorHarness([previousEntry], {
    persist() {
      throw new Error("write failed");
    }
  });

  await assert.rejects(
    () => supervisor.stop("ops-watch", { scope: LIFESPAN.PERSISTENT }),
    /write failed/
  );

  const restored = configStore.findEmitter("ops-watch");
  assert.equal(restored.prompt, previousEntry.prompt);
  assert.equal(restored.subscribe, false);
  assert.equal(restored.delivery, EVENT_OUTCOME.INJECT);
  assert.deepEqual(restored.eventFilter, previousEntry.eventFilter);
});

test("running event filter update preserves user-owned persistent metadata when force is used", async () => {
  const { supervisor, configStore, persistCalls } = createSupervisorHarness();
  await supervisor.start({
    name: "Ops Watch",
    prompt: "check status",
    every: "idle",
    scope: LIFESPAN.PERSISTENT,
    managedBy: OWNERSHIP.USER_OWNED,
    subscribe: false,
    eventFilter: {
      rules: [{ match: "old", outcome: EVENT_OUTCOME.SURFACE }]
    }
  });
  const persistedAfterStart = persistCalls.length;

  const emitter = supervisor.updateEventFilter(
    "ops-watch",
    { rules: [{ match: "new", outcome: EVENT_OUTCOME.INJECT }] },
    { force: true }
  );

  assert.deepEqual(EventFilterService.serialize(emitter.eventFilter), {
    rules: [{ match: "new", outcome: EVENT_OUTCOME.INJECT }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });
  assert.equal(persistCalls.length, persistedAfterStart + 1);
  assert.deepEqual(configStore.findEmitter("ops-watch").eventFilter, {
    rules: [{ match: "new", outcome: EVENT_OUTCOME.INJECT }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });
});

test("running persistent event filter update failure restores runtime and config state", async () => {
  let failPersist = false;
  const { supervisor, configStore } = createSupervisorHarness([], {
    persist() {
      if (failPersist) {
        throw new Error("write failed");
      }
    }
  });
  await supervisor.start({
    name: "Ops Watch",
    prompt: "check status",
    every: "idle",
    scope: LIFESPAN.PERSISTENT,
    managedBy: OWNERSHIP.USER_OWNED,
    subscribe: false,
    eventFilter: {
      rules: [{ match: "old", outcome: EVENT_OUTCOME.SURFACE }]
    }
  });
  const previousRuntimeFilter = EventFilterService.serialize(supervisor.get("ops-watch").eventFilter);
  const previousConfigFilter = { ...configStore.findEmitter("ops-watch").eventFilter };

  failPersist = true;

  assert.throws(
    () => supervisor.updateEventFilter(
      "ops-watch",
      { rules: [{ match: "new", outcome: EVENT_OUTCOME.INJECT }] },
      { force: true }
    ),
    /write failed/
  );

  assert.deepEqual(EventFilterService.serialize(supervisor.get("ops-watch").eventFilter), previousRuntimeFilter);
  assert.equal(supervisor.get("ops-watch").lifespan, LIFESPAN.PERSISTENT);
  assert.deepEqual(configStore.findEmitter("ops-watch").eventFilter, previousConfigFilter);
});

test("configured event filter update preserves user-owned persistent metadata when policy options are omitted", () => {
  const { supervisor, configStore, persistCalls } = createSupervisorHarness([
    {
      name: "ops-watch",
      prompt: "check status",
      stream: "ops-watch",
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT,
      eventFilter: {
        rules: [{ match: "old", outcome: EVENT_OUTCOME.SURFACE }],
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.PERSISTENT
      }
    }
  ]);

  const result = supervisor.updateEventFilter(
    "ops-watch",
    { rules: [{ match: "new", outcome: EVENT_OUTCOME.KEEP }] },
    { force: true }
  );

  assert.equal(result.status, EMITTER_OPERATION_STATUS.CONFIGURED);
  assert.deepEqual(EventFilterService.serialize(result.eventFilter), {
    rules: [{ match: "new", outcome: EVENT_OUTCOME.KEEP }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });
  assert.equal(persistCalls.length, 1);
  assert.deepEqual(EventFilterService.serialize(configStore.findEmitter("ops-watch").eventFilter), {
    rules: [{ match: "new", outcome: EVENT_OUTCOME.KEEP }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });
});

test("configured persistent event filter update failure restores config state", () => {
  const { supervisor, configStore } = createSupervisorHarness([
    {
      name: "ops-watch",
      prompt: "check status",
      stream: "ops-watch",
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT,
      eventFilter: {
        rules: [{ match: "old", outcome: EVENT_OUTCOME.SURFACE }],
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.PERSISTENT
      }
    }
  ], {
    persist() {
      throw new Error("write failed");
    }
  });
  const previousConfigFilter = { ...configStore.findEmitter("ops-watch").eventFilter };

  assert.throws(
    () => supervisor.updateEventFilter(
      "ops-watch",
      { rules: [{ match: "new", outcome: EVENT_OUTCOME.KEEP }] },
      { force: true }
    ),
    /write failed/
  );

  assert.equal(supervisor.has("ops-watch"), false);
  assert.deepEqual(configStore.findEmitter("ops-watch").eventFilter, previousConfigFilter);
});

test("stopAllAndWait uses lifecycle wait path before resolving", async () => {
  let releaseStop;
  const waited = [];
  const { supervisor } = createSupervisorHarness([], {
    lifecycle: {
      start(emitter) {
        emitter.status = EMITTER_STATUS.RUNNING;
      },
      async stop() {
        throw new Error("ordinary stop should not be used for shutdown wait");
      },
      stopAndWait(emitter, options) {
        waited.push({ name: emitter.name, options });
        return new Promise((resolve) => {
          releaseStop = () => {
            emitter.status = EMITTER_STATUS.STOPPED;
            resolve({ name: emitter.name, timedOut: false });
          };
        });
      },
      onSessionIdle() {},
      onSessionActivity() {}
    }
  });

  await supervisor.start({
    name: "Shutdown Wait",
    prompt: "check status",
    subscribe: false
  });

  let settled = false;
  let results = null;
  const wait = supervisor.stopAllAndWait({ timeoutMs: 123 }).then((outcomes) => {
    results = outcomes;
    settled = true;
  });
  await Promise.resolve();

  assert.deepEqual(waited, [{ name: "shutdown-wait", options: { timeoutMs: 123 } }]);
  assert.equal(settled, false);

  releaseStop();
  await wait;

  assert.equal(settled, true);
  assert.deepEqual(results, [
    {
      name: "shutdown-wait",
      status: EMITTER_STATUS.STOPPED,
      timedOut: false,
      outcome: "stopped"
    }
  ]);
});

test("stopAllAndWait returns stopped timed-out and failed emitter outcomes", async () => {
  const { supervisor, logs } = createSupervisorHarness([], {
    lifecycle: {
      start(emitter) {
        emitter.status = EMITTER_STATUS.RUNNING;
      },
      async stop() {
        throw new Error("ordinary stop should not be used for shutdown wait");
      },
      async stopAndWait(emitter) {
        if (emitter.name === "boom") {
          throw new Error("stop exploded");
        }
        if (emitter.name === "slow") {
          emitter.status = EMITTER_STATUS.STOPPING;
          return { name: emitter.name, status: emitter.status, timedOut: true };
        }
        emitter.status = EMITTER_STATUS.STOPPED;
        return { name: emitter.name, status: emitter.status, timedOut: false };
      },
      onSessionIdle() {},
      onSessionActivity() {}
    }
  });

  await supervisor.start({ name: "Fast", prompt: "fast", subscribe: false });
  await supervisor.start({ name: "Slow", prompt: "slow", subscribe: false });
  await supervisor.start({ name: "Boom", prompt: "boom", subscribe: false });

  const outcomes = await supervisor.stopAllAndWait({ timeoutMs: 123 });

  assert.deepEqual(outcomes.map(({ name, outcome, timedOut, error }) => ({
    name,
    outcome,
    timedOut,
    error
  })), [
    { name: "fast", outcome: "stopped", timedOut: false, error: undefined },
    { name: "slow", outcome: "timedOut", timedOut: true, error: undefined },
    { name: "boom", outcome: "failed", timedOut: false, error: "stop exploded" }
  ]);
  assert.ok(logs.some(({ message, options }) =>
    /Failed to stop emitter 'boom' during shutdown: stop exploded/.test(message) &&
    options?.level === "warning"
  ));
});
