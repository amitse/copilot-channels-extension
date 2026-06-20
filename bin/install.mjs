#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const distDir = path.join(pkgRoot, "dist");

const BRAND = "※ tap";
const EXT_DIR_NAME = "tap";

function getPackageVersion() {
  try {
    return JSON.parse(readFileSync(path.join(distDir, "version.json"), "utf8")).version;
  } catch {
    return JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version;
  }
}

function usage() {
  console.log(`
${BRAND} — Copilot CLI extension installer

Usage:
  npx copilot-tap-extension [options]

If ※ tap is already installed, updates core files (extension + version)
and preserves customizable artifacts. If fresh, does a full install.

Options:
  --global, -g     Install to ~/.copilot/  (default)
  --local,  -l     Install to .github/  (project-scoped)
  --force, -f      Force a full reinstall even if already installed
  --help,  -h      Show this help message

Installs:
  extensions/tap/extension.mjs    The bundled ※ tap extension
  extensions/tap/version.json     Installed version metadata
  skills/tap-loop/SKILL.md            The /tap-loop skill for prompt-based loops
  skills/tap-create-provider/SKILL.md The /tap-create-provider skill for scaffolding providers
  skills/tap-monitor/SKILL.md         The /tap-monitor skill for self-tuning command monitors
  skills/tap-goal/SKILL.md            The /tap-goal skill for autonomous goal loops
  copilot-instructions.md         Agent instructions for using ※ tap
`);
}

const OPTION_ACTIONS = new Map([
  ["--global", (flags) => { flags.scope = "global"; }],
  ["-g", (flags) => { flags.scope = "global"; }],
  ["--local", (flags) => { flags.scope = "local"; }],
  ["-l", (flags) => { flags.scope = "local"; }],
  ["--force", (flags) => { flags.force = true; }],
  ["-f", (flags) => { flags.force = true; }],
  ["--full", (flags) => { flags.force = true; }],
  // Keep legacy flags working as no-ops.
  ["--update", () => {}],
  ["-u", () => {}],
  ["--help", (flags) => { flags.help = true; }],
  ["-h", (flags) => { flags.help = true; }]
]);

function applyOption(flags, arg) {
  const action = OPTION_ACTIONS.get(arg);
  if (action) {
    action(flags);
    return;
  }

  console.error(`Unknown option: ${arg}`);
  usage();
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { scope: "global", force: false, help: false };
  for (const arg of args) {
    applyOption(flags, arg);
  }
  return flags;
}

function getCopilotHome() {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

function getTargetRoot(scope) {
  if (scope === "global") {
    return getCopilotHome();
  }
  return path.join(process.cwd(), ".github");
}

function copyArtifact(src, dest, label) {
  if (!existsSync(src)) {
    console.error(`  ✗ ${label}: source not found (${src})`);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`  ✓ ${label}`);
  return true;
}

function getInstalledVersion(targetRoot) {
  try {
    const versionFile = path.join(targetRoot, "extensions", EXT_DIR_NAME, "version.json");
    return JSON.parse(readFileSync(versionFile, "utf8")).version;
  } catch {
    return null;
  }
}

function isAlreadyInstalled(targetRoot) {
  return existsSync(path.join(targetRoot, "extensions", EXT_DIR_NAME, "extension.mjs"));
}

function isCopilotCliInstalled() {
  if (existsSync(getCopilotHome())) {
    return true;
  }
  try {
    execFileSync("copilot", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function removeDeprecatedSkills(targetRoot) {
  const deprecated = ["loop", "monitor", "create-provider"];
  const state = { allOk: true, removedAny: false };

  for (const name of deprecated) {
    applyDeprecatedSkillRemoval(targetRoot, name, state);
  }

  if (state.removedAny) {
    console.log(`\n  Use the new namespaced commands: /tap-loop  /tap-monitor  /tap-create-provider`);
  }

  return state.allOk;
}

function applyDeprecatedSkillRemoval(targetRoot, name, state) {
  const result = removeDeprecatedSkill(targetRoot, name);
  if (result.removed) {
    logDeprecatedSkillRemoved(name, state);
  }
  if (!result.ok) {
    state.allOk = false;
  }
}

function logDeprecatedSkillRemoved(name, state) {
  if (!state.removedAny) {
    console.log();
    state.removedAny = true;
  }
  console.log(`  ✓ Removed deprecated skill: skills/${name}/SKILL.md`);
}

function removeDeprecatedSkill(targetRoot, name) {
  const oldPath = path.join(targetRoot, "skills", name, "SKILL.md");
  if (!existsSync(oldPath)) {
    return { ok: true, removed: false };
  }

  try {
    unlinkSync(oldPath);
    return { ok: true, removed: true };
  } catch {
    console.warn(`  ⚠  Could not remove deprecated skill at ${oldPath} — remove it manually`);
    return { ok: false, removed: false };
  }
}

function getScopeLabel(scope) {
  return scope === "global" ? "global (~/.copilot)" : "local (.github)";
}

function ensureGlobalInstallSupported(scope) {
  if (scope !== "global" || isCopilotCliInstalled()) {
    return;
  }

  console.log(`\n⚠  Copilot CLI does not appear to be installed.`);
  console.log(`   Install it first: https://docs.github.com/en/copilot/github-copilot-in-the-cli`);
  console.log(`   Then re-run: npx copilot-tap-extension\n`);
  process.exit(1);
}

function getInstallState(targetRoot, flags) {
  const installed = isAlreadyInstalled(targetRoot);
  const isUpdate = installed && !flags.force;
  const isReinstall = installed && flags.force;
  const installedVersion = installed ? getInstalledVersion(targetRoot) : null;

  return { installed, isUpdate, isReinstall, installedVersion };
}

function exitIfAlreadyCurrent(state, packageVersion) {
  if (!state.isUpdate || !state.installedVersion || state.installedVersion !== packageVersion) {
    return;
  }

  console.log(`\n${BRAND} — already up to date (v${state.installedVersion})\n`);
  process.exit(0);
}

function getVersionLabel(version) {
  return version ? `v${version}` : "unknown";
}

function announceInstall(state, packageVersion, scopeLabel) {
  if (state.isUpdate) {
    const fromLabel = getVersionLabel(state.installedVersion);
    console.log(`\n${BRAND} — updating ${fromLabel} → v${packageVersion} (${scopeLabel})\n`);
    return;
  }

  if (state.isReinstall) {
    const fromLabel = getVersionLabel(state.installedVersion);
    console.log(`\n${BRAND} — reinstalling ${fromLabel} → v${packageVersion} (${scopeLabel})\n`);
    return;
  }

  console.log(`\n${BRAND} — installing v${packageVersion} (${scopeLabel})\n`);
}

function buildCoreArtifacts(targetRoot) {
  return [
    {
      src: path.join(distDir, "extension.mjs"),
      dest: path.join(targetRoot, "extensions", EXT_DIR_NAME, "extension.mjs"),
      label: "extensions/tap/extension.mjs"
    },
    {
      src: path.join(distDir, "version.json"),
      dest: path.join(targetRoot, "extensions", EXT_DIR_NAME, "version.json"),
      label: "extensions/tap/version.json"
    }
  ];
}

function buildAncillaryArtifacts(targetRoot) {
  return [
    {
      src: path.join(distDir, "skills", "tap-loop", "SKILL.md"),
      dest: path.join(targetRoot, "skills", "tap-loop", "SKILL.md"),
      label: "skills/tap-loop/SKILL.md"
    },
    {
      src: path.join(distDir, "skills", "tap-create-provider", "SKILL.md"),
      dest: path.join(targetRoot, "skills", "tap-create-provider", "SKILL.md"),
      label: "skills/tap-create-provider/SKILL.md"
    },
    {
      src: path.join(distDir, "skills", "tap-monitor", "SKILL.md"),
      dest: path.join(targetRoot, "skills", "tap-monitor", "SKILL.md"),
      label: "skills/tap-monitor/SKILL.md"
    },
    {
      src: path.join(distDir, "skills", "tap-goal", "SKILL.md"),
      dest: path.join(targetRoot, "skills", "tap-goal", "SKILL.md"),
      label: "skills/tap-goal/SKILL.md"
    },
    {
      src: path.join(distDir, "skills", "tap-orchestrate", "SKILL.md"),
      dest: path.join(targetRoot, "skills", "tap-orchestrate", "SKILL.md"),
      label: "skills/tap-orchestrate/SKILL.md"
    },
    {
      src: path.join(distDir, "copilot-instructions.md"),
      dest: path.join(targetRoot, "copilot-instructions.md"),
      label: "copilot-instructions.md"
    }
  ];
}

function buildInstallArtifacts(targetRoot, isUpdate) {
  const coreArtifacts = buildCoreArtifacts(targetRoot);
  const ancillaryArtifacts = buildAncillaryArtifacts(targetRoot);
  // During updates, also install ancillary artifacts that don't yet exist at the destination
  // (e.g. new skills added in a newer version). Existing ones are preserved to keep user customizations.
  const newAncillaryArtifacts = isUpdate
    ? ancillaryArtifacts.filter(({ dest }) => !existsSync(dest))
    : ancillaryArtifacts;
  return [...coreArtifacts, ...newAncillaryArtifacts];
}

function copyArtifacts(artifacts) {
  let allOk = true;
  for (const { src, dest, label } of artifacts) {
    if (!copyArtifact(src, dest, label)) {
      allOk = false;
    }
  }
  return allOk;
}

function getInstallVerb(state) {
  if (state.isUpdate) {
    return "updated";
  }
  return state.isReinstall ? "reinstalled" : "installed";
}

function finishInstall(allOk, state, targetRoot) {
  console.log();
  const verb = getInstallVerb(state);
  if (allOk) {
    console.log(`✓ ${BRAND} ${verb} to ${targetRoot}`);
    return;
  }

  console.error(`⚠  Some artifacts could not be ${verb}.`);
  process.exit(1);
}

function install(flags) {
  const targetRoot = getTargetRoot(flags.scope);
  const scopeLabel = getScopeLabel(flags.scope);
  const packageVersion = getPackageVersion();

  ensureGlobalInstallSupported(flags.scope);

  const state = getInstallState(targetRoot, flags);
  exitIfAlreadyCurrent(state, packageVersion);
  announceInstall(state, packageVersion, scopeLabel);

  const artifacts = buildInstallArtifacts(targetRoot, state.isUpdate);
  let allOk = copyArtifacts(artifacts);

  if (state.installed && !removeDeprecatedSkills(targetRoot)) {
    allOk = false;
  }

  finishInstall(allOk, state, targetRoot);
}

const flags = parseArgs(process.argv);

if (flags.help) {
  usage();
  process.exit(0);
}

install(flags);
