import { LIFESPAN } from "../consts.mjs";
import { formatSessionInjectorPolicyLog } from "../format/stream.mjs";

export function applySessionInjectorPolicy(deps, rawName, options, policy = {}) {
  const { streams, configStore, sessionPort, persist } = deps;
  const { persistConfig = true } = policy;
  const stream = streams.configureSessionInjector(rawName, options);

  void sessionPort.log(formatSessionInjectorPolicyLog(stream));

  if (stream.sessionInjector.lifespan === LIFESPAN.PERSISTENT) {
    configStore.upsertStream(stream);
    if (persistConfig) {
      persist();
    }
  }

  return stream;
}
