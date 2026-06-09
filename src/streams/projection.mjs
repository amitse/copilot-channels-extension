function cloneStreamSessionInjector(stream) {
  return stream?.sessionInjector ? { ...stream.sessionInjector } : null;
}

/**
 * Project a stream state object into the public snapshot shape.
 */
export function projectStream(stream) {
  if (!stream) {
    return null;
  }

  return {
    ...stream,
    entries: Array.isArray(stream.entries) ? stream.entries.map((entry) => ({ ...entry })) : [],
    sessionInjector: cloneStreamSessionInjector(stream)
  };
}
