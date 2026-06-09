function formatSessionInjectorPolicyFields(sessionInjector, separator = " ") {
  return [
    `delivery=${sessionInjector.delivery}`,
    `lifespan=${sessionInjector.lifespan}`,
    `ownership=${sessionInjector.ownership}`
  ].join(separator);
}

function formatSessionInjector(stream) {
  const sessionInjector = stream.sessionInjector;
  const state = sessionInjector.enabled ? "on" : "off";
  return `sessionInjector=${state} ${formatSessionInjectorPolicyFields(sessionInjector)}`;
}

function formatSessionInjectorDetails(stream) {
  return formatSessionInjectorPolicyFields(stream.sessionInjector, "\n");
}

export function formatSessionInjectorUpdate(action, stream) {
  return [
    `${action} session injector for stream '${stream.name}'.`,
    formatSessionInjectorDetails(stream)
  ].join("\n");
}

export function formatSessionInjectorContextSummary(streamList) {
  const subscribed = streamList.filter((stream) => stream.sessionInjector.enabled);

  if (subscribed.length === 0) {
    return "";
  }

  return [
    "Session injectors:",
    ...subscribed.map((stream) => `- ${stream.name} ${formatSessionInjectorPolicyFields(stream.sessionInjector)}`)
  ].join("\n");
}

export function formatSessionInjectorPolicyLog(stream) {
  const action = stream.sessionInjector.enabled ? "Subscribed" : "Unsubscribed";
  return `${action} stream '${stream.name}' with ${formatSessionInjectorPolicyFields(stream.sessionInjector)}.`;
}

export function formatStream(stream) {
  const latest = stream.entries[stream.entries.length - 1];
  const latestSummary = latest ? ` latest=${JSON.stringify(latest.text.slice(0, 80))}` : "";
  const description = stream.description ? ` description=${JSON.stringify(stream.description)}` : "";
  return `- ${stream.name}: messages=${stream.entries.length}${description} ${formatSessionInjector(stream)}${latestSummary}`;
}

export function formatStreamHistory(stream, limit) {
  const entries = stream.entries.slice(-limit);
  if (entries.length === 0) {
    return `Stream '${stream.name}' is empty.`;
  }

  return [
    `Stream '${stream.name}' (${entries.length} of ${stream.entries.length} entries):`,
    ...entries.map((entry) => {
      const emitterLabel = entry.monitorName ? ` emitter=${entry.monitorName}` : "";
      const streamLabel = entry.stream ? ` stream=${entry.stream}` : "";
      return `[${entry.timestamp}] source=${entry.source}${emitterLabel}${streamLabel} ${entry.text}`;
    })
  ].join("\n");
}
