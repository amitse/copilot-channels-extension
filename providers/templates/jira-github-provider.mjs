import { connectProvider, push } from "./provider-utils.mjs";

const tools = [
  {
    name: "jira_github_emit_issue",
    description: "Emit a normalized Jira issue event for tap goals or orchestration.",
    parameters: {
      type: "object",
      properties: {
        issueKey: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        label: { type: "string" },
        prUrl: { type: "string" }
      },
      required: ["issueKey", "summary"]
    }
  }
];

connectProvider({
  name: "jira-github-template",
  tools,
  onMessage(ws, msg) {
    if (msg.type !== "tool.call" || msg.tool !== "jira_github_emit_issue") {
      return;
    }
    const args = msg.arguments ?? {};
    push(ws, {
      stream: "jira-github",
      level: "inject",
      event: {
        type: "jira.issue.ready",
        issueKey: args.issueKey,
        summary: args.summary,
        label: args.label,
        prUrl: args.prUrl ?? null
      }
    });
    ws.send(JSON.stringify({ type: "tool.result", callId: msg.callId, result: { ok: true } }));
  }
});
