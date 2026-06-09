import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { normalizeOptionalPositiveInteger, readOptionalText, resolveEmitterStreamInput } from "../contracts/emitter-input.mjs";
import { ValidationError } from "../errors/index.mjs";
import { normalizeDelivery, normalizeLifespan, normalizeName, normalizeOwnership, requireNormalizedName } from "../util/normalize.mjs";
import { isStrictPlainObject } from "../util/type-guards.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import { stripEmitterRuntimeFields } from "./emitter-schema.mjs";

export const CONFIG_VERSION = Object.freeze({
  V1: 1,
  V2: 2,
  V3: 3
});

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
const KNOWN_FILTER_KEYS = new Set(["rules", "ownership", "lifespan", "scope"]);
const KNOWN_SESSION_INJECTOR_KEYS = new Set(["enabled", "delivery", "ownership", "lifespan", "scope"]);
const LEGACY_EMITTER_KEYS = new Set([
  "managedBy",
  "scope",
  "classifier",
  "runInterval",
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

function describeInputType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function cloneObject(value) {
  return isStrictPlainObject(value) ? { ...value } : {};
}

function pickPreservedFields(source, ignoredKeys) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !ignoredKeys.has(key)));
}

export function resolveWarn(options = {}) {
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

function requireConfigRoot(source) {
  if (!isStrictPlainObject(source)) {
    throw new ValidationError("Invalid persisted config: root must be a JSON object.", {
      context: {
        type: describeInputType(source)
      }
    });
  }

  return cloneObject(source);
}

function normalizePersistedCollection(config, key, label, normalizer, options) {
  if (Object.hasOwn(config, key) && !Array.isArray(config[key])) {
    throw new ValidationError(`Invalid persisted config: ${key} must be an array when present.`, {
      context: {
        field: key,
        type: describeInputType(config[key])
      }
    });
  }

  const entries = Array.isArray(config[key])
    ? config[key].map((entry) => normalizer(entry, options))
    : [];

  assertUniqueNormalizedNames(entries, label);

  return entries;
}

function assertUniqueNormalizedNames(entries, label) {
  const seen = new Map();

  for (const [index, entry] of entries.entries()) {
    const normalized = normalizeName(entry?.name);
    const first = seen.get(normalized);

    if (first) {
      throw new ValidationError(`Duplicate persisted ${label} name '${normalized}'. Names must be unique after normalization.`, {
        context: {
          normalizedName: normalized,
          firstName: first.name,
          firstIndex: first.index,
          duplicateName: entry?.name,
          duplicateIndex: index
        }
      });
    }

    seen.set(normalized, {
      name: entry?.name,
      index
    });
  }
}

function normalizeVersion(value, fallback = CONFIG_VERSION.V1) {
  const raw = value ?? fallback;
  let candidate = null;

  if (typeof raw === "number") {
    candidate = raw;
  } else if (typeof raw === "string") {
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
      candidate = Number(text);
    }
  }

  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new ValidationError(`Invalid configVersion '${value}'. Expected a positive integer.`);
  }

  return candidate;
}

function normalizeSessionInjector(source, defaults = {}) {
  const injector = cloneObject(source);
  const preserved = pickPreservedFields(injector, new Set([...KNOWN_SESSION_INJECTOR_KEYS, ...LEGACY_SESSION_INJECTOR_KEYS]));
  const defaultOwnership = defaults.ownership ?? OWNERSHIP.MODEL_OWNED;
  const defaultLifespan = defaults.lifespan ?? LIFESPAN.TEMPORARY;

  return {
    ...preserved,
    enabled: injector.enabled === true,
    delivery: normalizeDelivery(injector.delivery, EVENT_OUTCOME.SURFACE),
    ownership: normalizeOwnership(injector.ownership ?? injector.managedBy, defaultOwnership),
    lifespan: normalizeLifespan(injector.lifespan ?? injector.scope, defaultLifespan)
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
  const source = Array.isArray(filterSource)
    ? { rules: filterSource }
    : isStrictPlainObject(filterSource)
      ? filterSource
      : {};
  const filterOwnership = source.ownership ?? source.managedBy;
  const filterLifespan = source.lifespan ?? source.scope;
  const rules = normalizeLegacyRules(source);
  const preserved = pickPreservedFields(source, new Set([...KNOWN_FILTER_KEYS, ...LEGACY_FILTER_KEYS]));

  return {
    ...preserved,
    ...EventFilterService.serialize(
      EventFilterService.create(
        {
          rules,
          ownership: filterOwnership,
          lifespan: filterLifespan
        },
        ownership,
        lifespan
      )
    )
  };
}

export function normalizePersistedStream(entry = {}, options = {}) {
  const warn = resolveWarn(options);
  const source = isStrictPlainObject(entry) ? entry : {};
  requireNormalizedName(source.name, {
    label: "Invalid persisted stream: name",
    contextKey: "name"
  });
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

  const sessionInjectorSource = isStrictPlainObject(source.sessionInjector)
    ? source.sessionInjector
    : isStrictPlainObject(source.subscription)
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
      ...normalizeSessionInjector(sessionInjectorSource, {
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.PERSISTENT
      })
    };
  }

  return stream;
}

export function normalizePersistedEmitter(entry = {}, options = {}) {
  const warn = resolveWarn(options);
  const source = isStrictPlainObject(entry) ? entry : {};
  requireNormalizedName(source.name, {
    label: "Invalid persisted emitter: name",
    contextKey: "name"
  });
  const ownership = normalizeOwnership(
    source.ownership
      ?? source.managedBy
      ?? source.eventFilter?.ownership
      ?? source.eventFilter?.managedBy
      ?? source.classifier?.ownership
      ?? source.classifier?.managedBy,
    OWNERSHIP.USER_OWNED
  );
  const lifespan = normalizeLifespan(source.lifespan ?? source.scope, LIFESPAN.PERSISTENT);
  const emitter = pickPreservedFields(stripEmitterRuntimeFields(source), LEGACY_EMITTER_KEYS);
  const filterSource = Array.isArray(source.eventFilter)
    ? source.eventFilter
    : isStrictPlainObject(source.eventFilter)
      ? source.eventFilter
      : isStrictPlainObject(source.classifier)
        ? source.classifier
        : {
            rules: normalizeLegacyRules(source),
            ownership: source.ownership ?? source.managedBy,
            lifespan: source.lifespan ?? source.scope
          };
  const eventFilter = normalizePersistedEventFilter(
    filterSource,
    ownership,
    lifespan
  );

  if (warn) {
    warnUnknownFields(
      warn,
      `Emitter '${normalizeName(source.name, "(unnamed)")}'`,
      getUnknownKeys(source, new Set([...KNOWN_EMITTER_KEYS, ...LEGACY_EMITTER_KEYS]))
    );
  }

  // The documented config field is `stream`; `channel` remains accepted only as
  // a legacy input alias.  When both appear, prefer `stream` so stale channel
  // aliases cannot override an edited stream at runtime.
  emitter.stream = resolveEmitterStreamInput(source, source.name);
  delete emitter.channel;
  if (emitter.every === undefined) {
    const runInterval = readOptionalText(source.runInterval);
    if (runInterval) {
      emitter.every = runInterval;
    }
  }
  if (source.maxRuns !== undefined) {
    emitter.maxRuns = normalizeOptionalPositiveInteger(source.maxRuns, {
      label: "maxRuns",
      errorPrefix: "Invalid persisted emitter"
    });
  }
  emitter.ownership = ownership;
  emitter.lifespan = lifespan;
  emitter.eventFilter = eventFilter;

  return emitter;
}

export function normalizePersistedConfig(source, options = {}) {
  const warn = resolveWarn(options);
  const config = requireConfigRoot(source);
  const version = normalizeVersion(config.configVersion ?? CONFIG_VERSION.V1);

  if (warn) {
    warnUnknownFields(warn, "Config root", getUnknownKeys(config, KNOWN_ROOT_KEYS));
  }

  config.configVersion = version;
  config.streams = normalizePersistedCollection(config, "streams", "stream", normalizePersistedStream, options);
  config.emitters = normalizePersistedCollection(config, "emitters", "emitter", normalizePersistedEmitter, options);

  return config;
}

export function getConfigVersion(version) {
  return normalizeVersion(version);
}
