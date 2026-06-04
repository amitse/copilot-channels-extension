import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { resolveRequestedCwd } from "./path.mjs";

test("resolveRequestedCwd resolves relative requests from process cwd when base cwd is undefined", () => {
  assert.equal(resolveRequestedCwd(undefined, "subdir"), path.resolve(process.cwd(), "subdir"));
});

test("resolveRequestedCwd keeps absolute requested cwd absolute", () => {
  const baseCwd = path.resolve(process.cwd(), "base");
  const requestedCwd = path.resolve(path.parse(process.cwd()).root, "absolute-workspace");

  assert.equal(resolveRequestedCwd(baseCwd, requestedCwd), requestedCwd);
});
