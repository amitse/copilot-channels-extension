import path from "node:path";

import { CONFIG_FILENAME } from "../consts.mjs";
import { ValidationError } from "../errors/index.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { isValidBaseCwd } from "../util/path.mjs";
import { EventFilterService } from "../event-filter/service.mjs";
import { stripEmitterRuntimeFields } from "./emitter-schema.mjs";

export function createEmptyConfig(configVersion) {
  return { configVersion, streams: [], emitters: [] };
}

export function serializeStream(stream) {
  const { createdAt, entries, ...persisted } = stream ?? {};
  const entry = { ...persisted };

  if (stream?.name !== undefined) {
    entry.name = stream.name;
  }

  if (stream?.description !== undefined) {
    entry.description = stream.description;
  }

  if (stream?.sessionInjector !== undefined) {
    entry.sessionInjector = {
      ...stream.sessionInjector
    };
  }

  return entry;
}

export function serializeEmitter(emitter) {
  const requestedCwd = emitter?.requestedCwd;
  const persisted = stripEmitterRuntimeFields(emitter);
  const entry = {
    ...persisted,
    name: emitter?.name,
    stream: emitter?.stream ?? emitter?.channel,
    channel: emitter?.channel ?? emitter?.stream,
    autoStart: emitter?.autoStart,
    includeStderr: emitter?.includeStderr,
    ownership: emitter?.ownership
  };

  if (requestedCwd !== undefined) {
    entry.cwd = requestedCwd;
  }
  if (emitter?.cwd !== undefined && entry.cwd === undefined) {
    entry.cwd = emitter.cwd;
  }
  if (emitter?.command) {
    entry.command = emitter.command;
  }
  if (emitter?.prompt) {
    entry.prompt = emitter.prompt;
  }
  if (emitter?.every) {
    entry.every = emitter.every;
  }
  if (emitter?.description !== undefined) {
    entry.description = emitter.description;
  }

  const serializedEventFilter = serializeEventFilter(emitter?.eventFilter);
  if (serializedEventFilter) {
    entry.eventFilter = serializedEventFilter;
  }

  return entry;
}

export function serializeConfig(config, configVersion) {
  return {
    ...config,
    configVersion,
    streams: sortByName(config?.streams ?? []).map((stream) => serializeStream(stream)),
    emitters: sortByName(config?.emitters ?? []).map((emitter) => serializeEmitter(emitter))
  };
}

export function mergeStreamEntries(existing, next) {
  const merged = {
    ...existing,
    ...next
  };

  if (existing?.sessionInjector || next?.sessionInjector) {
    merged.sessionInjector = {
      ...(existing?.sessionInjector ?? {}),
      ...(next?.sessionInjector ?? {})
    };
  }

  return merged;
}

export function mergeEmitterEntries(existing, next) {
  const merged = {
    ...existing,
    ...next
  };

  if (existing?.eventFilter || next?.eventFilter) {
    merged.eventFilter = {
      ...(existing?.eventFilter ?? {}),
      ...(next?.eventFilter ?? {})
    };
  }

  return merged;
}

export function sortByName(entries) {
  return [...entries].sort((left, right) =>
    normalizeName(left?.name).localeCompare(normalizeName(right?.name))
  );
}

function serializeEventFilter(eventFilter) {
  if (!eventFilter) {
    return null;
  }

  return {
    ...eventFilter,
    ...EventFilterService.serialize(eventFilter)
  };
}

export function defaultConfigPath(baseCwd) {
  if (!isValidBaseCwd(baseCwd)) {
    throw new ValidationError("Config base cwd must be a non-empty string.", {
      context: {
        baseCwd,
        type: typeof baseCwd
      }
    });
  }

  return path.join(baseCwd, CONFIG_FILENAME);
}
