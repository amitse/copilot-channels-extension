import fs from "node:fs";
import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function safeRegex(pattern) {
  try {
    return new RegExp(String(pattern));
  } catch {
    return null;
  }
}

function resolveWithinBase(baseCwd, requestedPath) {
  const raw = normalizeText(requestedPath);
  if (!raw) {
    return { ok: false, error: "path is required" };
  }
  const base = path.resolve(baseCwd || process.cwd());
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: `path '${raw}' is outside the session workspace` };
  }
  return { ok: true, path: resolved, displayPath: relative || "." };
}

function textMatches(text, check = {}) {
  const contains = normalizeText(check.contains);
  if (contains && !String(text).includes(contains)) {
    return { ok: false, error: `expected text to contain '${contains}'` };
  }
  const pattern = normalizeText(check.pattern);
  if (pattern) {
    const regex = safeRegex(pattern);
    if (!regex) {
      return { ok: false, error: `invalid regex '${pattern}'` };
    }
    if (!regex.test(String(text))) {
      return { ok: false, error: `expected text to match /${pattern}/` };
    }
  }
  return { ok: true };
}

function verifyFile(check, { baseCwd }) {
  const resolved = resolveWithinBase(baseCwd, check.path);
  if (!resolved.ok) {
    return { ...resolved, passed: false };
  }
  if (!fs.existsSync(resolved.path)) {
    return { passed: false, path: resolved.displayPath, error: "file does not exist" };
  }
  const stat = fs.statSync(resolved.path);
  if (!stat.isFile()) {
    return { passed: false, path: resolved.displayPath, error: "path is not a file" };
  }
  if (check.nonEmpty === true && stat.size === 0) {
    return { passed: false, path: resolved.displayPath, error: "file is empty" };
  }
  if (check.contains || check.pattern) {
    const content = fs.readFileSync(resolved.path, "utf8");
    const match = textMatches(content, check);
    if (!match.ok) {
      return { passed: false, path: resolved.displayPath, error: match.error };
    }
  }
  return { passed: true, path: resolved.displayPath, size: stat.size };
}

function verifyStream(check, { getStreamHistory }) {
  const channel = normalizeText(check.channel);
  if (!channel) {
    return { passed: false, error: "channel is required" };
  }
  let stream;
  try {
    stream = getStreamHistory(channel, check.limit)?.stream;
  } catch (error) {
    return { passed: false, channel, error: error?.message ?? String(error) };
  }
  const entries = Array.isArray(stream?.entries) ? stream.entries : [];
  if (check.minEntries !== undefined && entries.length < Number(check.minEntries)) {
    return { passed: false, channel, entries: entries.length, error: `expected at least ${check.minEntries} entries` };
  }
  const text = entries.map((entry) => entry.text ?? "").join("\n");
  const match = textMatches(text, check);
  if (!match.ok) {
    return { passed: false, channel, entries: entries.length, error: match.error };
  }
  return { passed: true, channel, entries: entries.length };
}

function verifyCommandEvidence(check) {
  const label = normalizeText(check.label ?? check.command ?? "command evidence");
  if (check.exitCode === undefined && check.success !== true) {
    return { passed: false, label, error: "provide exitCode or success=true from an already-run command" };
  }
  const passed = check.success === true || Number(check.exitCode) === 0;
  return {
    passed,
    label,
    exitCode: check.exitCode ?? null,
    error: passed ? null : `command evidence did not indicate success`
  };
}

function verifyCheck(check = {}, context) {
  const type = normalizeText(check.type || check.kind);
  if (type === "file" || type === "file_exists") {
    return verifyFile(check, context);
  }
  if (type === "stream" || type === "stream_contains" || type === "channel") {
    return verifyStream(check, context);
  }
  if (type === "command" || type === "command_evidence") {
    return verifyCommandEvidence(check);
  }
  return { passed: false, error: `unsupported check type '${type || "<missing>"}'` };
}

export function createGoalVerificationService({ getBaseCwd, getStreamHistory } = {}) {
  function context() {
    return {
      baseCwd: typeof getBaseCwd === "function" ? getBaseCwd() : process.cwd(),
      getStreamHistory
    };
  }

  function verifyGoalOutput(input = {}) {
    const checks = Array.isArray(input.checks) ? input.checks : [];
    const results = checks.map((check, index) => ({
      index,
      description: check.description ?? check.claim ?? null,
      type: check.type ?? check.kind ?? null,
      ...verifyCheck(check, context())
    }));
    return {
      passed: results.length > 0 && results.every((result) => result.passed === true),
      results
    };
  }

  function auditClaims(input = {}) {
    const claims = Array.isArray(input.claims) ? input.claims : [];
    const results = claims.map((claim, index) => {
      const evidence = claim.evidence && typeof claim.evidence === "object"
        ? claim.evidence
        : {};
      const verification = verifyCheck({
        ...evidence,
        description: evidence.description ?? claim.claim,
        claim: claim.claim
      }, context());
      return {
        index,
        claim: claim.claim ?? null,
        status: verification.passed ? "confirmed" : "blocked",
        ...verification
      };
    });
    return {
      passed: results.length > 0 && results.every((result) => result.passed === true),
      results
    };
  }

  return { verifyGoalOutput, auditClaims };
}
