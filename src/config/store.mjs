import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_FILENAME, CONFIG_LOCATIONS, OWNERSHIP } from "../consts.mjs";
import { normalizeOwnership, normalizeName } from "../util/normalize.mjs";
import { assertMutable } from "../util/policy.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";
import { LATEST_CONFIG_VERSION, migrateConfig, normalizePersistedEmitter, normalizePersistedStream } from "./migrations.mjs";

function emptyConfig() {
  return { configVersion: LATEST_CONFIG_VERSION, streams: [], emitters: [] };
}

export function serializeStream(stream) {
  const { createdAt, entries, ...persisted } = stream ?? {};
  const entry = { ...persisted };

  if (stream?.name !== undefined) {
    entry.name = stream.name;
  }

  if (stream?.description !== undefined) {
    entry.description = stream.description;
  }

  if (stream?.sessionInjector !== undefined) {
    entry.sessionInjector = {
      ...stream.sessionInjector
    };
  }

  return entry;
}

export function serializeEmitter(emitter) {
  const {
    emitterType,
    runSchedule,
    requestedCwd,
    startedAt,
    stoppedAt,
    lineCount,
    droppedLineCount,
    status,
    stopRequested,
    timer,
    inFlight,
    runCount,
    lastRunAt,
    lastRunStatus,
    process,
    stdoutReader,
    stderrReader,
    exitCode,
    ...persisted
  } = emitter ?? {};
  const entry = {
    ...persisted,
    name: emitter?.name,
    stream: emitter?.stream ?? emitter?.channel,
    channel: emitter?.channel ?? emitter?.stream,
    autoStart: emitter?.autoStart,
    includeStderr: emitter?.includeStderr,
    ownership: emitter?.ownership ?? emitter?.managedBy
  };

  if (requestedCwd !== undefined) {
    entry.cwd = requestedCwd;
  }
  if (emitter?.cwd !== undefined && entry.cwd === undefined) {
    entry.cwd = emitter.cwd;
  }
  if (emitter?.command) {
    entry.command = emitter.command;
  }
  if (emitter?.prompt) {
    entry.prompt = emitter.prompt;
  }
  if (emitter?.every) {
    entry.every = emitter.every;
  }
  if (emitter?.description !== undefined) {
    entry.description = emitter.description;
  }
  if (emitter?.eventFilter) {
    entry.eventFilter = {
      ...emitter.eventFilter,
      ...EventFilterService.serialize(emitter.eventFilter)
    };
  }

  return entry;
}

function mergeStreamEntries(existing, next) {
  const merged = {
    ...existing,
    ...next
  };

  if (existing?.sessionInjector || next?.sessionInjector) {
    merged.sessionInjector = {
      ...(existing?.sessionInjector ?? {}),
      ...(next?.sessionInjector ?? {})
    };
  }

  return merged;
}

function mergeEmitterEntries(existing, next) {
  const merged = {
    ...existing,
    ...next
  };

  if (existing?.eventFilter || next?.eventFilter) {
    merged.eventFilter = {
      ...(existing?.eventFilter ?? {}),
      ...(next?.eventFilter ?? {})
    };
  }

  return merged;
}

export function createConfigStore(options = {}) {
  const fs = options.fs ?? { existsSync, readFileSync, writeFileSync };
  const state = {
    cwd: options.cwd ?? process.cwd(),
    filePath: null,
    config: emptyConfig()
  };

  const warn = typeof options.logWarning === "function"
    ? options.logWarning
    : typeof options.warn === "function"
      ? options.warn
      : (message) => {
          process.stderr.write(`[tap-config] ${message}\n`);
        };

  function defaultPath(baseCwd) {
    return path.join(baseCwd, CONFIG_FILENAME);
  }

  function load(baseCwd) {
    state.cwd = baseCwd;
    state.filePath = defaultPath(baseCwd);
    state.config = emptyConfig();

    for (const relativePath of CONFIG_LOCATIONS) {
      const filePath = path.join(baseCwd, relativePath);
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

    state.config = emptyConfig();
    return { found: false, filePath: state.filePath };
  }

  function save() {
    if (!state.filePath) {
      state.filePath = defaultPath(state.cwd);
    }

    const payload = {
      ...state.config,
      configVersion: LATEST_CONFIG_VERSION,
      streams: [...state.config.streams].sort((left, right) =>
        normalizeName(left.name).localeCompare(normalizeName(right.name))
      ).map((stream) => serializeStream(stream)),
      emitters: [...state.config.emitters].sort((left, right) =>
        normalizeName(left.name).localeCompare(normalizeName(right.name))
      ).map((emitter) => serializeEmitter(emitter))
    };

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
    assertMutable(normalizeOwnership(entry.ownership ?? entry.managedBy, OWNERSHIP.USER_OWNED), force, `Emitter '${normalized}'`);
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
