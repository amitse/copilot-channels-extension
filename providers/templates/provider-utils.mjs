import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

export function discoverTapToken() {
  if (process.env.TAP_PROVIDER_TOKEN) {
    return process.env.TAP_PROVIDER_TOKEN;
  }
  const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
  return fs.readFileSync(path.join(copilotHome, "extensions", "tap", ".provider-token"), "utf8").trim();
}

export function connectProvider({ name, tools, session = "all", onMessage }) {
  const token = discoverTapToken();
  const ws = new WebSocket(process.env.TAP_PROVIDER_URL || "ws://127.0.0.1:9400");
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "auth", token }));
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "sessions") {
      ws.send(JSON.stringify({
        type: "hello",
        name,
        protocolVersion: 2,
        session,
        tools
      }));
      return;
    }
    onMessage?.(ws, msg);
  });
  return ws;
}

export function push(ws, { stream, level = "surface", event, metadata = {} }) {
  ws.send(JSON.stringify({
    type: "push",
    level,
    stream,
    event: typeof event === "string" ? event : JSON.stringify(event),
    metadata
  }));
}
