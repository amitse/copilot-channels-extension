import { BRAND, NOTIFICATION_BATCH_SIZE } from "../consts.mjs";

const SESSION_ATTACH_RETRY_MS = 250;
const DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE = 100;

function createDefaultTimerAdapter() {
  return {
    schedule(callback, delayMs = 0) {
      return setTimeout(callback, Math.max(0, delayMs));
    },
    cancel(handle) {
      clearTimeout(handle);
    }
  };
}

function isSessionNotAttachedMessage(message) {
  return /session is not attached|session[^.]*not attached/i.test(String(message ?? ""));
}

function pluralizeUpdate(count) {
  return count === 1 ? "monitor update" : "monitor updates";
}

function normalizeMaxQueueSize(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE;
  }
  return Math.max(0, Math.floor(value));
}

function safeLog(sessionPort, message, options = {}) {
  try {
    void Promise.resolve(sessionPort?.log?.(message, options)).catch(() => {});
  } catch {
    // Notification observability must never interrupt emitter delivery.
  }
}

function buildNotificationPrompt(batch) {
  return [
    `${BRAND} — background event stream update:`,
    ...batch.map((item) => {
      const streamLabel = item.stream ? `/${item.stream}` : "";
      return `- stream=${item.channel} emitter=${item.monitorName}${streamLabel}: ${item.text}`;
    }),
    "Only react if the update matters to the current task."
  ].join("\n");
}

export function createNotificationDispatcher({
  sessionPort,
  retryDelayMs = SESSION_ATTACH_RETRY_MS,
  maxQueueSize = DEFAULT_MAX_NOTIFICATION_QUEUE_SIZE,
  timerAdapter = createDefaultTimerAdapter()
}) {
  const queueLimit = normalizeMaxQueueSize(maxQueueSize);
  const queue = [];
  let inFlight = false;
  let retryTimer = null;
  let generation = 0;

  function isSessionAttached() {
    return typeof sessionPort?.isAttached === "function"
      ? sessionPort.isAttached() === true
      : true;
  }

  function isRetryableAttachError(error) {
    return !isSessionAttached() || isSessionNotAttachedMessage(error?.message ?? error);
  }

  function cancelRetry() {
    if (retryTimer !== null) {
      timerAdapter.cancel(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(expectedGeneration = generation) {
    if (retryTimer !== null) {
      return;
    }

    retryTimer = timerAdapter.schedule(() => {
      retryTimer = null;
      if (generation !== expectedGeneration) {
        return;
      }
      void flush();
    }, retryDelayMs);
  }

  function logDropped(count, detail) {
    if (count <= 0) {
      return;
    }
    safeLog(
      sessionPort,
      `Dropped ${count} ${pluralizeUpdate(count)} ${detail}`,
      { level: "warning" }
    );
  }

  function trimOverflowFromTail(detail) {
    const overflow = queue.length - queueLimit;
    if (overflow <= 0) {
      return 0;
    }
    queue.splice(Math.max(0, queue.length - overflow), overflow);
    logDropped(overflow, detail);
    return overflow;
  }

  function requeueBatch(batch) {
    queue.unshift(...batch);
    trimOverflowFromTail(`from the notification retry queue because it exceeded the max size (${queueLimit}).`);
  }

  async function flush() {
    if (inFlight || retryTimer !== null || queue.length === 0) {
      return;
    }

    if (!isSessionAttached()) {
      scheduleRetry(generation);
      return;
    }

    inFlight = true;
    const flushGeneration = generation;
    const batch = queue.splice(0, NOTIFICATION_BATCH_SIZE);

    try {
      await sessionPort.send(buildNotificationPrompt(batch));
    } catch (error) {
      if (generation !== flushGeneration) {
        return;
      }
      if (isRetryableAttachError(error)) {
        requeueBatch(batch);
        scheduleRetry(flushGeneration);
      } else {
        safeLog(sessionPort, `Failed to dispatch monitor update: ${error.message}`, { level: "warning" });
      }
    } finally {
      inFlight = false;
      if (queue.length > 0 && retryTimer === null) {
        void flush();
      }
    }
  }

  function enqueue(notification) {
    if (queue.length >= queueLimit) {
      logDropped(1, `because notification retry queue is full (max ${queueLimit}).`);
      return { accepted: false, reason: "queue-full", dropped: 1, queueSize: queue.length };
    }

    queue.push(notification);
    void flush();
    return { accepted: true, queueSize: queue.length };
  }

  function clear(options = {}) {
    const reason = String(options.reason ?? "session lifecycle").trim() || "session lifecycle";
    const cleared = queue.length;
    queue.splice(0);
    if (options.generation !== false) {
      generation += 1;
    }
    cancelRetry();
    if (cleared > 0) {
      safeLog(
        sessionPort,
        `Cleared ${cleared} queued ${pluralizeUpdate(cleared)} during ${reason}.`,
        { level: "info" }
      );
    }
    return { cleared, generation };
  }

  function snapshot(options = {}) {
    const limit = Math.max(0, Math.min(Number(options.limit ?? 20) || 20, queueLimit));
    return {
      queueSize: queue.length,
      maxQueueSize: queueLimit,
      inFlight,
      retryScheduled: retryTimer !== null,
      generation,
      queued: queue.slice(0, limit).map((entry) => ({
        channel: entry.channel,
        monitorName: entry.monitorName,
        stream: entry.stream,
        text: String(entry.text ?? "").slice(0, 500)
      }))
    };
  }

  return { enqueue, clear, dispose: clear, snapshot };
}
