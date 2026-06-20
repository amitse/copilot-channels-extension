import { createHash } from "node:crypto";
import { connectProvider, push } from "./provider-utils.mjs";

function fingerprint(finding) {
  return createHash("sha256")
    .update([finding.cwe, finding.sink, finding.file, finding.line].filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 16);
}

const tools = [
  {
    name: "sast_emit_findings",
    description: "Normalize SAST findings into stable, fingerprinted tap events.",
    parameters: {
      type: "object",
      properties: {
        findings: { type: "array" }
      },
      required: ["findings"]
    }
  }
];

connectProvider({
  name: "sast-triage-template",
  tools,
  onMessage(ws, msg) {
    if (msg.type !== "tool.call" || msg.tool !== "sast_emit_findings") {
      return;
    }
    for (const finding of msg.arguments?.findings ?? []) {
      const severity = String(finding.severity ?? "medium").toLowerCase();
      push(ws, {
        stream: "sast-triage",
        level: /critical|high/.test(severity) ? "inject" : "surface",
        event: {
          type: "sast.finding",
          fingerprint: fingerprint(finding),
          severity,
          cwe: finding.cwe,
          file: finding.file,
          line: finding.line,
          sink: finding.sink,
          exploitability: finding.exploitability ?? null
        }
      });
    }
    ws.send(JSON.stringify({ type: "tool.result", callId: msg.callId, result: { ok: true } }));
  }
});
