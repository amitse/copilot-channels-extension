import {
  DEFAULT_CHANNEL,
  DELIVERY,
  MANAGED_BY,
  MAX_CHANNEL_ENTRIES,
  SCOPE,
  SOURCE
} from "../consts.mjs";
import {
  normalizeDelivery,
  normalizeManagedBy,
  normalizeName,
  normalizeScope
} from "../util/normalize.mjs";
import { toText } from "../util/text.mjs";
import { nowIso } from "../util/time.mjs";
import { assertMutable } from "../util/policy.mjs";

export function createSubscription(overrides = {}) {
  return {
    enabled: Boolean(overrides.enabled),
    delivery: normalizeDelivery(overrides.delivery, DELIVERY.IMPORTANT),
    scope: normalizeScope(overrides.scope, SCOPE.TEMPORARY),
    managedBy: normalizeManagedBy(overrides.managedBy, MANAGED_BY.MODEL)
  };
}

export function createChannelStore() {
  const channels = new Map();

  function ensure(rawName, description = "") {
    const name = normalizeName(rawName, DEFAULT_CHANNEL);
    let channel = channels.get(name);

    if (!channel) {
      channel = {
        name,
        description: String(description ?? "").trim(),
        createdAt: nowIso(),
        entries: [],
        subscription: createSubscription()
      };
      channels.set(name, channel);
    } else if (description && !channel.description) {
      channel.description = String(description).trim();
    }

    return channel;
  }

  function append(rawChannel, entry) {
    const channel = ensure(rawChannel);
    const normalizedEntry = {
      timestamp: entry.timestamp ?? nowIso(),
      source: entry.source ?? SOURCE.SYSTEM,
      text: toText(entry.text).trim(),
      monitorName: entry.monitorName ?? null,
      stream: entry.stream ?? null
    };

    if (!normalizedEntry.text) {
      return null;
    }

    channel.entries.push(normalizedEntry);
    if (channel.entries.length > MAX_CHANNEL_ENTRIES) {
      channel.entries.splice(0, channel.entries.length - MAX_CHANNEL_ENTRIES);
    }

    return normalizedEntry;
  }

  function get(rawName) {
    return channels.get(normalizeName(rawName));
  }

  function list() {
    return [...channels.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  function size() {
    return channels.size;
  }

  function configureSubscription(rawName, options = {}) {
    const channel = ensure(rawName, options.description ?? "");

    assertMutable(channel.subscription.managedBy, options.force, `Subscription for channel '${channel.name}'`);

    channel.subscription = createSubscription({
      enabled: options.enabled,
      delivery: options.delivery ?? channel.subscription.delivery,
      scope: options.scope ?? channel.subscription.scope,
      managedBy: options.managedBy ?? channel.subscription.managedBy
    });

    return channel;
  }

  function applyPersistentChannel(entry) {
    const channel = ensure(entry.name, entry.description ?? "");
    const configSubscription = entry.subscription ?? {};
    channel.subscription = createSubscription({
      enabled: configSubscription.enabled === true,
      delivery: configSubscription.delivery ?? DELIVERY.IMPORTANT,
      scope: SCOPE.PERSISTENT,
      managedBy: configSubscription.managedBy ?? MANAGED_BY.USER
    });
    return channel;
  }

  return {
    ensure,
    append,
    get,
    list,
    size,
    configureSubscription,
    applyPersistentChannel
  };
}
