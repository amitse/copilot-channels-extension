import { MAX_TOOLS_PER_PROVIDER } from "./consts.mjs";

export function createProviderRegistry() {
  // Map<providerId, { id, name, tools[], sessionId }>
  const providers = new Map();

  function register(providerId, providerName, tools, sessionId) {
    const toolList = tools || [];
    if (toolList.length > MAX_TOOLS_PER_PROVIDER) {
      throw new Error(
        `Provider '${providerName}' registers ${toolList.length} tools, exceeding limit of ${MAX_TOOLS_PER_PROVIDER}.`
      );
    }
    const entry = { id: providerId, name: providerName, tools: toolList, sessionId };
    providers.set(providerId, entry);
    return entry;
  }

  function unregister(providerId) {
    const provider = providers.get(providerId);
    providers.delete(providerId);
    return provider || null;
  }

  function getProviderTools() {
    const allTools = [];
    for (const provider of providers.values()) {
      for (const tool of provider.tools) {
        allTools.push({ ...tool, providerId: provider.id, providerName: provider.name });
      }
    }
    return allTools;
  }

  function buildSessionTools(tapTools, dispatchToolCall) {
    const providerTools = getProviderTools();
    const wrapped = providerTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: "object", properties: {} },
      handler: async (args, context) => {
        const callId = context?.callId || `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await dispatchToolCall(tool.providerId, tool.name, callId, args);
        if (result.error) {
          throw new Error(`[${result.errorCode ?? "INTERNAL"}] ${result.error}`);
        }
        return result.data;
      }
    }));

    return [...tapTools, ...wrapped];
  }

  function hasToolConflict(newTools, existingToolNames) {
    const conflicts = [];
    for (const tool of newTools) {
      if (existingToolNames.has(tool.name)) {
        conflicts.push(tool.name);
      }
    }
    return conflicts;
  }

  function getProvider(providerId) {
    return providers.get(providerId) || null;
  }

  function findProviderByToolName(toolName) {
    for (const provider of providers.values()) {
      if (provider.tools.some(t => t.name === toolName)) {
        return provider;
      }
    }
    return null;
  }

  function listProviders() {
    return [...providers.values()];
  }

  function size() {
    return providers.size;
  }

  function getAllToolNames() {
    const names = new Set();
    for (const provider of providers.values()) {
      for (const tool of provider.tools) {
        names.add(tool.name);
      }
    }
    return names;
  }

  return {
    register,
    unregister,
    getProviderTools,
    buildSessionTools,
    hasToolConflict,
    getProvider,
    findProviderByToolName,
    listProviders,
    size,
    getAllToolNames
  };
}
