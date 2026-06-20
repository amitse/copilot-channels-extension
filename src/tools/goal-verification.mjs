import { wrapToolHandler } from "./tool-handler.mjs";

function renderVerification(prefix, result) {
  const lines = [
    `${prefix}: ${result.passed ? "passed" : "failed"}`,
    ...result.results.map((item) => {
      const label = item.description ?? item.claim ?? item.path ?? item.channel ?? item.label ?? `check ${item.index}`;
      return `- ${item.passed ? "PASS" : "FAIL"} ${label}${item.error ? ` — ${item.error}` : ""}`;
    })
  ];
  return lines.join("\n");
}

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      description: "Check type: 'file', 'stream', or 'command_evidence'."
    },
    description: { type: "string" },
    path: { type: "string", description: "Workspace-relative file path for file checks." },
    nonEmpty: { type: "boolean", description: "For file checks, require a non-empty file." },
    channel: { type: "string", description: "EventStream name for stream checks." },
    limit: { type: "integer", description: "Recent stream entries to inspect." },
    minEntries: { type: "integer", description: "Minimum retained entries required." },
    contains: { type: "string", description: "Literal text that must be present." },
    pattern: { type: "string", description: "Regex pattern that must match." },
    label: { type: "string", description: "Human label for command evidence." },
    exitCode: { type: "integer", description: "Exit code from an already-run command." },
    success: { type: "boolean", description: "Whether already-run command evidence succeeded." }
  }
};

export function createGoalVerificationTools(deps) {
  const verification = deps.verification ?? deps.runtime;
  if (!verification || typeof verification.verifyGoalOutput !== "function") {
    return [];
  }

  return [
    {
      name: "tap_verify_goal_output",
      description: "Verifies goal completion evidence without executing commands. Checks workspace files, EventStream history, or caller-supplied command evidence.",
      parameters: {
        type: "object",
        properties: {
          checks: {
            type: "array",
            items: CHECK_SCHEMA,
            description: "Evidence checks to perform. Command checks must use already-run command evidence; this tool does not execute shell commands."
          }
        },
        required: ["checks"]
      },
      handler: wrapToolHandler("tap_verify_goal_output", {}, async (args) => {
        const result = verification.verifyGoalOutput(args ?? {});
        return renderVerification("Goal output verification", result);
      })
    },
    {
      name: "tap_audit_claims",
      description: "Audits machine-readable goal claims against file, stream, or command-evidence surfaces before marking a goal complete.",
      parameters: {
        type: "object",
        properties: {
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                claim: { type: "string" },
                evidence: CHECK_SCHEMA
              },
              required: ["claim", "evidence"]
            }
          }
        },
        required: ["claims"]
      },
      handler: wrapToolHandler("tap_audit_claims", {}, async (args) => {
        const result = verification.auditClaims(args ?? {});
        return renderVerification("Claim audit", result);
      })
    }
  ];
}
