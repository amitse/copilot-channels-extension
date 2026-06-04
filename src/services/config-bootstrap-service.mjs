import { DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { normalizeStartScopeAndOwnership } from "../emitter/start-options.mjs";

export function createConfigBootstrapService({ streams, configStore, supervisor, sessionPort, setBaseCwd }) {
  async function loadPersistentConfig(inputCwd) {
    const resolvedBaseCwd = setBaseCwd(inputCwd);

    const configLoad = configStore.load(resolvedBaseCwd);
    streams.ensure(DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION);

    for (const entry of configStore.getStreams()) {
      streams.applyPersistentStream(entry);
    }

    let started = 0;
    for (const entry of configStore.getEmitters()) {
      if (entry.autoStart === false) {
        continue;
      }

      try {
        const startPolicy = normalizeStartScopeAndOwnership(
          { scope: LIFESPAN.PERSISTENT, managedBy: entry.ownership },
          { scope: LIFESPAN.PERSISTENT, managedBy: OWNERSHIP.USER_OWNED }
        );
        await supervisor.start(
          {
            ...entry,
            scope: startPolicy.scope,
            managedBy: startPolicy.managedBy
          },
          {
            baseCwd: resolvedBaseCwd,
            scope: startPolicy.scope,
            managedBy: startPolicy.managedBy,
            subscribe: false,
            force: true
          }
        );
        started += 1;
      } catch (error) {
        await sessionPort.log(`Failed to auto-start emitter '${entry.name}': ${error.message}`, {
          level: "warning"
        });
      }
    }

    return configLoad.found
      ? `Loaded ${configStore.getStreams().length} event streams and ${configStore.getEmitters().length} persistent emitter definitions from ${configLoad.filePath}. Auto-started ${started}.`
      : "No copilot-channels config file found.";
  }

  return {
    loadPersistentConfig
  };
}
