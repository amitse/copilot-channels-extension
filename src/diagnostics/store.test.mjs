import test from "node:test";
import assert from "node:assert/strict";

import { createDiagnosticsStore } from "./store.mjs";

test("diagnostics store records traces with spans and persistent sink", () => {
  const persisted = [];
  const diagnostics = createDiagnosticsStore({
    recordSink: (collection, record) => persisted.push({ collection, record })
  });

  diagnostics.trace({
    traceId: "t1",
    emitterName: "demo",
    runIndex: 2,
    status: "success",
    ok: true,
    spans: [
      { spanId: "root", kind: "emitter.run", status: "success" }
    ]
  });

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.traces.length, 1);
  assert.equal(snapshot.traces[0].traceId, "t1");
  assert.deepEqual(snapshot.traces[0].spans, [
    { spanId: "root", kind: "emitter.run", status: "success" }
  ]);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].collection, "traces");
  assert.equal(persisted[0].record.traceId, "t1");
});
