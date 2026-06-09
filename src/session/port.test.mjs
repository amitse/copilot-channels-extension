import test from "node:test";
import assert from "node:assert/strict";

import { LOG_PREFIX } from "../consts.mjs";
import { createSessionPort } from "./port.mjs";

function captureStderr() {
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  return {
    writes,
    restore() {
      process.stderr.write = originalWrite;
    }
  };
}

test("session port replays pre-attach logs after attach", async () => {
  const logs = [];
  const port = createSessionPort();

  await port.log("Surfaced event stream='ops' emitter='watcher': ready", { level: "info" });
  assert.deepEqual(logs, []);

  port.attach({
    async log(message, options) {
      logs.push({ message, options });
    }
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(logs, [
    {
      message: `${LOG_PREFIX} Surfaced event stream='ops' emitter='watcher': ready`,
      options: { ephemeral: true, level: "info" }
    }
  ]);
});

test("session port diagnoses registerTools failures", () => {
  const capture = captureStderr();
  try {
    const port = createSessionPort({
      registerTools() {
        throw new Error("invalid merged tools");
      }
    });

    port.registerTools([]);

    assert.ok(
      capture.writes.some((entry) => entry.includes("[tap] registerTools failed: invalid merged tools"))
    );
  } finally {
    capture.restore();
  }
});

test("session port diagnoses extensions.reload failures", async () => {
  const capture = captureStderr();
  try {
    const port = createSessionPort({
      rpc: {
        extensions: {
          async reload() {
            throw new Error("reload unavailable");
          }
        }
      }
    });

    await port.reloadExtension();

    assert.ok(
      capture.writes.some((entry) => entry.includes("[tap] extensions.reload failed: reload unavailable"))
    );
  } finally {
    capture.restore();
  }
});
