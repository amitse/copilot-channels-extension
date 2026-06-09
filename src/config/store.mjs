import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { CONFIG_LOCATIONS, OWNERSHIP } from "../consts.mjs";
import { normalizeOwnership, normalizeName } from "../util/normalize.mjs";
import { normalizeBaseCwd } from "../util/path.mjs";
import { assertMutable } from "../util/policy.mjs";
import { LATEST_CONFIG_VERSION, migrateConfig } from "./migrations.mjs";
import { normalizePersistedEmitter, normalizePersistedStream } from "./normalization.mjs";
import { createEmptyConfig, defaultConfigPath, mergeEmitterEntries, mergeStreamEntries, serializeConfig, serializeEmitter, serializeStream } from "./serialization.mjs";

export { serializeEmitter, serializeStream } from "./serialization.mjs";

const CONFIG_LOAD_ERROR_CODE = "CONFIG_LOAD";

class ConfigLoadError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ConfigLoadError";
    this.code = CONFIG_LOAD_ERROR_CODE;
    this.context = Object.freeze(createConfigLoadContext(options));
  }
}

function createConfigLoadContext({ phase, filePath }) {
  const context = {};
  if (typeof phase === "string" && phase.trim().length > 0) {
    context.phase = phase;
  }
  if (typeof filePath === "string" && filePath.trim().length > 0) {
    context.filePath = filePath;
  }
  return context;
}

function withConfigLoadPhase(phase, message, operation, context = {}) {
  try {
    return operation();
  } catch (error) {
    if (error?.code === CONFIG_LOAD_ERROR_CODE) {
      throw error;
    }

    throw new ConfigLoadError(message, {
      ...context,
      phase,
      cause: error
    });
  }
}

function toJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function serializeConfigForComparison(config) {
  return toJsonValue(serializeConfig(config, LATEST_CONFIG_VERSION));
}

function shouldPersistLoadedConfig(parsedConfig, normalizedConfig) {
  return !isDeepStrictEqual(parsedConfig, serializeConfigForComparison(normalizedConfig));
}

export function createConfigStore(options = {}) {
  const fs = options.fs ?? { existsSync, readFileSync, writeFileSync };
  const state = {
    cwd: normalizeBaseCwd(options.cwd),
    filePath: null,
    config: createEmptyConfig(LATEST_CONFIG_VERSION),
    persistenceBlocked: null
  };

  const warn = typeof options.logWarning === "function"
    ? options.logWarning
    : typeof options.warn === "function"
      ? options.warn
      : (message) => {
          process.stderr.write(`[tap-config] ${message}\n`);
        };

  function load(baseCwd) {
    try {
      const resolvedBaseCwd = normalizeBaseCwd(baseCwd, state.cwd);
      const defaultFilePath = withConfigLoadPhase(
        "resolving config path",
        "Unable to determine the default tap config path. Ensure the workspace directory is available.",
        () => defaultConfigPath(resolvedBaseCwd)
      );

      for (const relativePath of CONFIG_LOCATIONS) {
        const filePath = withConfigLoadPhase(
          "resolving config path",
          "Unable to resolve a tap config search path. Ensure configured locations are valid.",
          () => path.join(resolvedBaseCwd, relativePath)
        );
        const exists = withConfigLoadPhase(
          "checking config path",
          "Unable to check whether the tap config file exists.",
          () => fs.existsSync(filePath),
          { filePath }
        );
        if (!exists) {
          continue;
        }

        const rawConfig = withConfigLoadPhase(
          "reading config file",
          "Unable to read the tap config file.",
          () => fs.readFileSync(filePath, "utf8"),
          { filePath }
        );
        const parsedConfig = withConfigLoadPhase(
          "parsing config file",
          "The tap config file is not valid JSON.",
          () => JSON.parse(rawConfig),
          { filePath }
        );
        const loadedConfig = withConfigLoadPhase(
          "migrating config file",
          "The tap config file could not be normalized or migrated.",
          () => migrateConfig(parsedConfig, LATEST_CONFIG_VERSION, { warn }),
          { filePath }
        );

        state.cwd = resolvedBaseCwd;
        state.filePath = filePath;
        state.config = loadedConfig;
        state.persistenceBlocked = null;

        if (shouldPersistLoadedConfig(parsedConfig, loadedConfig)) {
          try {
            save();
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            try {
              warn(`Loaded config from ${filePath} but could not save migrated tap config file: ${detail}`);
            } catch {
              // Migration persistence is best-effort; warning delivery must not
              // turn a readable config into a load failure.
            }
          }
        }
        return { found: true, filePath };
      }

      state.cwd = resolvedBaseCwd;
      state.filePath = defaultFilePath;
      state.config = createEmptyConfig(LATEST_CONFIG_VERSION);
      state.persistenceBlocked = null;
      return { found: false, filePath: defaultFilePath };
    } catch (error) {
      state.persistenceBlocked = error;
      throw error;
    }
  }

  function save() {
    if (state.persistenceBlocked) {
      const context = state.persistenceBlocked.context ?? {};
      throw new ConfigLoadError(
        "Refusing to save tap config because the previous config load failed. Fix the config and reload successfully before persisting changes.",
        {
          phase: "blocked persistence",
          filePath: context.filePath,
          cause: state.persistenceBlocked
        }
      );
    }

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
