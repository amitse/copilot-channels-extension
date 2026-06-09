const SESSION_ACTIVITY_EVENTS = [
  "session.start",
  "session.resume",
  "user.message",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "session.error"
];

export function createSessionActivityBridge({ sessionPort, supervisor }) {
  let cleanupSessionListeners = () => {};

  const detach = () => {
    cleanupSessionListeners();
    cleanupSessionListeners = () => {};
  };

  const notifyInitialIdle = () => {
    sessionPort.setIdle(true);
    supervisor.onSessionIdle();
  };

  const attach = (session) => {
    detach();
    if (!session || typeof session.on !== "function") {
      return;
    }

    const unsubscribers = [
      session.on("session.idle", () => {
        sessionPort.setIdle(true);
        supervisor.onSessionIdle();
      })
    ];

    for (const eventType of SESSION_ACTIVITY_EVENTS) {
      unsubscribers.push(session.on(eventType, () => {
        sessionPort.setIdle(false);
        supervisor.onSessionActivity();
      }));
    }

    cleanupSessionListeners = () => {
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe?.();
        } catch {
          // Listener cleanup must never interrupt session attach.
        }
      }
    };

    // Persistent idle emitters can be auto-started by onSessionStart before
    // this bridge is attached. The SDK does not replay a prior session.idle
    // event to late listeners, so synthesize one initial idle nudge after
    // listeners are installed; later activity events will clear the timer.
    notifyInitialIdle();
  };

  return {
    attach,
    detach
  };
}
