import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { ValidationError } from "../errors/index.mjs";
import { normalizeLifespan, normalizeName, normalizeOutcome, normalizeOwnership } from "../util/normalize.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";

export const CONFIG_VERSION = Object.freeze({
  V1: 1,
  V2: 2,
  V3: 3
});

/**
 * Current on-disk schema version.
 *
 * v1: current shape used by the extension today.
 * v2: reserved for the first breaking config change.
 * v3: reserved for the next major schema change.
 */
export const LATEST_CONFIG_VERSION = CONFIG_VERSION.V1;

const KNOWN_ROOT_KEYS = new Set(["configVersion", "streams", "emitters"]);
const KNOWN_STREAM_KEYS = new Set(["name", "description", "sessionInjector"]);
const KNOWN_EMITTER_KEYS = new Set([
  "name",
  "stream",
  "channel",
  "command",
  "prompt",
  "every",
  "description",
  "cwd",
  "autoStart",
  "includeStderr",
  "ownership",
  "managedBy",
  "eventFilter",
  "classifier",
  "scope",
  "lifespan",
  "includePattern",
  "excludePattern",
  "notifyPattern",
  "delivery",
  "subscribe"
]);
const KNOWN_FILTER_KEYS = new Set([
  "rules",
  "ownership",
  "managedBy",
  "lifespan",
  "scope",
  "includePattern",
  "excludePattern",
  "notifyPattern"
]);
const KNOWN_SESSION_INJECTOR_KEYS = new Set([
  "enabled",
  "delivery",
  "ownership",
  "managedBy",
  "lifespan",
  "scope"
]);

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function cloneObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function resolveWarn(options = {}) {
  if (typeof options.warn === "function") {
    return options.warn;
  }

  if (typeof options.logWarning === "function") {
    return options.logWarning;
  }

  return null;
}

function warnUnknownFields(warn, scope, keys) {
  if (!warn || keys.length === 0) {
    return;
  }

  warn(`${scope} contains unrecognized field${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}. The fields will be preserved, but the extension does not interpret them.`);
}

function getUnknownKeys(source, knownKeys) {
  return Object.keys(source).filter((key) => !knownKeys.has(key));
}

function normalizeVersion(value, fallback = CONFIG_VERSION.V1) {
  const candidate = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new ValidationError(`Invalid configVersion '${value}'. Expected a positive integer.`);
  }

  return candidate;
}

function normalizeSessionInjector(source) {
  const injector = cloneObject(source);

  if (injector.enabled !== undefined) {
    injector.enabled = injector.enabled === true;
  }
  injector.delivery = normalizeOutcome(injector.delivery, EVENT_OUTCOME.SURFACE);
  injector.ownership = normalizeOwnership(injector.ownership ?? injector.managedBy, OWNERSHIP.MODEL_OWNED);
  injector.lifespan = normalizeLifespan(injector.lifespan ?? injector.scope, LIFESPAN.TEMPORARY);

  return injector;
}

export function normalizePersistedStream(entry = {}, options = {}) {
  const warn = resolveWarn(options);
  const source = isPlainObject(entry) ? entry : {};
  const stream = cloneObject(source);

  if (warn) {
    warnUnknownFields(warn, `Stream '${normalizeName(source.name, "(unnamed)")}'`, getUnknownKeys(source, KNOWN_STREAM_KEYS));
  }

  stream.name = source.name;
  if (source.description !== undefined) {
    stream.description = source.description;
  }
  if (source.sessionInjector !== undefined) {
    const sessionInjectorSource = isPlainObject(source.sessionInjector) ? source.sessionInjector : {};
    if (warn) {
      warnUnknownFields(
        warn,
        `Session injector for stream '${normalizeName(source.name, "(unnamed)")}'`,
        getUnknownKeys(sessionInjectorSource, KNOWN_SESSION_INJECTOR_KEYS)
      );
    }
    stream.sessionInjector = normalizeSessionInjector(sessionInjectorSource);
  }

  return stream;
}

export function normalizePersistedEmitter(entry = {}, options = {}) {
  const warn = resolveWarn(options);
  const source = isPlainObject(entry) ? entry : {};
  const filterSource = isPlainObject(source.eventFilter)
    ? source.eventFilter
    : isPlainObject(source.classifier)
      ? source.classifier
      : source;
  const ownership = normalizeOwnership(
    source.ownership ?? source.managedBy ?? filterSource.ownership ?? filterSource.managedBy,
    OWNERSHIP.MODEL_OWNED
  );
  const emitter = cloneObject(source);
  const eventFilterExtras = isPlainObject(source.eventFilter)
    ? Object.fromEntries(Object.entries(source.eventFilter).filter(([key]) => !KNOWN_FILTER_KEYS.has(key)))
    : {};

  if (warn) {
    warnUnknownFields(warn, `Emitter '${normalizeName(source.name, "(unnamed)")}'`, getUnknownKeys(source, KNOWN_EMITTER_KEYS));
  }

  emitter.stream = source.stream ?? source.channel ?? source.name;
  emitter.channel = source.channel ?? source.stream ?? source.name;
  emitter.ownership = ownership;
  emitter.managedBy = ownership;
  emitter.eventFilter = {
    ...eventFilterExtras,
    ...EventFilterService.deserialize({
    ...filterSource,
    ownership: filterSource.ownership ?? filterSource.managedBy ?? ownership,
    lifespan: filterSource.lifespan ?? filterSource.scope ?? source.lifespan ?? source.scope
    })
  };

  if (warn) {
    warnUnknownFields(
      warn,
      `Event filter for emitter '${normalizeName(source.name, "(unnamed)")}'`,
      Object.keys(eventFilterExtras)
    );
  }

  return emitter;
}

function normalizeConfigShape(source, options = {}) {
  const warn = resolveWarn(options);
  const config = cloneObject(source);
  const version = normalizeVersion(config.configVersion ?? CONFIG_VERSION.V1);

  if (warn) {
    warnUnknownFields(warn, "Config root", getUnknownKeys(config, KNOWN_ROOT_KEYS));
  }

  config.configVersion = version;
  config.streams = Array.isArray(config.streams) ? config.streams.map((entry) => normalizePersistedStream(entry, options)) : [];
  config.emitters = Array.isArray(config.emitters) ? config.emitters.map((entry) => normalizePersistedEmitter(entry, options)) : [];

  return config;
}

/**
 * Reserved migration for the first breaking change.
 *
 * Planned v2 change:
 * - keep the current canonical emitter/stream shape, but bump the persisted
 *   version so future schema changes can be chained deterministically.
 *
 * This function stays pure and deterministic so it can be tested in isolation.
 */
export function migrate_v1_to_v2(config, options = {}) {
  return {
    ...normalizeConfigShape(config, options),
    configVersion: CONFIG_VERSION.V2
  };
}

/**
 * Reserved migration for the next breaking change.
 */
export function migrate_v2_to_v3(config, options = {}) {
  return {
    ...normalizeConfigShape(config, options),
    configVersion: CONFIG_VERSION.V3
  };
}

const MIGRATIONS = new Map([
  [CONFIG_VERSION.V1, migrate_v1_to_v2],
  [CONFIG_VERSION.V2, migrate_v2_to_v3]
]);

export function migrateConfig(config, targetVersion = LATEST_CONFIG_VERSION, options = {}) {
  let current = normalizeConfigShape(config, options);
  let version = current.configVersion;
  const warn = resolveWarn(options);

  if (version > targetVersion) {
    throw new ValidationError(`Config version ${version} is newer than the supported version ${targetVersion}.`);
  }

  while (version < targetVersion) {
    const step = MIGRATIONS.get(version);
    if (!step) {
      throw new ValidationError(`No migration defined for config version ${version} → ${version + 1}.`);
    }

    current = step(current, options);
    version = normalizeVersion(current.configVersion);
  }

  if (warn && current.configVersion !== version) {
    warn(`Config migration normalized version ${current.configVersion} to ${version}.`);
  }

  return current;
}

export function getConfigVersionLabel(version) {
  switch (normalizeVersion(version)) {
    case CONFIG_VERSION.V1:
      return "v1";
    case CONFIG_VERSION.V2:
      return "v2";
    case CONFIG_VERSION.V3:
      return "v3";
    default:
      return `v${version}`;
  }
}
