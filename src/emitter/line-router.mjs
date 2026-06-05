import { EVENT_OUTCOME, SOURCE, STREAM } from "../consts.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
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

  function deliveryMode(sessionInjector) {
    return String(sessionInjector?.delivery ?? EVENT_OUTCOME.SURFACE).trim().toLowerCase();
  }

  function canInject(sessionInjector, outcome) {
    if (sessionInjector?.enabled !== true || outcome !== EVENT_OUTCOME.INJECT) {
      return false;
    }

    const delivery = deliveryMode(sessionInjector);
    return delivery === "important" ||
      delivery === "all" ||
      delivery === EVENT_OUTCOME.SURFACE ||
      delivery === EVENT_OUTCOME.INJECT;
  }

  function canSurface(sessionInjector, outcome) {
    if (sessionInjector?.enabled !== true) {
      return false;
    }

    const delivery = deliveryMode(sessionInjector);
    if (delivery === "all") {
      return outcome === EVENT_OUTCOME.KEEP || outcome === EVENT_OUTCOME.SURFACE;
    }

    return delivery === EVENT_OUTCOME.SURFACE && outcome === EVENT_OUTCOME.SURFACE;
  }

  function formatSurfaceMessage(notification) {
    const streamLabel = notification.stream ? `/${notification.stream}` : "";
    return `Surfaced event stream='${notification.channel}' emitter='${notification.monitorName}'${streamLabel}: ${notification.text}`;
  }

  function surfaceEvent(notification, outcome) {
    if (typeof surface !== "function" || !canSurface(getSessionInjector({ stream: notification.channel }), outcome)) {
      return;
    }

    void Promise.resolve(surface(formatSurfaceMessage(notification), { level: "info" })).catch(() => {});
  }

  function enqueueEvent(emitter, notification, outcome) {
    if (canInject(getSessionInjector(emitter), outcome)) {
      notifications.enqueue(notification);
    }
  }

  function appendSystemMessage(emitter, text, notify = false) {
    streams.append(emitter.stream, {
      source: SOURCE.SYSTEM,
      text,
      monitorName: emitter.name
    });

    if (notify) {
      enqueueEvent(emitter, {
        channel: emitter.stream,
        monitorName: emitter.name,
        stream: STREAM.SYSTEM,
        text
      }, EVENT_OUTCOME.INJECT);
    }
  }

  function handleLine(emitter, rawText, stream, source) {
    const text = String(rawText ?? "").trim();
    if (!text) {
      return;
    }

    const outcome = EventFilterService.evaluate(emitter.eventFilter, text);

    if (outcome === EVENT_OUTCOME.DROP) {
      emitter.droppedLineCount += 1;
      return;
    }

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

    if (outcome === EVENT_OUTCOME.INJECT) {
      enqueueEvent(emitter, notification, outcome);
    } else {
      surfaceEvent(notification, outcome);
    }
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
