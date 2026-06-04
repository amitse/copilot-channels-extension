import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { ValidationError } from "../errors/index.mjs";
import { normalizeDelivery, normalizeLifespan, normalizeName, normalizeOwnership } from "../util/normalize.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";

export const CONFIG_VERSION = Object.freeze({
  V1: 1,
  V2: 2,
  V3: 3
});

/**
 * Current on-disk schema version.
 *
 * v1: legacy shape where older field aliases may still appear on disk.
 * v2: canonical shape with legacy aliases stripped during migration.
 * v3: reserved for the next major schema change.
 */
export const LATEST_CONFIG_VERSION = CONFIG_VERSION.V2;

const KNOWN_ROOT_KEYS = new Set(["configVersion", "streams", "emitters"]);
const KNOWN_STREAM_KEYS = new Set(["name", "description", "sessionInjector"]);
const LEGACY_STREAM_KEYS = new Set(["subscription"]);
const KNOWN_EMITTER_KEYS = new Set([
  "name",
  "stream",
  "channel",
  "command",
  "prompt",
  "every",
  "everySchedule",
  "everyScheduleMs",
  "description",
  "cwd",
  "autoStart",
  "includeStderr",
  "ownership",
  "eventFilter",
  "scope",
  "lifespan",
  "delivery",
  "subscribe",
  "force",
  "maxRuns"
]);
const KNOWN_FILTER_KEYS = new Set([
  "rules",
  "ownership",
  "lifespan",
  "scope"
]);
const KNOWN_SESSION_INJECTOR_KEYS = new Set([
  "enabled",
  "delivery",
  "ownership",
  "lifespan",
  "scope"
]);
const LEGACY_EMITTER_KEYS = new Set([
  "managedBy",
  "classifier",
  "includePattern",
  "excludePattern",
  "notifyPattern"
]);
const LEGACY_FILTER_KEYS = new Set([
  "managedBy",
  "scope",
  "includePattern",
  "excludePattern",
  "notifyPattern"
]);
const LEGACY_SESSION_INJECTOR_KEYS = new Set(["managedBy", "scope"]);

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function cloneObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function pickPreservedFields(source, ignoredKeys) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !ignoredKeys.has(key)));
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
  const preserved = pickPreservedFields(injector, new Set([...KNOWN_SESSION_INJECTOR_KEYS, ...LEGACY_SESSION_INJECTOR_KEYS]));

  return {
    ...preserved,
    enabled: injector.enabled === true,
    delivery: normalizeDelivery(injector.delivery, EVENT_OUTCOME.SURFACE),
    ownership: normalizeOwnership(injector.ownership, OWNERSHIP.MODEL_OWNED),
    lifespan: normalizeLifespan(injector.lifespan, LIFESPAN.TEMPORARY)
  };
}

function normalizeLegacyRules(source) {
  const rules = Array.isArray(source.rules) ? [...source.rules] : [];

  if (rules.length > 0) {
   return rules;
  }

  if (source.excludePattern) {
   rules.push({ match: String(source.excludePattern), outcome: EVENT_OUTCOME.DROP });
  }
  if (source.notifyPattern) {
   rules.push({ match: String(source.notifyPattern), outcome: EVENT_OUTCOME.INJECT });
  }
  if (source.includePattern) {
   rules.push({ match: String(source.includePattern), outcome: EVENT_OUTCOME.KEEP });
   rules.push({ match: ".*", outcome: EVENT_OUTCOME.DROP });
  }

  return rules;
}

function normalizePersistedEventFilter(filterSource, ownership, lifespan) {
  const source = isPlainObject(filterSource) ? filterSource : {};
  const filterOwnership = normalizeOwnership(
   source.ownership,
   ownership
  );
  const filterLifespan = normalizeLifespan(
   source.lifespan,
   lifespan
  );
  const rules = normalizeLegacyRules(source);
  const preserved = pickPreservedFields(source, new Set([...KNOWN_FILTER_KEYS, ...LEGACY_FILTER_KEYS]));

  return {
   ...preserved,
   ...EventFilterService.serialize(
     EventFilterService.create({
       rules,
       ownership: filterOwnership,
       lifespan: filterLifespan
     })
   )
  };
}

export function normalizePersistedStream(entry = {}, options = {}) {
  const warn = resolveWarn(options);
  const source = isPlainObject(entry) ? entry : {};
  const stream = pickPreservedFields(source, new Set([...KNOWN_STREAM_KEYS, ...LEGACY_STREAM_KEYS]));

  if (warn) {
   warnUnknownFields(
     warn,
     `Stream '${normalizeName(source.name, "(unnamed)")}'`,
     getUnknownKeys(source, new Set([...KNOWN_STREAM_KEYS, ...LEGACY_STREAM_KEYS]))
   );
  }

  stream.name = source.name;
  if (source.description !== undefined) {
   stream.description = source.description;
  }
  const sessionInjectorSource = isPlainObject(source.sessionInjector)
   ? source.sessionInjector
   : isPlainObject(source.subscription)
     ? source.subscription
     : null;
  if (sessionInjectorSource) {
   const preserved = pickPreservedFields(
     sessionInjectorSource,
     new Set([...KNOWN_SESSION_INJECTOR_KEYS, ...LEGACY_SESSION_INJECTOR_KEYS])
   );
   if (warn) {
     warnUnknownFields(
       warn,
       `Session injector for stream '${normalizeName(source.name, "(unnamed)")}'`,
       getUnknownKeys(sessionInjectorSource, new Set([...KNOWN_SESSION_INJECTOR_KEYS, ...LEGACY_SESSION_INJECTOR_KEYS]))
     );
   }
   stream.sessionInjector = {
     ...preserved,
     ...normalizeSessionInjector(sessionInjectorSource)
   };
  }

  return stream;
}

export function normalizePersistedEmitter(entry = {}, options = {}) {
  const warn = resolveWarn(options);
  const source = isPlainObject(entry) ? entry : {};
  const ownership = normalizeOwnership(
   source.ownership
   ?? source.managedBy
   ?? source.eventFilter?.ownership
   ?? source.eventFilter?.managedBy
   ?? source.classifier?.ownership
   ?? source.classifier?.managedBy,
   OWNERSHIP.MODEL_OWNED
  );
  const emitter = pickPreservedFields(source, LEGACY_EMITTER_KEYS);
  const filterSource = isPlainObject(source.eventFilter)
   ? source.eventFilter
   : isPlainObject(source.classifier)
     ? source.classifier
     : {
         rules: normalizeLegacyRules(source),
         ownership: source.ownership ?? source.managedBy,
         lifespan: source.lifespan ?? source.scope
       };
  const eventFilter = normalizePersistedEventFilter(filterSource, ownership, normalizeLifespan(source.lifespan ?? source.scope, LIFESPAN.TEMPORARY));

  if (warn) {
   warnUnknownFields(
     warn,
     `Emitter '${normalizeName(source.name, "(unnamed)")}'`,
     getUnknownKeys(source, new Set([...KNOWN_EMITTER_KEYS, ...LEGACY_EMITTER_KEYS]))
   );
  }

  emitter.stream = source.stream ?? source.channel ?? source.name;
  emitter.channel = source.channel ?? source.stream ?? source.name;
  emitter.ownership = ownership;
  emitter.eventFilter = eventFilter;

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
 * Final v1 → v2 migration.
 *
 * v2 is the canonical on-disk shape: legacy aliases are removed and any old
 * event-filter/session-injector fields are converted to canonical names before
 * the config is re-saved.
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
