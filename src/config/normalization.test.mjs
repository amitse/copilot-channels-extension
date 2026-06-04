import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { CONFIG_LOCATIONS, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { ValidationError } from "../errors/index.mjs";
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
