import fs from "node:fs";
import path from "node:path";

const DEFAULT_COLLECTION_LIMIT = 500;
const COLLECTION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function safeCollectionName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return COLLECTION_NAME_PATTERN.test(name) ? name : null;
}

function sessionWorkspacePath(sessionPort) {
  const session = typeof sessionPort?.current === "function" ? sessionPort.current() : null;
  return session?.workspacePath ?? null;
}

function recordRoot(sessionPort) {
  const workspace = sessionWorkspacePath(sessionPort);
  if (!workspace) {
    return null;
  }
  return path.join(workspace, "files", "tap-records");
}

function collectionPath(root, collection) {
  return path.join(root, `${collection}.jsonl`);
}

function trimJsonlFile(filePath, maxRecords = DEFAULT_COLLECTION_LIMIT) {
  try {
    const lines = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    if (lines.length <= maxRecords) {
      return;
    }
    fs.writeFileSync(filePath, `${lines.slice(-maxRecords).join("\n")}\n`, "utf8");
  } catch {
    // Structured record retention must never interrupt runtime behavior.
  }
}

export function createStructuredRecordStore({ sessionPort, maxRecords = DEFAULT_COLLECTION_LIMIT } = {}) {
  function appendRecord(collectionInput, record) {
    const collection = safeCollectionName(collectionInput);
    const root = recordRoot(sessionPort);
    if (!collection || !root) {
      return { stored: false, reason: !collection ? "invalid-collection" : "no-session-workspace" };
    }

    try {
      fs.mkdirSync(root, { recursive: true });
      const filePath = collectionPath(root, collection);
      fs.appendFileSync(filePath, `${JSON.stringify({ ...record, storedAt: new Date().toISOString() })}\n`, "utf8");
      trimJsonlFile(filePath, maxRecords);
      return { stored: true, collection, path: filePath };
    } catch (error) {
      return { stored: false, collection, reason: error?.message ?? String(error ?? "unknown error") };
    }
  }

  function listRecords(collectionInput, options = {}) {
    const collection = safeCollectionName(collectionInput);
    const root = recordRoot(sessionPort);
    if (!collection || !root) {
      return { collection: collectionInput, records: [], available: false };
    }

    const limit = Math.max(1, Math.min(500, Math.floor(Number(options.limit ?? 50) || 50)));
    const filePath = collectionPath(root, collection);
    try {
      const records = fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { parseError: true, raw: line };
          }
        });
      return { collection, path: filePath, available: true, records };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { collection, path: filePath, available: true, records: [] };
      }
      return { collection, path: filePath, available: false, records: [], error: error?.message ?? String(error) };
    }
  }

  function getRoot() {
    return recordRoot(sessionPort);
  }

  return {
    appendRecord,
    listRecords,
    getRoot
  };
}
