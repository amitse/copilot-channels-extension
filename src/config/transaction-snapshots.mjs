import { normalizeName } from "../util/normalize.mjs";

export function cloneConfigEntry(entry) {
  return entry ? JSON.parse(JSON.stringify(entry)) : null;
}

export function snapshotPersistentStreamConfig(configStore, name, options = {}) {
  const streamEntries = options.requireConfigStore === true
    ? (typeof configStore.getStreams === "function" ? configStore.getStreams() : null)
    : (configStore && typeof configStore.getStreams === "function" ? configStore.getStreams() : null);
  if (!Array.isArray(streamEntries)) {
    return null;
  }

  const normalized = normalizeName(name);
  const entry = streamEntries.find((candidate) => normalizeName(candidate?.name) === normalized);
  return {
    name: normalized,
    existed: Boolean(entry),
    entry: cloneConfigEntry(entry)
  };
}

export function restorePersistentStreamConfig(configStore, snapshot, options = {}) {
  if (!snapshot) {
    return;
  }
  if (options.requireConfigStore !== true && !configStore) {
    return;
  }
  if (typeof configStore.getStreams !== "function") {
    return;
  }

  const streamEntries = configStore.getStreams();
  if (!Array.isArray(streamEntries)) {
    return;
  }

  const index = streamEntries.findIndex((entry) => normalizeName(entry?.name) === snapshot.name);
  if (!snapshot.existed) {
    if (index >= 0) {
      streamEntries.splice(index, 1);
    }
    return;
  }

  if (index >= 0) {
    streamEntries[index] = snapshot.entry;
  } else {
    streamEntries.push(snapshot.entry);
  }
}

export function restorePersistentStreamConfigBestEffort(configStore, snapshot) {
  if (!snapshot || !configStore || typeof configStore.getStreams !== "function") {
    return;
  }

  try {
    restorePersistentStreamConfig(configStore, snapshot);
  } catch {
    // Rollback is best-effort; keep the original persistence failure as the cause.
  }
}
