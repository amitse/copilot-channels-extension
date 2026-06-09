import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { CONFIG_LOCATIONS, EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { ConflictError, ValidationError } from "../errors/index.mjs";
import { normalizeLifespan, normalizeOwnership } from "../util/normalize.mjs";
import { CONFIG_VERSION as MIGRATION_CONFIG_VERSION } from "./migrations.mjs";
import { normalizePersistedConfig } from "./normalization.mjs";
import { defaultConfigPath, serializeConfig, serializeEmitter, serializeStream } from "./serialization.mjs";
import { createConfigStore, serializeEmitter as storeSerializeEmitter, serializeStream as storeSerializeStream } from "./store.mjs";

test("config helpers preserve raw fields and canonicalize nested filters", () => {
  const raw = {
    configVersion: "1",
    rootField: "keep",
    streams: [
      {
        name: "Stream One",
        description: "primary",
        subscription: {
          enabled: true,
          delivery: "all",
          managedBy: "userOwned",
          scope: "persistent",
          custom: "nested"
        }
      }
    ],
    emitters: [
      {
        name: "beta",
        stream: "beta",
        channel: "beta",
        command: "echo hi",
        managedBy: "userOwned",
        scope: "persistent",
        classifier: {
          rules: [{ match: "sync", outcome: "inject" }],
          managedBy: "userOwned",
          scope: "persistent"
        },
        extra: "value",
        startedAt: "runtime-only"
      },
      {
        name: "alpha",
        stream: "alpha",
        channel: "alpha",
        command: "echo bye",
        managedBy: "modelOwned",
        scope: "temporary",
        eventFilter: {
          rules: [{ match: "warn", outcome: "drop" }],
          managedBy: "userOwned",
          scope: "persistent"
        }
      }
    ]
  };

  const normalized = normalizePersistedConfig(raw, { warn: () => {} });

  assert.equal(normalized.configVersion, 1);
  assert.equal(normalized.rootField, "keep");
  assert.equal(normalized.streams[0].sessionInjector.enabled, true);
  assert.equal(normalized.streams[0].sessionInjector.delivery, "all");
  assert.equal(normalized.streams[0].sessionInjector.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(normalized.streams[0].sessionInjector.lifespan, LIFESPAN.PERSISTENT);
  assert.equal(normalized.streams[0].sessionInjector.custom, "nested");
  assert.equal(normalized.emitters[0].ownership, OWNERSHIP.USER_OWNED);
  assert.equal(normalized.emitters[0].eventFilter.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(normalized.emitters[0].eventFilter.lifespan, LIFESPAN.PERSISTENT);
  assert.equal(normalized.emitters[0].extra, "value");
  assert.equal(normalized.emitters[1].eventFilter.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(normalized.emitters[1].eventFilter.lifespan, LIFESPAN.PERSISTENT);

  const persisted = serializeConfig(normalized, 2);

  assert.equal(persisted.configVersion, 2);
  assert.equal(persisted.emitters[0].name, "alpha");
  assert.equal(persisted.emitters[1].name, "beta");
  assert.equal(persisted.emitters[1].extra, "value");
  assert.equal(persisted.emitters[1].startedAt, undefined);
  assert.deepEqual(persisted.streams[0].sessionInjector.custom, "nested");
});

test("config modules preserve legacy public exports", () => {
  assert.strictEqual(MIGRATION_CONFIG_VERSION.V2, 2);
  assert.strictEqual(storeSerializeEmitter, serializeEmitter);
  assert.strictEqual(storeSerializeStream, serializeStream);
});

test("persisted config preserves documented array-form event filters", () => {
  const normalized = normalizePersistedConfig({
    configVersion: 2,
    emitters: [
      {
        name: "heartbeat",
        command: "node ./examples/heartbeat.mjs",
        eventFilter: [
          { match: "booting", outcome: "drop" },
          { match: "ready|healthy", outcome: "surface" },
          { match: "warning|error", outcome: "inject" }
        ]
      }
    ]
  });

  assert.deepEqual(normalized.emitters[0].eventFilter.rules, [
    { match: "booting", outcome: "drop" },
    { match: "ready|healthy", outcome: "surface" },
    { match: "warning|error", outcome: "inject" }
  ]);
  assert.equal(normalized.emitters[0].eventFilter.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(normalized.emitters[0].eventFilter.lifespan, LIFESPAN.PERSISTENT);
});

test("persisted config maps legacy runInterval to canonical every", () => {
  const normalized = normalizePersistedConfig({
    emitters: [
      {
        name: "repo-maintenance",
        prompt: "check repo health",
        runInterval: "15m"
      }
    ]
  });

  assert.equal(normalized.emitters[0].every, "15m");
  assert.equal(normalized.emitters[0].runInterval, undefined);
});

test("persisted stream session injectors default to user-owned persistent policy", () => {
  const normalized = normalizePersistedConfig({
    streams: [
      {
        name: "ops",
        sessionInjector: {
          enabled: true,
          delivery: "surface"
        }
      },
      {
        name: "legacy-temporary",
        subscription: {
          enabled: true,
          managedBy: "modelOwned",
          scope: "temporary"
        }
      }
    ]
  });

  const ops = normalized.streams.find((stream) => stream.name === "ops");
  const legacyTemporary = normalized.streams.find((stream) => stream.name === "legacy-temporary");

  assert.equal(ops.sessionInjector.enabled, true);
  assert.equal(ops.sessionInjector.delivery, "surface");
  assert.equal(ops.sessionInjector.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(ops.sessionInjector.lifespan, LIFESPAN.PERSISTENT);

  assert.equal(legacyTemporary.sessionInjector.ownership, OWNERSHIP.MODEL_OWNED);
  assert.equal(legacyTemporary.sessionInjector.lifespan, LIFESPAN.TEMPORARY);

  const persistedOps = serializeConfig(normalized, 2).streams.find((stream) => stream.name === "ops");
  assert.equal(persistedOps.sessionInjector.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(persistedOps.sessionInjector.lifespan, LIFESPAN.PERSISTENT);
});

test("persisted stream entries require explicit non-blank names", () => {
  const invalidNames = [
    undefined,
    null,
    "",
    " \n\t ",
    123,
    { name: "ops" },
    "!!!"
  ];

  for (const name of invalidNames) {
    const entry = name === undefined
      ? { sessionInjector: { enabled: true } }
      : { name, sessionInjector: { enabled: true } };

    assert.throws(
      () => normalizePersistedConfig({ streams: [entry] }),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /Invalid persisted stream: name/);
        return true;
      }
    );
  }
});

test("persisted stream entries can explicitly configure main", () => {
  const normalized = normalizePersistedConfig({
    streams: [
      {
        name: "main",
        sessionInjector: {
          enabled: true
        }
      }
    ]
  });

  assert.equal(normalized.streams[0].name, "main");
  assert.equal(normalized.streams[0].sessionInjector.enabled, true);
  assert.equal(normalized.streams[0].sessionInjector.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(normalized.streams[0].sessionInjector.lifespan, LIFESPAN.PERSISTENT);
});

test("persisted emitter entries require explicit non-blank names", () => {
  const invalidNames = [
    undefined,
    null,
    "",
    " \n\t ",
    123,
    { name: "ops" },
    "!!!"
  ];

  for (const name of invalidNames) {
    const entry = name === undefined
      ? { command: "echo ok" }
      : { name, command: "echo ok" };

    assert.throws(
      () => normalizePersistedConfig({ emitters: [entry] }),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /Invalid persisted emitter: name/);
        return true;
      }
    );
  }
});

test("persisted emitter stream alias wins over stale legacy channel", () => {
  const normalized = normalizePersistedConfig({
    emitters: [
      {
        name: "conflict-watch",
        command: "echo ok",
        stream: "edited-stream",
        channel: "stale-channel"
      },
      {
        name: "legacy-channel-watch",
        command: "echo ok",
        channel: "legacy-channel"
      }
    ]
  });

  const conflict = normalized.emitters.find((emitter) => emitter.name === "conflict-watch");
  const legacyChannel = normalized.emitters.find((emitter) => emitter.name === "legacy-channel-watch");

  assert.equal(conflict.stream, "edited-stream");
  assert.equal("channel" in conflict, false);
  assert.equal(legacyChannel.stream, "legacy-channel");
  assert.equal("channel" in legacyChannel, false);

  const persisted = serializeConfig(normalized, 2);
  const persistedConflict = persisted.emitters.find((emitter) => emitter.name === "conflict-watch");
  const persistedLegacy = persisted.emitters.find((emitter) => emitter.name === "legacy-channel-watch");

  assert.equal(persistedConflict.stream, "edited-stream");
  assert.equal("channel" in persistedConflict, false);
  assert.equal(persistedLegacy.stream, "legacy-channel");
  assert.equal("channel" in persistedLegacy, false);
});

test("invalid ownership and lifespan values use caller fallbacks", () => {
  assert.equal(normalizeOwnership("invalid-owner", OWNERSHIP.USER_OWNED), OWNERSHIP.USER_OWNED);
  assert.equal(normalizeLifespan("forever", LIFESPAN.PERSISTENT), LIFESPAN.PERSISTENT);
  assert.equal(normalizeOwnership("invalid-owner"), OWNERSHIP.MODEL_OWNED);
  assert.equal(normalizeLifespan("forever"), LIFESPAN.TEMPORARY);
  assert.equal(normalizeOwnership("modelOwned", OWNERSHIP.USER_OWNED), OWNERSHIP.MODEL_OWNED);
  assert.equal(normalizeLifespan("temporary", LIFESPAN.PERSISTENT), LIFESPAN.TEMPORARY);
});

test("invalid persisted ownership and lifespan keep persistent user-owned defaults", () => {
  const normalized = normalizePersistedConfig({
    streams: [
      {
        name: "ops",
        sessionInjector: {
          enabled: true,
          ownership: "somebody",
          lifespan: "forever"
        }
      }
    ],
    emitters: [
      {
        name: "policy-watch",
        command: "echo ok",
        ownership: "somebody",
        lifespan: "forever",
        eventFilter: {
          ownership: "somebody",
          lifespan: "forever",
          rules: [{ match: "ok", outcome: "surface" }]
        }
      }
    ]
  });

  assert.equal(normalized.streams[0].sessionInjector.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(normalized.streams[0].sessionInjector.lifespan, LIFESPAN.PERSISTENT);
  assert.equal(normalized.emitters[0].ownership, OWNERSHIP.USER_OWNED);
  assert.equal(normalized.emitters[0].lifespan, LIFESPAN.PERSISTENT);
  assert.equal(normalized.emitters[0].eventFilter.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(normalized.emitters[0].eventFilter.lifespan, LIFESPAN.PERSISTENT);
});

test("invalid persisted emitter ownership remains protected from unforced removal", () => {
  const cwd = path.join("workspace", "repo");
  const configPath = defaultConfigPath(cwd);
  const fs = {
    existsSync(filePath) {
      return filePath === configPath;
    },
    readFileSync() {
      return JSON.stringify({
        emitters: [
          {
            name: "guarded-watch",
            command: "echo ok",
            ownership: "somebody"
          }
        ]
      });
    },
    writeFileSync() {}
  };
  const store = createConfigStore({ cwd, fs, warn: () => {} });

  store.load(cwd);

  assert.equal(store.findEmitter("guarded-watch").ownership, OWNERSHIP.USER_OWNED);
  assert.throws(
    () => store.removeEmitter("guarded-watch"),
    (error) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /user-controlled/);
      return true;
    }
  );
  assert.equal(store.removeEmitter("guarded-watch", true), true);
});

test("serialized timed runtime emitters omit derived everyMs", () => {
  const serialized = serializeEmitter({
    name: "timed-watch",
    command: "echo ok",
    stream: "timed-watch",
    every: "5m",
    everyMs: 300_000,
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT,
    runSchedule: "timed",
    status: "running",
    eventFilter: {
      rules: [],
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    }
  });
  const warnings = [];

  assert.equal("everyMs" in serialized, false);
  normalizePersistedConfig({ emitters: [serialized] }, { warn: (message) => warnings.push(message) });

  assert.deepEqual(warnings, []);
});

test("serialized runtime emitters preserve explicit subscribe false and non-default delivery", () => {
  const quiet = serializeEmitter({
    name: "quiet-watch",
    command: "echo ok",
    stream: "quiet-watch",
    subscribe: false,
    delivery: EVENT_OUTCOME.INJECT,
    ownership: OWNERSHIP.MODEL_OWNED,
    lifespan: LIFESPAN.PERSISTENT,
    eventFilter: {
      rules: [],
      ownership: OWNERSHIP.MODEL_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    }
  });
  const defaultPolicy = serializeEmitter({
    name: "default-watch",
    command: "echo ok",
    stream: "default-watch",
    subscribe: true,
    delivery: EVENT_OUTCOME.SURFACE,
    ownership: OWNERSHIP.MODEL_OWNED,
    lifespan: LIFESPAN.PERSISTENT,
    eventFilter: {
      rules: [],
      ownership: OWNERSHIP.MODEL_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    }
  });

  assert.equal(quiet.subscribe, false);
  assert.equal(quiet.delivery, EVENT_OUTCOME.INJECT);
  assert.equal("subscribe" in defaultPolicy, false);
  assert.equal("delivery" in defaultPolicy, false);
});

test("persisted config normalizes maxRuns and rejects fractional budgets", () => {
  const normalized = normalizePersistedConfig({
    emitters: [
      {
        name: "budgeted-loop",
        prompt: "check repo health",
        maxRuns: "2"
      }
    ]
  });

  assert.equal(normalized.emitters[0].maxRuns, 2);

  for (const invalid of [1.9, "1.9"]) {
    assert.throws(
      () => normalizePersistedConfig({
        emitters: [
          {
            name: "bad-budget",
            prompt: "check repo health",
            maxRuns: invalid
          }
        ]
      }),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /maxRuns/);
        return true;
      }
    );

    const cwd = path.join("workspace", "repo");
    const configPath = defaultConfigPath(cwd);
    const fs = {
      existsSync(filePath) {
        return filePath === configPath;
      },
      readFileSync() {
        return JSON.stringify({
          emitters: [
            {
              name: "bad-budget",
              prompt: "check repo health",
              maxRuns: invalid
            }
          ]
        });
      },
      writeFileSync() {
        throw new Error("writeFileSync should not be called for invalid config");
      }
    };
    const store = createConfigStore({ cwd, fs, warn: () => {} });

    assert.throws(
      () => store.load(cwd),
      (error) => {
        assert.equal(error.code, "CONFIG_LOAD");
        assert.equal(error.context.phase, "migrating config file");
        assert.ok(error.cause instanceof ValidationError);
        assert.match(error.cause.message, /maxRuns/);
        return true;
      }
    );
  }
});

test("persisted config rejects malformed configVersion values", () => {
  assert.throws(
    () => normalizePersistedConfig({ configVersion: "2abc" }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /configVersion/);
      return true;
    }
  );
});

test("persisted config rejects malformed roots and collection fields", () => {
  const malformedCases = [
    {
      label: "null root",
      input: null,
      message: /root must be a JSON object/
    },
    {
      label: "array root",
      input: [],
      message: /root must be a JSON object/
    },
    {
      label: "object streams",
      input: { streams: { name: "ops" } },
      message: /streams must be an array/
    },
    {
      label: "null streams",
      input: { streams: null },
      message: /streams must be an array/
    },
    {
      label: "string emitters",
      input: { emitters: "ops" },
      message: /emitters must be an array/
    },
    {
      label: "null emitters",
      input: { emitters: null },
      message: /emitters must be an array/
    }
  ];

  for (const { label, input, message } of malformedCases) {
    assert.throws(
      () => normalizePersistedConfig(input),
      (error) => {
        assert.ok(error instanceof ValidationError, label);
        assert.match(error.message, message, label);
        return true;
      }
    );
  }
});

test("config store load does not rewrite malformed persisted config", () => {
  const cwd = path.join("workspace", "repo");
  const configPath = defaultConfigPath(cwd);
  const malformedCases = [
    {
      label: "array root",
      payload: []
    },
    {
      label: "object streams",
      payload: { streams: { name: "ops" } }
    },
    {
      label: "string emitters",
      payload: { emitters: "ops" }
    }
  ];

  for (const { label, payload } of malformedCases) {
    let writeCalls = 0;
    const fs = {
      existsSync(filePath) {
        return filePath === configPath;
      },
      readFileSync() {
        return JSON.stringify(payload);
      },
      writeFileSync() {
        writeCalls += 1;
        throw new Error("writeFileSync should not be called for malformed config");
      }
    };
    const store = createConfigStore({ cwd, fs, warn: () => {} });

    assert.throws(
      () => store.load(cwd),
      (error) => {
        assert.equal(error.code, "CONFIG_LOAD", label);
        assert.equal(error.context.phase, "migrating config file", label);
        assert.ok(error.cause instanceof ValidationError, label);
        return true;
      }
    );
    assert.throws(
      () => store.save(),
      (error) => {
        assert.equal(error.code, "CONFIG_LOAD", label);
        assert.equal(error.context.phase, "blocked persistence", label);
        return true;
      }
    );
    assert.equal(writeCalls, 0, label);
  }
});

test("config store failed reload preserves last known-good state and blocks save", () => {
  const cwd = path.join("workspace", "repo");
  const nextCwd = path.join("workspace", "other-repo");
  const configPath = defaultConfigPath(cwd);
  const nextConfigPath = defaultConfigPath(nextCwd);
  const canonicalConfig = {
    configVersion: 2,
    streams: [],
    emitters: [
      {
        name: "stable-watch",
        stream: "stable-watch",
        command: "echo ok",
        autoStart: true,
        includeStderr: true,
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.PERSISTENT,
        eventFilter: {
          rules: [],
          ownership: OWNERSHIP.USER_OWNED,
          lifespan: LIFESPAN.PERSISTENT
        }
      }
    ]
  };
  let invalidReload = false;
  const writes = [];
  const fs = {
    existsSync(filePath) {
      return filePath === (invalidReload ? nextConfigPath : configPath);
    },
    readFileSync() {
      return invalidReload
        ? "{ malformed json"
        : JSON.stringify(canonicalConfig, null, 2);
    },
    writeFileSync(filePath, payload) {
      writes.push({ filePath, payload });
    }
  };
  const store = createConfigStore({ cwd, fs, warn: () => {} });

  assert.deepEqual(store.load(cwd), { found: true, filePath: configPath });
  invalidReload = true;

  assert.throws(
    () => store.load(nextCwd),
    (error) => {
      assert.equal(error.code, "CONFIG_LOAD");
      assert.equal(error.context.phase, "parsing config file");
      assert.equal(error.context.filePath, nextConfigPath);
      return true;
    }
  );

  assert.equal(store.getCwd(), cwd);
  assert.equal(store.getPath(), configPath);
  assert.deepEqual(store.getEmitters(), canonicalConfig.emitters);
  assert.throws(
    () => store.save(),
    (error) => {
      assert.equal(error.code, "CONFIG_LOAD");
      assert.equal(error.context.phase, "blocked persistence");
      assert.equal(error.context.filePath, nextConfigPath);
      return true;
    }
  );
  assert.deepEqual(writes, []);
});

test("persisted config rejects duplicate normalized stream and emitter names", () => {
  const duplicateCases = [
    {
      label: "stream names",
      input: {
        streams: [
          { name: "Ops Stream" },
          { name: "ops-stream" }
        ]
      },
      message: /Duplicate persisted stream name 'ops-stream'/
    },
    {
      label: "emitter names",
      input: {
        emitters: [
          { name: "Deploy Watch", command: "echo one" },
          { name: "deploy-watch", command: "echo two" }
        ]
      },
      message: /Duplicate persisted emitter name 'deploy-watch'/
    }
  ];

  for (const { label, input, message } of duplicateCases) {
    assert.throws(
      () => normalizePersistedConfig(input),
      (error) => {
        assert.ok(error instanceof ValidationError, label);
        assert.match(error.message, message, label);
        return true;
      }
    );
  }
});

test("persisted emitters accept legacy top-level scope but serialize only lifespan", () => {
  const normalized = normalizePersistedConfig({
    configVersion: 1,
    emitters: [
      {
        name: "legacy-scope",
        command: "echo ok",
        scope: "temporary",
        eventFilter: {
          rules: [{ match: "ok", outcome: "surface" }],
          scope: "persistent"
        }
      }
    ]
  });

  const emitter = normalized.emitters[0];

  assert.equal(emitter.lifespan, LIFESPAN.TEMPORARY);
  assert.equal("scope" in emitter, false);
  assert.equal(emitter.eventFilter.lifespan, LIFESPAN.PERSISTENT);
  assert.equal("scope" in emitter.eventFilter, false);

  const persisted = serializeConfig(normalized, 2).emitters[0];

  assert.equal(persisted.lifespan, LIFESPAN.TEMPORARY);
  assert.equal("scope" in persisted, false);

  const serializedRuntimeEmitter = serializeEmitter({
    name: "runtime-legacy-scope",
    stream: "runtime-legacy-scope",
    command: "echo ok",
    scope: "temporary",
    lifespan: LIFESPAN.TEMPORARY,
    ownership: OWNERSHIP.USER_OWNED,
    eventFilter: {
      rules: [],
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.TEMPORARY
    }
  });

  assert.equal(serializedRuntimeEmitter.lifespan, LIFESPAN.TEMPORARY);
  assert.equal("scope" in serializedRuntimeEmitter, false);
});

test("persisted emitters default to user-owned persistent definitions", () => {
  const normalized = normalizePersistedConfig({
    emitters: [
      {
        name: "default-policy",
        command: "echo ok"
      },
      {
        name: "explicit-temporary",
        command: "echo ok",
        ownership: "modelOwned",
        lifespan: "temporary",
        eventFilter: [{ match: "warn", outcome: "surface" }]
      }
    ]
  });

  const [defaultPolicy, explicitTemporary] = normalized.emitters;
  assert.equal(defaultPolicy.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(defaultPolicy.lifespan, LIFESPAN.PERSISTENT);
  assert.equal(defaultPolicy.eventFilter.ownership, OWNERSHIP.USER_OWNED);
  assert.equal(defaultPolicy.eventFilter.lifespan, LIFESPAN.PERSISTENT);

  assert.equal(explicitTemporary.ownership, OWNERSHIP.MODEL_OWNED);
  assert.equal(explicitTemporary.lifespan, LIFESPAN.TEMPORARY);
  assert.equal(explicitTemporary.eventFilter.ownership, OWNERSHIP.MODEL_OWNED);
  assert.equal(explicitTemporary.eventFilter.lifespan, LIFESPAN.TEMPORARY);
});

test("config store load falls back to the stored cwd for invalid input", () => {
  const cwd = path.join("workspace", "repo");
  const checkedPaths = [];
  const fs = {
    existsSync(filePath) {
      checkedPaths.push(filePath);
      return false;
    },
    readFileSync() {
      throw new Error("readFileSync should not be called when no config exists");
    },
    writeFileSync() {
      throw new Error("writeFileSync should not be called when no config exists");
    }
  };
  const store = createConfigStore({ cwd, fs });

  const undefinedResult = store.load(undefined);
  const whitespaceResult = store.load("   ");

  assert.equal(store.getCwd(), cwd);
  assert.deepEqual(undefinedResult, { found: false, filePath: defaultConfigPath(cwd) });
  assert.deepEqual(whitespaceResult, { found: false, filePath: defaultConfigPath(cwd) });
  assert.deepEqual(checkedPaths, [
    ...CONFIG_LOCATIONS.map((relativePath) => path.join(cwd, relativePath)),
    ...CONFIG_LOCATIONS.map((relativePath) => path.join(cwd, relativePath))
  ]);
});

test("config store load keeps normalized state when best-effort migration save fails", () => {
  const cwd = path.join("workspace", "repo");
  const configPath = defaultConfigPath(cwd);
  const warnings = [];
  let writeCalls = 0;
  const fs = {
    existsSync(filePath) {
      return filePath === configPath;
    },
    readFileSync() {
      return JSON.stringify({
        emitters: [
          {
            name: "repo-maintenance",
            prompt: "check repo health",
            runInterval: "15m"
          }
        ]
      });
    },
    writeFileSync() {
      writeCalls += 1;
      throw new Error("read-only config file");
    }
  };
  const store = createConfigStore({ cwd, fs, warn: (message) => warnings.push(message) });

  const result = store.load(cwd);

  assert.deepEqual(result, { found: true, filePath: configPath });
  assert.equal(writeCalls, 1);
  assert.equal(store.getEmitters()[0].name, "repo-maintenance");
  assert.equal(store.getEmitters()[0].every, "15m");
  assert.equal(store.getEmitters()[0].ownership, OWNERSHIP.USER_OWNED);
  assert.equal(store.getEmitters()[0].lifespan, LIFESPAN.PERSISTENT);
  assert.ok(warnings.some((message) => /could not save/i.test(message)));
});

test("config store load skips rewriting an unchanged canonical config", () => {
  const cwd = path.join("workspace", "repo");
  const configPath = defaultConfigPath(cwd);
  const canonicalConfig = {
    configVersion: 2,
    streams: [],
    emitters: [
      {
        name: "stable-watch",
        stream: "stable-stream",
        command: "echo ok",
        autoStart: true,
        includeStderr: true,
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.PERSISTENT,
        eventFilter: {
          rules: [],
          ownership: OWNERSHIP.USER_OWNED,
          lifespan: LIFESPAN.PERSISTENT
        }
      }
    ]
  };
  const fs = {
    existsSync(filePath) {
      return filePath === configPath;
    },
    readFileSync() {
      return JSON.stringify(canonicalConfig, null, 2);
    },
    writeFileSync() {
      throw new Error("canonical config should not be rewritten");
    }
  };
  const store = createConfigStore({ cwd, fs, warn: () => {} });

  const result = store.load(cwd);

  assert.deepEqual(result, { found: true, filePath: configPath });
  assert.deepEqual(store.getEmitters(), canonicalConfig.emitters);
});

test("default config path rejects invalid cwd with a validation error", () => {
  assert.throws(
    () => defaultConfigPath(undefined),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, "VALIDATION");
      assert.match(error.message, /non-empty string/);
      assert.deepEqual(error.context, { baseCwd: undefined, type: "undefined" });
      return true;
    }
  );
});
