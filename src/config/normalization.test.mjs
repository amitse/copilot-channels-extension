import test from "node:test";
import assert from "node:assert/strict";

import { LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { CONFIG_VERSION as MIGRATION_CONFIG_VERSION } from "./migrations.mjs";
import { normalizePersistedConfig } from "./normalization.mjs";
import { serializeConfig, serializeEmitter, serializeStream } from "./serialization.mjs";
import { serializeEmitter as storeSerializeEmitter, serializeStream as storeSerializeStream } from "./store.mjs";

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
