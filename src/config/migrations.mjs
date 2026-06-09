import { ValidationError } from "../errors/index.mjs";
import { CONFIG_VERSION, getConfigVersion, normalizePersistedConfig, resolveWarn } from "./normalization.mjs";

export { CONFIG_VERSION } from "./normalization.mjs";

/**
 * Current on-disk schema version.
 *
 * v1: legacy shape where older field aliases may still appear on disk.
 * v2: canonical shape with legacy aliases stripped during migration.
 * v3: reserved for the next major schema change.
 */
export const LATEST_CONFIG_VERSION = CONFIG_VERSION.V2;

/**
 * Final v1 → v2 migration.
 *
 * v2 is the canonical on-disk shape: legacy aliases are removed and any old
 * event-filter/session-injector fields are converted to canonical names before
 * the config is re-saved.
 */
function migrate_v1_to_v2(config, options = {}) {
  return {
    ...normalizePersistedConfig(config, options),
    configVersion: CONFIG_VERSION.V2
  };
}

/**
 * Reserved migration for the next breaking change.
 */
function migrate_v2_to_v3(config, options = {}) {
  return {
    ...normalizePersistedConfig(config, options),
    configVersion: CONFIG_VERSION.V3
  };
}

const MIGRATIONS = new Map([
  [CONFIG_VERSION.V1, migrate_v1_to_v2],
  [CONFIG_VERSION.V2, migrate_v2_to_v3]
]);

export function migrateConfig(config, targetVersion = LATEST_CONFIG_VERSION, options = {}) {
  let current = normalizePersistedConfig(config, options);
  let version = current.configVersion;
  const warn = resolveWarn(options);

  if (version > targetVersion) {
    throw new ValidationError(`Config version ${version} is newer than the supported version ${targetVersion}.`);
  }

  while (version < targetVersion) {
    const step = MIGRATIONS.get(version);
    if (!step) {
      throw new ValidationError(`No migration defined for config version ${version} → ${version + 1}.`);
    }

    current = step(current, options);
    version = getConfigVersion(current.configVersion);
  }

  if (warn && current.configVersion !== version) {
    warn(`Config migration normalized version ${current.configVersion} to ${version}.`);
  }

  return current;
}
