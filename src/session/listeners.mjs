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
  };

  return {
    attach,
    detach
  };
}
