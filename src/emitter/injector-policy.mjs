import { LIFESPAN } from "../consts.mjs";

export function applySessionInjectorPolicy(deps, rawName, options, policy = {}) {
  const { streams, configStore, sessionPort, persist } = deps;
  const { persistConfig = true } = policy;
  const stream = streams.configureSessionInjector(rawName, options);

  void sessionPort.log(
    `${stream.sessionInjector.enabled ? "Subscribed" : "Unsubscribed"} stream '${stream.name}' with delivery=${stream.sessionInjector.delivery} lifespan=${stream.sessionInjector.lifespan} ownership=${stream.sessionInjector.ownership}.`
  );

  if (stream.sessionInjector.lifespan === LIFESPAN.PERSISTENT) {
    configStore.upsertStream(stream);
    if (persistConfig) {
      persist();
    }
  }

  return stream;
}
