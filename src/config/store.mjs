import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_FILENAME, CONFIG_LOCATIONS, OWNERSHIP, LIFESPAN } from "../consts.mjs";
import { normalizeOwnership, normalizeName } from "../util/normalize.mjs";
import { assertMutable } from "../util/policy.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";

function emptyConfig() {
  return { streams: [], emitters: [] };
}

function ensureShape(config) {
  if (!config || typeof config !== "object") {
    return emptyConfig();
  }
  if (!Array.isArray(config.streams)) {
    config.streams = [];
  }
  if (!Array.isArray(config.emitters)) {
    config.emitters = [];
  }
  return config;
}

function normalizeEmitterEntry(entry) {
  const filterSource = entry.eventFilter ?? entry.classifier ?? entry;
  const ownership = normalizeOwnership(entry.ownership ?? entry.managedBy ?? filterSource.ownership ?? filterSource.managedBy, OWNERSHIP.MODEL_OWNED);
  return {
    ...entry,
    stream: entry.stream ?? entry.channel ?? entry.name,
    channel: entry.channel ?? entry.stream ?? entry.name,
    ownership,
    managedBy: ownership,
    eventFilter: EventFilterService.deserialize({
      ...filterSource,
      ownership: filterSource.ownership ?? filterSource.managedBy ?? ownership,
      lifespan: filterSource.lifespan ?? filterSource.scope ?? entry.lifespan ?? entry.scope
    })
  };
}

export function serializeStream(stream) {
  const entry = { name: stream.name };

  if (stream.description) {
    entry.description = stream.description;
  }

  if (stream.sessionInjector.lifespan === LIFESPAN.PERSISTENT || stream.sessionInjector.enabled) {
    entry.sessionInjector = {
      enabled: stream.sessionInjector.enabled,
      delivery: stream.sessionInjector.delivery,
      ownership: stream.sessionInjector.ownership
    };
  }

  return entry;
}

export function serializeEmitter(emitter) {
  const entry = {
    name: emitter.name,
    stream: emitter.stream ?? emitter.channel,
    channel: emitter.channel ?? emitter.stream,
    autoStart: emitter.autoStart,
    includeStderr: emitter.includeStderr,
    ownership: emitter.ownership ?? emitter.managedBy
  };

  if (emitter.command) {
    entry.command = emitter.command;
  }
  if (emitter.prompt) {
    entry.prompt = emitter.prompt;
  }
  if (emitter.every) {
    entry.every = emitter.every;
  }
  if (emitter.description) {
    entry.description = emitter.description;
  }
  if (emitter.requestedCwd) {
    entry.cwd = emitter.requestedCwd;
  }

  if (emitter.eventFilter) {
    entry.eventFilter = EventFilterService.serialize(emitter.eventFilter);
  }

  return entry;
}

export function createConfigStore(options = {}) {
  const fs = options.fs ?? { existsSync, readFileSync, writeFileSync };
  const state = {
    cwd: options.cwd ?? process.cwd(),
    filePath: null,
    config: emptyConfig()
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
      state.config = ensureShape(JSON.parse(fs.readFileSync(filePath, "utf8")));
      state.config.emitters = state.config.emitters.map((entry) => normalizeEmitterEntry(entry));
      return { found: true, filePath };
    }

    ensureShape(state.config);
    return { found: false, filePath: state.filePath };
  }

  function save() {
    ensureShape(state.config);
    if (!state.filePath) {
      state.filePath = defaultPath(state.cwd);
    }

    const payload = {
      streams: [...state.config.streams].sort((left, right) =>
        normalizeName(left.name).localeCompare(normalizeName(right.name))
      ),
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
    ensureShape(state.config);
    const entry = serializeStream(stream);
    const index = findStreamIndex(stream.name);

    if (index === -1) {
      state.config.streams.push(entry);
    } else {
      state.config.streams[index] = entry;
    }
  }

  function upsertEmitter(emitter) {
    ensureShape(state.config);
    const entry = normalizeEmitterEntry(emitter);
    const index = findEmitterIndex(emitter.name);

    if (index === -1) {
      state.config.emitters.push(entry);
    } else {
      state.config.emitters[index] = entry;
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
    ensureShape(state.config);
    return state.config.streams;
  }

  function getEmitters() {
    ensureShape(state.config);
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
