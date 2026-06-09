import { EVENT_OUTCOME, SOURCE, STREAM } from "../consts.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import {
  DELIVERY_POLICY,
  decideStreamEventDelivery,
  enqueueDeliveredEvent,
  surfaceDeliveredEvent
} from "../streams/delivery-policy.mjs";
import { splitTextLines } from "../util/text.mjs";

/**
 * @typedef {Object} LineRouterDeps
 * @property {Object} streams - Event stream manager
 * @property {Object} notifications - Notification queue for event injection
 * @property {Function} [surface] - Optional non-inject surfacing callback
 */

/**
 * Create line router with capability-specific injection.
 * Only receives capabilities needed: streams (for append), notifications
 * (for injection), and optional surface logging.
 * sessionPort is NOT needed here.
 * @param {{ streams: Object, notifications: Object, surface?: Function }} deps
 */
export function createLineRouter({ streams, notifications, surface = null }) {
  function getSessionInjector(emitter) {
    return streams.ensure(emitter.stream).sessionInjector ?? {};
  }

  function decideEmitterDelivery(outcome, sessionInjector = null) {
    return decideStreamEventDelivery({
      policy: DELIVERY_POLICY.SESSION_INJECTOR,
      outcome,
      sessionInjector
    });
  }

  function formatSurfaceMessage(notification) {
    const streamLabel = notification.stream ? `/${notification.stream}` : "";
    return `Surfaced event stream='${notification.channel}' emitter='${notification.monitorName}'${streamLabel}: ${notification.text}`;
  }

  function surfaceEvent(decision, notification) {
    surfaceDeliveredEvent({
      decision,
      surface,
      notification,
      formatMessage: formatSurfaceMessage
    });
  }

  function enqueueEvent(decision, notification) {
    enqueueDeliveredEvent({ decision, notifications, notification });
  }

  function appendSystemMessage(emitter, text, notify = false) {
    streams.append(emitter.stream, {
      source: SOURCE.SYSTEM,
      text,
      monitorName: emitter.name
    });

    if (notify) {
      const decision = decideEmitterDelivery(EVENT_OUTCOME.INJECT, getSessionInjector(emitter));
      enqueueEvent(decision, {
        channel: emitter.stream,
        monitorName: emitter.name,
        stream: STREAM.SYSTEM,
        text
      });
    }
  }

  function handleLine(emitter, rawText, stream, source) {
    const text = String(rawText ?? "").trim();
    if (!text) {
      return;
    }

    const outcome = EventFilterService.evaluate(emitter.eventFilter, text);
    const storageDecision = decideEmitterDelivery(outcome);

    if (!storageDecision.shouldStore) {
      emitter.droppedLineCount += 1;
      return;
    }

    const sessionInjector = getSessionInjector(emitter);
    const deliveryDecision = decideEmitterDelivery(outcome, sessionInjector);
    emitter.lineCount += 1;
    streams.append(emitter.stream, {
      source,
      text,
      monitorName: emitter.name,
      stream
    });

    const notification = {
      channel: emitter.stream,
      monitorName: emitter.name,
      stream,
      text
    };

    enqueueEvent(deliveryDecision, notification);
    surfaceEvent(deliveryDecision, notification);
  }

  function handleTextBlock(emitter, value, stream, source) {
    for (const line of splitTextLines(value)) {
      handleLine(emitter, line, stream, source);
    }
  }

  function handlePromptResult(emitter, value) {
    for (const line of splitTextLines(value)) {
      const text = String(line ?? "").trim();
      if (!text) {
        continue;
      }

      emitter.lineCount += 1;
      streams.append(emitter.stream, {
        source: SOURCE.EMITTER_PROMPT,
        text,
        monitorName: emitter.name,
        stream: STREAM.PROMPT
      });
    }
  }

  return { handleLine, handleTextBlock, handlePromptResult, appendSystemMessage };
}
