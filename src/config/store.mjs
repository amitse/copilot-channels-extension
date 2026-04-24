import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_FILENAME, CONFIG_LOCATIONS, MANAGED_BY, SCOPE } from "../consts.mjs";
import { normalizeManagedBy, normalizeName } from "../util/normalize.mjs";
import { assertMutable } from "../util/policy.mjs";

function emptyConfig() {
  return { channels: [], monitors: [] };
}

function ensureShape(config) {
  if (!config || typeof config !== "object") {
    return emptyConfig();
  }
  if (!Array.isArray(config.channels)) {
    config.channels = [];
  }
  if (!Array.isArray(config.monitors)) {
    config.monitors = [];
  }
  return config;
}

export function serializeChannel(channel) {
  const entry = { name: channel.name };

  if (channel.description) {
    entry.description = channel.description;
  }

  if (channel.subscription.scope === SCOPE.PERSISTENT || channel.subscription.enabled) {
    entry.subscription = {
      enabled: channel.subscription.enabled,
      delivery: channel.subscription.delivery,
      managedBy: channel.subscription.managedBy
    };
  }

  return entry;
}

export function serializeMonitor(monitor) {
  const entry = {
    name: monitor.name,
    channel: monitor.channel,
    autoStart: monitor.autoStart,
    includeStderr: monitor.includeStderr,
    managedBy: monitor.managedBy
  };

  if (monitor.command) {
    entry.command = monitor.command;
  }
  if (monitor.prompt) {
    entry.prompt = monitor.prompt;
  }
  if (monitor.every) {
    entry.every = monitor.every;
  }
  if (monitor.description) {
    entry.description = monitor.description;
  }
  if (monitor.requestedCwd) {
    entry.cwd = monitor.requestedCwd;
  }

  entry.classifier = {};
  if (monitor.classifier.includePattern) {
    entry.classifier.includePattern = monitor.classifier.includePattern;
  }
  if (monitor.classifier.excludePattern) {
    entry.classifier.excludePattern = monitor.classifier.excludePattern;
  }
  if (monitor.classifier.notifyPattern) {
    entry.classifier.notifyPattern = monitor.classifier.notifyPattern;
  }
  if (monitor.classifier.managedBy !== monitor.managedBy) {
    entry.classifier.managedBy = monitor.classifier.managedBy;
  }
  if (Object.keys(entry.classifier).length === 0) {
    delete entry.classifier;
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
      channels: [...state.config.channels].sort((left, right) =>
        normalizeName(left.name).localeCompare(normalizeName(right.name))
      ),
      monitors: [...state.config.monitors].sort((left, right) =>
        normalizeName(left.name).localeCompare(normalizeName(right.name))
      )
    };

    fs.writeFileSync(state.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  function findChannelIndex(name) {
    return state.config.channels.findIndex((channel) => normalizeName(channel.name) === name);
  }

  function findMonitorIndex(name) {
    return state.config.monitors.findIndex((monitor) => normalizeName(monitor.name) === name);
  }

  function upsertChannel(channel) {
    ensureShape(state.config);
    const entry = serializeChannel(channel);
    const index = findChannelIndex(channel.name);

    if (index === -1) {
      state.config.channels.push(entry);
    } else {
      state.config.channels[index] = entry;
    }
  }

  function upsertMonitor(monitor) {
    ensureShape(state.config);
    const entry = serializeMonitor(monitor);
    const index = findMonitorIndex(monitor.name);

    if (index === -1) {
      state.config.monitors.push(entry);
    } else {
      state.config.monitors[index] = entry;
    }
  }

  function removeMonitor(name, force = false) {
    const normalized = normalizeName(name);
    const index = findMonitorIndex(normalized);
    if (index === -1) {
      return false;
    }

    const entry = state.config.monitors[index];
    assertMutable(normalizeManagedBy(entry.managedBy, MANAGED_BY.USER), force, `Monitor '${normalized}'`);
    state.config.monitors.splice(index, 1);
    return true;
  }

  function getChannels() {
    ensureShape(state.config);
    return state.config.channels;
  }

  function getMonitors() {
    ensureShape(state.config);
    return state.config.monitors;
  }

  function findMonitor(name) {
    const index = findMonitorIndex(normalizeName(name));
    return index === -1 ? null : state.config.monitors[index];
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
    upsertChannel,
    upsertMonitor,
    removeMonitor,
    getChannels,
    getMonitors,
    findMonitor,
    getPath,
    getCwd
  };
}
