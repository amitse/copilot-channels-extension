import { DELIVERY, MANAGED_BY, MONITOR_OPERATION_STATUS, MONITOR_STATUS, SCOPE } from "../consts.mjs";
import { normalizeManagedBy, normalizeName, normalizeScope } from "../util/normalize.mjs";
import { assertMutable, isTerminalMonitorStatus } from "../util/policy.mjs";
import { createClassifier, formatClassifier } from "../format/classifier.mjs";
import { buildMonitorState } from "./state.mjs";
import { createLineRouter } from "./line-router.mjs";
import { createLifecycle } from "./lifecycle.mjs";

export function createMonitorSupervisor({ channels, configStore, notifications, sessionPort, getBaseCwd, persist }) {
  const monitors = new Map();
  const lineRouter = createLineRouter({ channels, notifications });
  const lifecycle = createLifecycle({ lineRouter, sessionPort });

  async function start(spec, options = {}) {
    const baseCwd = options.baseCwd ?? getBaseCwd();
    const monitor = buildMonitorState(spec, baseCwd, options);
    const existing = monitors.get(monitor.name);

    if (existing && !isTerminalMonitorStatus(existing.status)) {
      throw new Error(`Monitor '${monitor.name}' is already active.`);
    }
    if (existing) {
      assertMutable(existing.managedBy, options.force, `Monitor '${monitor.name}'`);
    }

    channels.ensure(monitor.channel, monitor.description || `Events for ${monitor.name}`);
    monitors.set(monitor.name, monitor);

    try {
      lifecycle.start(monitor);
    } catch (error) {
      monitors.delete(monitor.name);
      throw error;
    }

    if (options.subscribe === true) {
      const channel = channels.configureSubscription(monitor.channel, {
        enabled: true,
        delivery: options.delivery ?? DELIVERY.IMPORTANT,
        scope: options.scope ?? monitor.scope,
        managedBy: options.managedBy ?? monitor.managedBy,
        description: spec.channelDescription ?? monitor.description,
        force: options.force
      });

      void sessionPort.log(
        `${channel.subscription.enabled ? "Subscribed" : "Unsubscribed"} channel '${channel.name}' with delivery=${channel.subscription.delivery} scope=${channel.subscription.scope} managedBy=${channel.subscription.managedBy}.`
      );

      if (channel.subscription.scope === SCOPE.PERSISTENT) {
        configStore.upsertChannel(channel);
      }
    }

    if (monitor.scope === SCOPE.PERSISTENT) {
      configStore.upsertMonitor(monitor);
      persist();
    } else if (options.subscribe === true && channels.ensure(monitor.channel).subscription.scope === SCOPE.PERSISTENT) {
      persist();
    }

    await sessionPort.log(
      `Started monitor '${monitor.name}' (${monitor.workType}, ${monitor.executionMode}) on channel '${monitor.channel}' in ${monitor.cwd}.`
    );
    return monitor;
  }

  async function stop(name, options = {}) {
    const normalized = normalizeName(name);
    const scope = normalizeScope(options.scope, SCOPE.TEMPORARY);
    const monitor = monitors.get(normalized);

    if (monitor) {
      assertMutable(monitor.managedBy, options.force, `Monitor '${normalized}'`);
      await lifecycle.stop(monitor);
    }

    if (scope === SCOPE.PERSISTENT) {
      const removed = configStore.removeMonitor(normalized, options.force);
      if (removed) {
        persist();
        void sessionPort.log(`Removed persistent monitor '${normalized}' from config.`);
      }

      if (!monitor && !removed) {
        throw new Error(`Monitor '${normalized}' was not found in the session or persistent config.`);
      }

      return {
        name: normalized,
        status: removed ? MONITOR_OPERATION_STATUS.REMOVED_FROM_CONFIG : monitor?.status ?? MONITOR_STATUS.STOPPED
      };
    }

    if (!monitor) {
      throw new Error(`Monitor '${normalized}' is not running in this session.`);
    }

    return monitor;
  }

  function updateClassifier(name, input, options = {}) {
    const normalized = normalizeName(name);
    const scope = normalizeScope(options.scope, SCOPE.TEMPORARY);
    const managedBy = normalizeManagedBy(options.managedBy, MANAGED_BY.MODEL);
    const monitor = monitors.get(normalized);
    const configEntry = configStore.findMonitor(normalized);

    if (monitor) {
      assertMutable(monitor.classifier.managedBy, options.force, `Classifier for monitor '${normalized}'`);
      monitor.classifier = createClassifier(
        {
          includePattern: input.includePattern ?? monitor.classifier.includePattern,
          excludePattern: input.excludePattern ?? monitor.classifier.excludePattern,
          notifyPattern: input.notifyPattern ?? monitor.classifier.notifyPattern,
          managedBy: options.managedBy ?? monitor.classifier.managedBy,
          scope
        },
        managedBy,
        scope
      );

      if (scope === SCOPE.PERSISTENT) {
        monitor.scope = SCOPE.PERSISTENT;
        configStore.upsertMonitor(monitor);
        persist();
      }

      void sessionPort.log(`Updated classifier for monitor '${normalized}': ${formatClassifier(monitor.classifier)}`);

      return monitor;
    }

    if (scope !== SCOPE.PERSISTENT || !configEntry) {
      throw new Error(`Monitor '${normalized}' is not running, so only a persistent classifier update is possible when it exists in config.`);
    }

    assertMutable(
      normalizeManagedBy(configEntry.classifier?.managedBy ?? configEntry.managedBy, MANAGED_BY.USER),
      options.force,
      `Classifier for monitor '${normalized}'`
    );

    configEntry.classifier = {
      includePattern: input.includePattern ?? configEntry.classifier?.includePattern,
      excludePattern: input.excludePattern ?? configEntry.classifier?.excludePattern,
      notifyPattern: input.notifyPattern ?? configEntry.classifier?.notifyPattern,
      managedBy
    };

    persist();
    void sessionPort.log(`Updated persistent classifier for monitor '${normalized}': ${formatClassifier(configEntry.classifier)}`);
    return {
      name: normalized,
      status: MONITOR_OPERATION_STATUS.CONFIGURED,
      classifier: createClassifier(configEntry.classifier, managedBy, SCOPE.PERSISTENT)
    };
  }

  async function stopAll() {
    const active = [...monitors.values()].filter((monitor) => !isTerminalMonitorStatus(monitor.status));
    await Promise.allSettled(active.map((monitor) => lifecycle.stop(monitor)));
  }

  function list() {
    return [...monitors.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  function has(name) {
    return monitors.has(normalizeName(name));
  }

  function get(name) {
    return monitors.get(normalizeName(name));
  }

  return {
    start,
    stop,
    stopAll,
    updateClassifier,
    list,
    has,
    get
  };
}
