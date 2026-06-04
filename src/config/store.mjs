import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_LOCATIONS, OWNERSHIP } from "../consts.mjs";
import { normalizeOwnership, normalizeName } from "../util/normalize.mjs";
import { normalizeBaseCwd } from "../util/path.mjs";
import { assertMutable } from "../util/policy.mjs";
import { LATEST_CONFIG_VERSION, migrateConfig } from "./migrations.mjs";
import { normalizePersistedEmitter, normalizePersistedStream } from "./normalization.mjs";
import { createEmptyConfig, defaultConfigPath, mergeEmitterEntries, mergeStreamEntries, serializeConfig, serializeEmitter, serializeStream } from "./serialization.mjs";

export { serializeEmitter, serializeStream } from "./serialization.mjs";

export function createConfigStore(options = {}) {
  const fs = options.fs ?? { existsSync, readFileSync, writeFileSync };
  const state = {
    cwd: normalizeBaseCwd(options.cwd),
    filePath: null,
    config: createEmptyConfig(LATEST_CONFIG_VERSION)
  };

  const warn = typeof options.logWarning === "function"
    ? options.logWarning
    : typeof options.warn === "function"
      ? options.warn
      : (message) => {
          process.stderr.write(`[tap-config] ${message}\n`);
        };

  function load(baseCwd) {
    const resolvedBaseCwd = normalizeBaseCwd(baseCwd, state.cwd);
    state.cwd = resolvedBaseCwd;
    state.filePath = defaultConfigPath(resolvedBaseCwd);
    state.config = createEmptyConfig(LATEST_CONFIG_VERSION);

    for (const relativePath of CONFIG_LOCATIONS) {
      const filePath = path.join(resolvedBaseCwd, relativePath);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      state.filePath = filePath;
      state.config = migrateConfig(JSON.parse(fs.readFileSync(filePath, "utf8")), LATEST_CONFIG_VERSION, {
        warn
      });
      save();
      return { found: true, filePath };
    }

    state.config = createEmptyConfig(LATEST_CONFIG_VERSION);
    return { found: false, filePath: state.filePath };
  }

  function save() {
    if (!state.filePath) {
      state.filePath = defaultConfigPath(state.cwd);
    }

    const payload = serializeConfig(state.config, LATEST_CONFIG_VERSION);

    fs.writeFileSync(state.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  function findStreamIndex(name) {
    return state.config.streams.findIndex((stream) => normalizeName(stream.name) === name);
  }

  function findEmitterIndex(name) {
    return state.config.emitters.findIndex((emitter) => normalizeName(emitter.name) === name);
  }

  function upsertStream(stream) {
    const entry = normalizePersistedStream(serializeStream(stream));
    const index = findStreamIndex(stream.name);

    if (index === -1) {
      state.config.streams.push(entry);
    } else {
      state.config.streams[index] = mergeStreamEntries(state.config.streams[index], entry);
    }
  }

  function upsertEmitter(emitter) {
    const entry = normalizePersistedEmitter(serializeEmitter(emitter), { warn });
    const index = findEmitterIndex(emitter.name);

    if (index === -1) {
      state.config.emitters.push(entry);
    } else {
      state.config.emitters[index] = mergeEmitterEntries(state.config.emitters[index], entry);
    }
  }

  function removeEmitter(name, force = false) {
    const normalized = normalizeName(name);
    const index = findEmitterIndex(normalized);
    if (index === -1) {
      return false;
    }

    const entry = state.config.emitters[index];
    assertMutable(normalizeOwnership(entry.ownership, OWNERSHIP.USER_OWNED), force, `Emitter '${normalized}'`);
    state.config.emitters.splice(index, 1);
    return true;
  }

  function getStreams() {
    return state.config.streams;
  }

  function getEmitters() {
    return state.config.emitters;
  }

  function findEmitter(name) {
    const index = findEmitterIndex(normalizeName(name));
    return index === -1 ? null : state.config.emitters[index];
  }

  function getPath() {
    return state.filePath;
  }

  function getCwd() {
    return state.cwd;
  }

  return {
    load,
    save,
    upsertStream,
    upsertEmitter,
    removeEmitter,
    getStreams,
    getEmitters,
    findEmitter,
    getPath,
    getCwd
  };
}
