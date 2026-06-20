import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGoalVerificationService } from "./goal-verification-service.mjs";

test("goal verification checks files and stream history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tap-verify-"));
  fs.writeFileSync(path.join(root, "artifact.txt"), "GOAL COMPLETE\ntrace=abc\n", "utf8");
  const service = createGoalVerificationService({
    getBaseCwd: () => root,
    getStreamHistory: () => ({
      stream: {
        entries: [
          { text: "ITERATION RECORD" },
          { text: "GOAL COMPLETE evidence ok" }
        ]
      }
    })
  });

  const result = service.verifyGoalOutput({
    checks: [
      { type: "file", path: "artifact.txt", contains: "trace=abc", nonEmpty: true },
      { type: "stream", channel: "goal-demo", contains: "GOAL COMPLETE", minEntries: 2 },
      { type: "command_evidence", label: "npm test", exitCode: 0 }
    ]
  });

  assert.equal(result.passed, true);
  assert.equal(result.results.length, 3);
});

test("goal verification rejects paths outside the workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tap-verify-"));
  const service = createGoalVerificationService({
    getBaseCwd: () => root,
    getStreamHistory: () => ({ stream: { entries: [] } })
  });

  const result = service.verifyGoalOutput({
    checks: [{ type: "file", path: "..\\outside.txt" }]
  });

  assert.equal(result.passed, false);
  assert.match(result.results[0].error, /outside the session workspace/);
});

test("claim audit maps failed evidence to blocked status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tap-verify-"));
  const service = createGoalVerificationService({
    getBaseCwd: () => root,
    getStreamHistory: () => ({ stream: { entries: [] } })
  });

  const result = service.auditClaims({
    claims: [
      {
        claim: "artifact exists",
        evidence: { type: "file", path: "missing.txt" }
      }
    ]
  });

  assert.equal(result.passed, false);
  assert.equal(result.results[0].status, "blocked");
});
