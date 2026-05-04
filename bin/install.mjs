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

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { scope: "global", force: false, help: false };
  for (const arg of args) {
    switch (arg) {
      case "--global":
      case "-g":
        flags.scope = "global";
        break;
      case "--local":
      case "-l":
        flags.scope = "local";
        break;
      case "--force":
      case "-f":
      case "--full":
        flags.force = true;
        break;
      // Keep legacy flags working
      case "--update":
      case "-u":
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        usage();
        process.exit(1);
    }
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
  let allOk = true;
  let removedAny = false;

  for (const name of deprecated) {
    const oldPath = path.join(targetRoot, "skills", name, "SKILL.md");
    if (!existsSync(oldPath)) {
      continue;
    }
    try {
      unlinkSync(oldPath);
      if (!removedAny) {
        console.log();
        removedAny = true;
      }
      console.log(`  ✓ Removed deprecated skill: skills/${name}/SKILL.md`);
    } catch {
      allOk = false;
      console.warn(`  ⚠  Could not remove deprecated skill at ${oldPath} — remove it manually`);
    }
  }

  if (removedAny) {
    console.log(`\n  Use the new namespaced commands: /tap-loop  /tap-monitor  /tap-create-provider`);
  }

  return allOk;
}

function install(flags) {
  const targetRoot = getTargetRoot(flags.scope);
  const scopeLabel = flags.scope === "global" ? "global (~/.copilot)" : "local (.github)";
  const packageVersion = getPackageVersion();

  if (flags.scope === "global" && !isCopilotCliInstalled()) {
    console.log(`\n⚠  Copilot CLI does not appear to be installed.`);
    console.log(`   Install it first: https://docs.github.com/en/copilot/github-copilot-in-the-cli`);
    console.log(`   Then re-run: npx copilot-tap-extension\n`);
    process.exit(1);
  }

  const installed = isAlreadyInstalled(targetRoot);
  const isUpdate = installed && !flags.force;
  const isReinstall = installed && flags.force;
  const installedVersion = installed ? getInstalledVersion(targetRoot) : null;

  if (isUpdate) {
    if (installedVersion && installedVersion === packageVersion) {
      console.log(`\n${BRAND} — already up to date (v${installedVersion})\n`);
      process.exit(0);
    }
    const fromLabel = installedVersion ? `v${installedVersion}` : "unknown";
    console.log(`\n${BRAND} — updating ${fromLabel} → v${packageVersion} (${scopeLabel})\n`);
  } else if (isReinstall) {
    const fromLabel = installedVersion ? `v${installedVersion}` : "unknown";
    console.log(`\n${BRAND} — reinstalling ${fromLabel} → v${packageVersion} (${scopeLabel})\n`);
  } else {
    console.log(`\n${BRAND} — installing v${packageVersion} (${scopeLabel})\n`);
  }

  const coreArtifacts = [
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

  const ancillaryArtifacts = [
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
      src: path.join(distDir, "copilot-instructions.md"),
      dest: path.join(targetRoot, "copilot-instructions.md"),
      label: "copilot-instructions.md"
    }
  ];

  // During updates, also install ancillary artifacts that don't yet exist at the destination
  // (e.g. new skills added in a newer version). Existing ones are preserved to keep user customizations.
  const newAncillaryArtifacts = isUpdate
    ? ancillaryArtifacts.filter(({ dest }) => !existsSync(dest))
    : ancillaryArtifacts;
  const artifacts = [...coreArtifacts, ...newAncillaryArtifacts];

  let allOk = true;
  for (const { src, dest, label } of artifacts) {
    if (!copyArtifact(src, dest, label)) {
      allOk = false;
    }
  }

  if (installed && !removeDeprecatedSkills(targetRoot)) {
    allOk = false;
  }

  console.log();
  if (allOk) {
    const verb = isUpdate ? "updated" : isReinstall ? "reinstalled" : "installed";
    console.log(`✓ ${BRAND} ${verb} to ${targetRoot}`);
    return;
  }

  const verb = isUpdate ? "updated" : isReinstall ? "reinstalled" : "installed";
  console.error(`⚠  Some artifacts could not be ${verb}.`);
  process.exit(1);
}

const flags = parseArgs(process.argv);

if (flags.help) {
  usage();
  process.exit(0);
}

install(flags);
