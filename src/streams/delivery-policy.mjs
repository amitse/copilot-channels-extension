import { EVENT_OUTCOME } from "../consts.mjs";

export const DELIVERY_POLICY = Object.freeze({
  SESSION_INJECTOR: "session-injector",
  PROVIDER_AUTHORITATIVE: "provider-authoritative"
});

function outcomeToken(value) {
  return String(value ?? "");
}

function deliveryToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sessionInjectorDeliveryMode(sessionInjector) {
  return deliveryToken(sessionInjector?.delivery ?? EVENT_OUTCOME.SURFACE);
}

function canInjectWithSessionInjector(sessionInjector, outcome) {
  if (sessionInjector?.enabled !== true || outcome !== EVENT_OUTCOME.INJECT) {
    return false;
  }

  const delivery = sessionInjectorDeliveryMode(sessionInjector);
  return delivery === "important" ||
    delivery === "all" ||
    delivery === EVENT_OUTCOME.SURFACE ||
    delivery === EVENT_OUTCOME.INJECT;
}

function canSurfaceWithSessionInjector(sessionInjector, outcome) {
  if (sessionInjector?.enabled !== true) {
    return false;
  }

  const delivery = sessionInjectorDeliveryMode(sessionInjector);
  if (delivery === "all") {
    return outcome === EVENT_OUTCOME.KEEP ||
      outcome === EVENT_OUTCOME.SURFACE ||
      outcome === EVENT_OUTCOME.INJECT;
  }

  return delivery === EVENT_OUTCOME.SURFACE &&
    (outcome === EVENT_OUTCOME.SURFACE || outcome === EVENT_OUTCOME.INJECT);
}

/**
 * Resolve stream delivery actions after an event has been classified.
 *
 * - SESSION_INJECTOR preserves CommandEmitter behavior: EventFilter outcomes
 *   decide whether to store, and stream SessionInjector policy decides whether
 *   to surface or inject.
 * - PROVIDER_AUTHORITATIVE preserves provider push behavior from ADR 0005:
 *   provider-selected levels always store, and `inject` is not gated by the
 *   stream SessionInjector.
 *
 * @param {{
 *   policy?: string,
 *   outcome?: string,
 *   sessionInjector?: Object
 * }} input
 * @returns {{ policy: string, outcome: string, shouldStore: boolean, shouldSurface: boolean, shouldInject: boolean }}
 */
export function decideStreamEventDelivery(input = {}) {
  const policy = input.policy ?? DELIVERY_POLICY.SESSION_INJECTOR;
  const outcome = outcomeToken(input.outcome);

  if (policy === DELIVERY_POLICY.PROVIDER_AUTHORITATIVE) {
    return Object.freeze({
      policy,
      outcome,
      shouldStore: true,
      shouldSurface: outcome === EVENT_OUTCOME.SURFACE || outcome === EVENT_OUTCOME.INJECT,
      shouldInject: outcome === EVENT_OUTCOME.INJECT
    });
  }

  return Object.freeze({
    policy: DELIVERY_POLICY.SESSION_INJECTOR,
    outcome,
    shouldStore: outcome !== EVENT_OUTCOME.DROP,
    shouldSurface: canSurfaceWithSessionInjector(input.sessionInjector, outcome),
    shouldInject: canInjectWithSessionInjector(input.sessionInjector, outcome)
  });
}

export function enqueueDeliveredEvent({ decision, notifications, notification } = {}) {
  if (decision?.shouldInject === true && typeof notifications?.enqueue === "function") {
    notifications.enqueue(notification);
  }
}

export function surfaceDeliveredEvent({
  decision,
  surface,
  notification,
  message,
  formatMessage,
  options = { level: "info" },
  catchErrors = true
} = {}) {
  if (decision?.shouldSurface !== true || typeof surface !== "function") {
    return;
  }

  const renderedMessage = message ?? (
    typeof formatMessage === "function" ? formatMessage(notification) : null
  );
  if (!renderedMessage) {
    return;
  }

  const result = surface(renderedMessage, options);
  if (catchErrors) {
    void Promise.resolve(result).catch(() => {});
  } else {
    void Promise.resolve(result);
  }
}
