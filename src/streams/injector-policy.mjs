import { DEFAULT_STREAM, LIFESPAN } from "../consts.mjs";
import { formatSessionInjectorPolicyLog } from "../format/stream.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { restorePersistentStreamConfigBestEffort, snapshotPersistentStreamConfig } from "../config/transaction-snapshots.mjs";

function snapshotRuntimeStream(streams, rawName) {
  const name = normalizeName(rawName, DEFAULT_STREAM);
  const stream = streams.get(name);

  return {
    name,
    existed: Boolean(stream),
    description: stream?.description,
    sessionInjector: stream?.sessionInjector ? { ...stream.sessionInjector } : null
  };
}

function restoreRuntimeStream(streams, stream, snapshot) {
  if (!snapshot) {
    return;
  }

  if (!snapshot.existed) {
    if (stream && typeof streams.remove === "function") {
      streams.remove(stream.name);
    }
    return;
  }

  const target = stream ?? streams.get(snapshot.name);
  if (!target) {
    return;
  }

  if (snapshot.description !== undefined) {
    target.description = snapshot.description;
  }
  if (snapshot.sessionInjector) {
    target.sessionInjector = { ...snapshot.sessionInjector };
  } else {
    delete target.sessionInjector;
  }
}

export function applySessionInjectorPolicy(deps, rawName, options, policy = {}) {
  const { streams, configStore, sessionPort, persist } = deps;
  const { persistConfig = true } = policy;
  const runtimeSnapshot = snapshotRuntimeStream(streams, rawName);
  const configSnapshot = snapshotPersistentStreamConfig(configStore, runtimeSnapshot.name);
  let stream;

  try {
    stream = streams.configureSessionInjector(rawName, options);
    if (stream.sessionInjector.lifespan === LIFESPAN.PERSISTENT) {
      configStore.upsertStream(stream);
      if (persistConfig) {
        persist();
      }
    }
  } catch (error) {
    restoreRuntimeStream(streams, stream, runtimeSnapshot);
    restorePersistentStreamConfigBestEffort(configStore, configSnapshot);
    throw error;
  }

  void sessionPort.log(formatSessionInjectorPolicyLog(stream));
  return stream;
}
