export function createHooks({ runtime }) {
  const hooks = runtime?.hooks ?? runtime;

  return {
    onSessionStart: (input) => hooks.onSessionStart(input),

    onUserPromptSubmitted: () => hooks.onUserPromptSubmitted(),

    onSessionEnd: () => hooks.onSessionEnd()
  };
}
