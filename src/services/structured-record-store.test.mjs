import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStructuredRecordStore } from "./structured-record-store.mjs";

test("structured record store writes and lists session workspace records", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "tap-session-"));
  const store = createStructuredRecordStore({
    sessionPort: {
      current: () => ({ workspacePath })
    },
    maxRecords: 2
  });

  assert.equal(store.appendRecord("traces", { id: "one" }).stored, true);
  assert.equal(store.appendRecord("traces", { id: "two" }).stored, true);
  assert.equal(store.appendRecord("traces", { id: "three" }).stored, true);

  const listed = store.listRecords("traces", { limit: 10 });
  assert.equal(listed.available, true);
  assert.deepEqual(listed.records.map((record) => record.id), ["two", "three"]);
  assert.ok(listed.path.startsWith(path.join(workspacePath, "files", "tap-records")));
});

test("structured record store is a no-op without a session workspace", () => {
  const store = createStructuredRecordStore({
    sessionPort: {
      current: () => ({})
    }
  });

  assert.deepEqual(store.appendRecord("traces", { id: "one" }), {
    stored: false,
    reason: "no-session-workspace"
  });
  assert.equal(store.listRecords("traces").available, false);
});
