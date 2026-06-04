import { BRAND, EVENT_OUTCOME, SOURCE, STREAM } from "../consts.mjs";
import { EventFilterService } from "../services/event-filter-service.mjs";
import { splitTextLines } from "../util/text.mjs";

/**
 * @typedef {Object} LineRouterDeps
 * @property {Object} streams - Event stream manager
 * @property {Object} notifications - Notification queue for event injection
 */

/**
 * Create line router with capability-specific injection.
 * Only receives capabilities needed: streams (for append) and notifications (for injection).
 * sessionPort is NOT needed here.
 * @param {{ streams: Object, notifications: Object }} deps
 */
export function createLineRouter({ streams, notifications }) {
  function appendSystemMessage(emitter, text, notify = false) {
    streams.append(emitter.stream, {
      source: SOURCE.SYSTEM,
      text,
      monitorName: emitter.name
    });

    if (notify && streams.ensure(emitter.stream).sessionInjector.enabled) {
      notifications.enqueue({
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

    if (outcome === EVENT_OUTCOME.SURFACE) {
      // Note: logging surface-level events is now delegated to lifecycle/supervisor layer
    } else if (outcome === EVENT_OUTCOME.INJECT) {
      notifications.enqueue({
        channel: emitter.stream,
        monitorName: emitter.name,
        stream,
        text
      });
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
