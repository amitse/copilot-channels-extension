import { DEFAULT_STREAM, SOURCE } from "../consts.mjs";
import {
  DELIVERY_POLICY,
  decideStreamEventDelivery,
  enqueueDeliveredEvent,
  surfaceDeliveredEvent
} from "../streams/delivery-policy.mjs";
import { normalizeName, requireNormalizedName } from "../util/normalize.mjs";

export function createProviderPushService({ streams, notifications, sessionPort } = {}) {
  function resolveProviderPushStream(provider, push, resolvedProviderName) {
    if (push.stream !== undefined) {
      return requireNormalizedName(push.stream, {
        label: "Provider push stream",
        contextKey: "stream",
        context: { providerId: provider?.providerId }
      });
    }

    return normalizeName(resolvedProviderName) || DEFAULT_STREAM;
  }

  function deliverPush(provider, push) {
    const resolvedProviderName = provider?.providerName ?? provider?.providerId;
    const providerName = resolvedProviderName ?? "provider";
    const streamName = resolveProviderPushStream(provider, push, resolvedProviderName);
    const deliveryDecision = decideStreamEventDelivery({
      policy: DELIVERY_POLICY.PROVIDER_AUTHORITATIVE,
      outcome: push.level
    });
    const entry = streams.append(streamName, {
      source: SOURCE.PROVIDER,
      text: push.event,
      monitorName: providerName,
      // This labels the provider delivery level inside the destination stream;
      // it is not the destination stream name.
      stream: push.level,
      metadata: push.metadata
    });

    if (!entry) {
      return null;
    }

    const notification = {
      channel: streamName,
      monitorName: providerName,
      stream: push.level,
      text: entry.text
    };

    surfaceDeliveredEvent({
      decision: deliveryDecision,
      surface: (message, options) => sessionPort.log(message, options),
      message: `Provider '${providerName}' pushed ${push.level} event to stream '${streamName}': ${entry.text}`,
      options: { level: "info" }
    });
    enqueueDeliveredEvent({ decision: deliveryDecision, notifications, notification });

    return { stream: streamName, entry };
  }

  return {
    deliverPush
  };
}
