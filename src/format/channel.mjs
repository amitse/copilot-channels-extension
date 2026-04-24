export function formatSubscription(channel) {
  const subscription = channel.subscription;
  const state = subscription.enabled ? "on" : "off";
  return `subscription=${state} delivery=${subscription.delivery} scope=${subscription.scope} managedBy=${subscription.managedBy}`;
}

export function formatChannel(channel) {
  const latest = channel.entries[channel.entries.length - 1];
  const latestSummary = latest ? ` latest=${JSON.stringify(latest.text.slice(0, 80))}` : "";
  const description = channel.description ? ` description=${JSON.stringify(channel.description)}` : "";
  return `- ${channel.name}: messages=${channel.entries.length}${description} ${formatSubscription(channel)}${latestSummary}`;
}

export function formatChannelHistory(channel, limit) {
  const entries = channel.entries.slice(-limit);
  if (entries.length === 0) {
    return `Channel '${channel.name}' is empty.`;
  }

  return [
    `Channel '${channel.name}' (${entries.length} of ${channel.entries.length} entries):`,
    ...entries.map((entry) => {
      const monitorLabel = entry.monitorName ? ` monitor=${entry.monitorName}` : "";
      const streamLabel = entry.stream ? ` stream=${entry.stream}` : "";
      return `[${entry.timestamp}] source=${entry.source}${monitorLabel}${streamLabel} ${entry.text}`;
    })
  ].join("\n");
}
