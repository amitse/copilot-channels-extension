import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const PKG_NAME = "copilot-tap-extension";
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const BRAND = "※ tap";

const UPDATE_STATE_DIR = path.join(os.homedir(), ".copilot");
const UPDATE_STATE_FILE = path.join(UPDATE_STATE_DIR, ".tap-update-state.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 120_000;

function getInstalledVersion() {
  try {
    const extensionDir = path.dirname(fileURLToPath(import.meta.url));
    // In bundled form, import.meta.url points to the extension.mjs directory.
    // In source form, we're in src/update/ — walk up to find version.json beside extension.
    const candidates = [
      path.join(extensionDir, "version.json"),
      path.join(extensionDir, "..", "version.json"),
      path.join(extensionDir, "..", "..", "dist", "version.json")
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, "utf8")).version;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isGlobalInstall() {
  try {
    const extensionDir = path.dirname(fileURLToPath(import.meta.url));
    const globalDir = path.join(os.homedir(), ".copilot");
    return extensionDir.startsWith(globalDir);
  } catch {
    return false;
  }
}

function readUpdateState() {
  try {
    return JSON.parse(readFileSync(UPDATE_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeUpdateState(state) {
  try {
    mkdirSync(UPDATE_STATE_DIR, { recursive: true });
    writeFileSync(UPDATE_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Best-effort — never interrupt the session for state persistence.
  }
}

function shouldCheck() {
  const state = readUpdateState();
  if (!state.lastCheckAt) {
    return true;
  }
  return Date.now() - state.lastCheckAt > CHECK_INTERVAL_MS;
}

function recordCheck(latest) {
  const state = readUpdateState();
  state.lastCheckAt = Date.now();
  if (latest) {
    state.latestVersion = latest;
  }
  writeUpdateState(state);
}

async function fetchLatestVersion() {
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) {
    return null;
  }
  const data = await res.json();
  return data.version ?? null;
}

function isNewer(installed, latest) {
  if (!installed || !latest) {
    return !!latest;
  }
  const pa = installed.split(".").map(Number);
  const pb = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] || 0) > (pa[i] || 0)) {
      return true;
    }
    if ((pb[i] || 0) < (pa[i] || 0)) {
      return false;
    }
  }
  return false;
}

function runUpdate() {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return new Promise((resolve) => {
    execFile(
      npx,
      ["--yes", `${PKG_NAME}@latest`, "--force", "-g", "--update"],
      { timeout: UPDATE_TIMEOUT_MS, windowsHide: true },
      (err) => resolve(!err)
    );
  });
}

export async function checkAndUpdate(sessionPort) {
  try {
    if (!isGlobalInstall()) {
      return;
    }
    if (!shouldCheck()) {
      return;
    }

    const installed = getInstalledVersion();
    const latest = await fetchLatestVersion();

    if (!latest) {
      return;
    }

    recordCheck(latest);

    if (!isNewer(installed, latest)) {
      return;
    }

    const fromLabel = installed ?? "unknown";
    await sessionPort.log(`${BRAND} update available: v${fromLabel} → v${latest}. Updating…`);

    const ok = await runUpdate();
    if (ok) {
      await sessionPort.log(`${BRAND} updated to v${latest}. Changes take effect next session.`);
    } else {
      await sessionPort.log(`${BRAND} auto-update failed. Run \`npx ${PKG_NAME}@latest --force -g\` manually.`, {
        level: "warning"
      });
    }
  } catch {
    // Auto-update must never break session startup.
  }
}
