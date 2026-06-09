import { randomUUID } from "node:crypto";

import { AppError } from "../errors/index.mjs";
import { normalizeToolError } from "../errors/handler.mjs";

function generateCallId() {
  return `call-${randomUUID()}`;
}

export function wrapProviderTool(tool, dispatchToolCall) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters || { type: "object", properties: {} },
    handler: async (args, context) => {
      const callId = context?.callId || generateCallId();
      const normalizedArgs = args ?? {};
      try {
        const result = await dispatchToolCall(tool.providerId, tool.name, callId, normalizedArgs);
        if (result.error) {
          throw new AppError(result.error, {
            code: result.errorCode ?? "INTERNAL",
            context: { providerId: tool.providerId, providerName: tool.providerName, toolName: tool.name, callId }
          });
        }
        return result.data;
      } catch (error) {
        throw normalizeToolError(error, {
          context: { providerId: tool.providerId, providerName: tool.providerName, toolName: tool.name, callId }
        });
      }
    }
  };
}

export function buildProviderSessionTools(tapTools, providerTools, dispatchToolCall) {
  const wrapped = providerTools.map(tool => wrapProviderTool(tool, dispatchToolCall));
  return [...tapTools, ...wrapped];
}
