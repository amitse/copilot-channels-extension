import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ValidationError } from "../errors/index.mjs";
import { createRuntimeSessionContext } from "../session/runtime-context.mjs";
import { resolveRequestedCwd } from "./path.mjs";

test("resolveRequestedCwd allows the session cwd itself", () => {
  const baseCwd = path.resolve(process.cwd(), "workspace-root");

  assert.equal(resolveRequestedCwd(baseCwd, "."), baseCwd);
});

test("resolveRequestedCwd allows subdirectories under the session cwd", () => {
  const baseCwd = path.resolve(process.cwd(), "workspace-root");

  assert.equal(resolveRequestedCwd(baseCwd, "services/worker"), path.join(baseCwd, "services", "worker"));
});

test("resolveRequestedCwd rejects absolute requested cwd", () => {
  const baseCwd = path.resolve(process.cwd(), "base");
  const requestedCwd = path.resolve(path.parse(baseCwd).root, "absolute-workspace");

  assert.throws(
    () => resolveRequestedCwd(baseCwd, requestedCwd),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /absolute paths are not allowed/);
      return true;
    }
  );
});

test("resolveRequestedCwd rejects traversal that escapes the session cwd", () => {
  const baseCwd = path.resolve(process.cwd(), "workspace-root");

  assert.throws(
    () => resolveRequestedCwd(baseCwd, ".."),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /stay within the session cwd/);
      return true;
    }
  );
});

test("runtime session context resolves emitter workspace cwd through the session boundary", () => {
  const baseCwd = path.resolve(process.cwd(), "workspace-root");
  const context = createRuntimeSessionContext({ cwd: baseCwd });

  assert.equal(context.emitterWorkspace.createEmitterWorkspace().baseCwd, baseCwd);
  assert.equal(context.emitterWorkspace.createEmitterWorkspace({ baseCwd: null }).baseCwd, baseCwd);
  assert.equal(context.emitterWorkspace.createEmitterWorkspace({ baseCwd: "" }).baseCwd, process.cwd());
  assert.equal(
    context.emitterWorkspace.createEmitterWorkspace().resolveEmitterCwd("services/worker"),
    path.join(baseCwd, "services", "worker")
  );
});

test("runtime session context commits config cwd explicitly", () => {
  const initialCwd = path.resolve(process.cwd(), "initial-workspace");
  const nextCwd = path.resolve(process.cwd(), "next-workspace");
  const context = createRuntimeSessionContext({ cwd: initialCwd });

  const resolvedCwd = context.configWorkspace.resolveBaseCwd(nextCwd);

  assert.equal(context.getBaseCwd(), initialCwd);
  assert.equal(context.configWorkspace.commitConfigCwd(resolvedCwd), nextCwd);
  assert.equal(context.getBaseCwd(), nextCwd);
  assert.equal(context.getConfigCwd(), nextCwd);
});
