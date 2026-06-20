import { connectProvider, push } from "./provider-utils.mjs";

const tools = [
  {
    name: "detour_emit_page_event",
    description: "Normalize browser or Detour page events for tap streams.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        eventType: { type: "string" },
        message: { type: "string" },
        severity: { type: "string" }
      },
      required: ["eventType", "message"]
    }
  }
];

connectProvider({
  name: "detour-workflow-template",
  tools,
  onMessage(ws, msg) {
    if (msg.type !== "tool.call" || msg.tool !== "detour_emit_page_event") {
      return;
    }
    const args = msg.arguments ?? {};
    const severity = String(args.severity ?? "info").toLowerCase();
    push(ws, {
      stream: "detour-browser",
      level: /error|fatal|blocked/.test(severity) ? "inject" : "surface",
      event: {
        type: `browser.${args.eventType}`,
        url: args.url ?? null,
        severity,
        message: args.message
      }
    });
    ws.send(JSON.stringify({ type: "tool.result", callId: msg.callId, result: { ok: true } }));
  }
});
