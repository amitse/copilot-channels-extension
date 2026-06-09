import {
  DEFAULT_STREAM,
  EVENT_OUTCOME,
  LIFESPAN,
  MAX_STREAM_ENTRIES,
  OWNERSHIP,
  SOURCE
} from "../consts.mjs";
import {
  normalizeDelivery,
  normalizeLifespan,
  normalizeName,
  normalizeOwnership,
  requireNormalizedName
} from "../util/normalize.mjs";
import { toText } from "../util/text.mjs";
import { nowIso } from "../util/time.mjs";
import { assertMutable } from "../util/policy.mjs";
import { isStrictPlainObject } from "../util/type-guards.mjs";

function getPersistentStreamSessionInjectorSource(entry) {
  if (isStrictPlainObject(entry?.sessionInjector)) {
    return entry.sessionInjector;
  }
  if (isStrictPlainObject(entry?.subscription)) {
    return entry.subscription;
  }

  return null;
}

export function hasExplicitPersistentSessionInjector(entry) {
  return getPersistentStreamSessionInjectorSource(entry) !== null;
}

function createSessionInjector(overrides = {}) {
  return {
    enabled: Boolean(overrides.enabled),
    delivery: normalizeDelivery(overrides.delivery, EVENT_OUTCOME.SURFACE),
    lifespan: normalizeLifespan(overrides.scope ?? overrides.lifespan, LIFESPAN.TEMPORARY),
    ownership: normalizeOwnership(overrides.managedBy ?? overrides.ownership, OWNERSHIP.MODEL_OWNED)
  };
}

function createPersistentSessionInjector(configInjector) {
  return createSessionInjector({
    enabled: configInjector.enabled === true,
    delivery: configInjector.delivery ?? EVENT_OUTCOME.SURFACE,
    lifespan: configInjector.lifespan ?? configInjector.scope ?? LIFESPAN.PERSISTENT,
    ownership: configInjector.ownership ?? configInjector.managedBy ?? OWNERSHIP.USER_OWNED
  });
}

function metadataSnapshot(metadata) {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return { metadata: { ...metadata } };
  }

  return {};
}

function createStreamEntry(sourceEntry, text) {
  return {
    timestamp: sourceEntry.timestamp ?? nowIso(),
    source: sourceEntry.source ?? SOURCE.SYSTEM,
    text,
    monitorName: sourceEntry.monitorName ?? null,
    stream: sourceEntry.stream ?? null,
    ...metadataSnapshot(sourceEntry.metadata)
  };
}

function normalizeStreamAppendInput(rawStream, entry = {}) {
  const sourceEntry = entry ?? {};
  const text = toText(sourceEntry.text).trim();
  if (!text) {
    return null;
  }

  const streamName = requireNormalizedName(rawStream, {
    label: "Stream name",
    contextKey: "stream",
    context: { operation: "append" }
  });

  return { streamName, sourceEntry, text };
}

export function createStreamStore() {
  const streams = new Map();

  function ensure(rawName, description = "") {
    const name = normalizeName(rawName, DEFAULT_STREAM);
    let stream = streams.get(name);

    if (!stream) {
      stream = {
        name,
        description: String(description ?? "").trim(),
        createdAt: nowIso(),
        entries: [],
        sessionInjector: createSessionInjector()
      };
      streams.set(name, stream);
    } else if (description && !stream.description) {
      stream.description = String(description).trim();
    }

    return stream;
  }

  function append(rawStream, entry = {}) {
    const appendInput = normalizeStreamAppendInput(rawStream, entry);
    if (!appendInput) {
      return null;
    }

    const stream = ensure(appendInput.streamName);
    const streamEntry = createStreamEntry(appendInput.sourceEntry, appendInput.text);
    stream.entries.push(streamEntry);
    if (stream.entries.length > MAX_STREAM_ENTRIES) {
      stream.entries.splice(0, stream.entries.length - MAX_STREAM_ENTRIES);
    }

    return streamEntry;
  }

  function get(rawName) {
    return streams.get(normalizeName(rawName));
  }

  function list() {
    return [...streams.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  function size() {
    return streams.size;
  }

  function remove(rawName) {
    return streams.delete(normalizeName(rawName));
  }

  function configureSessionInjector(rawName, options = {}) {
    const injectorOptions = options ?? {};
    const stream = ensure(rawName, injectorOptions.description ?? "");

    assertMutable(stream.sessionInjector.ownership, injectorOptions.force, `Session injector for stream '${stream.name}'`);

    stream.sessionInjector = createSessionInjector({
      enabled: Object.hasOwn(injectorOptions, "enabled")
        ? injectorOptions.enabled
        : stream.sessionInjector.enabled,
      delivery: injectorOptions.delivery ?? stream.sessionInjector.delivery,
      lifespan: injectorOptions.scope ?? injectorOptions.lifespan ?? stream.sessionInjector.lifespan,
      ownership: injectorOptions.managedBy ?? injectorOptions.ownership ?? stream.sessionInjector.ownership
    });

    return stream;
  }

  function applyPersistentStream(entry) {
    const name = requireNormalizedName(entry?.name, {
      label: "Persisted stream name",
      contextKey: "name"
    });
    const stream = ensure(name, entry.description ?? "");
    const configInjector = getPersistentStreamSessionInjectorSource(entry);

    if (Object.hasOwn(entry ?? {}, "description")) {
      stream.description = String(entry.description ?? "").trim();
    }
    if (!configInjector) {
      stream.sessionInjector = createSessionInjector();
      return stream;
    }

    stream.sessionInjector = createPersistentSessionInjector(configInjector);
    return stream;
  }

  return {
    ensure,
    append,
    get,
    list,
    size,
    remove,
    configureSessionInjector,
    applyPersistentStream
  };
}
