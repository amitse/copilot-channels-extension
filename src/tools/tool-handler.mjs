import { normalizeToolError } from "../errors/handler.mjs";

function resolveContext(contextFactory, args) {
  const context = typeof contextFactory === "function"
    ? contextFactory(args)
    : contextFactory;

  return context && typeof context === "object" && !Array.isArray(context)
    ? context
    : {};
}

/**
 * Wrap a Copilot SDK tool handler with consistent tool error normalization.
 * @param {string} toolName
 * @param {Object|Function} contextFactory Static context or a function of handler args.
 * @param {Function} handler Tool handler implementation.
 */
export function wrapToolHandler(toolName, contextFactory, handler) {
  return async (args = {}) => {
    const toolArgs = args ?? {};

    try {
      return await handler(toolArgs);
    } catch (error) {
      throw normalizeToolError(error, {
        context: {
          tool: toolName,
          ...resolveContext(contextFactory, toolArgs)
        }
      });
    }
  };
}
