import { connectProvider, push } from "./provider-utils.mjs";

const tools = [
  {
    name: "ci_review_normalize_findings",
    description: "Normalize structured code review findings into tap provider events.",
    parameters: {
      type: "object",
      properties: {
        findings: { type: "array" },
        runUrl: { type: "string" },
        repository: { type: "string" }
      },
      required: ["findings"]
    }
  }
];

connectProvider({
  name: "ci-review-template",
  tools,
  onMessage(ws, msg) {
    if (msg.type !== "tool.call" || msg.tool !== "ci_review_normalize_findings") {
      return;
    }
    const args = msg.arguments ?? {};
    for (const finding of args.findings ?? []) {
      const priority = Number(finding.priority ?? 3);
      push(ws, {
        stream: "ci-review",
        level: priority <= 1 ? "inject" : "surface",
        event: {
          type: "review.finding",
          title: finding.title,
          priority,
          confidence: finding.confidence_score,
          file: finding.code_location?.absolute_file_path,
          line: finding.code_location?.line_range?.start,
          runUrl: args.runUrl,
          repository: args.repository
        }
      });
    }
    ws.send(JSON.stringify({ type: "tool.result", callId: msg.callId, result: { ok: true } }));
  }
});
