import { wrapToolHandler } from "./tool-handler.mjs";

function renderCanvasOpenResult(result) {
  return [
    "Opened tap diagnostics canvas.",
    result?.title ? `title=${result.title}` : null,
    result?.status ? `status=${result.status}` : null,
    result?.url ? `url=${result.url}` : null,
    result?.instanceId ? `instanceId=${result.instanceId}` : null,
    result?.availability ? `availability=${result.availability}` : null
  ].filter(Boolean).join("\n");
}

export function createDiagnosticsTools(deps) {
  const diagnostics = deps.diagnostics ?? deps.runtime;
  if (!diagnostics || typeof diagnostics.openCanvas !== "function") {
    return [];
  }

  return [
    {
      name: "tap_open_diagnostics_canvas",
      description: "Opens or focuses the Tap diagnostics canvas, a live flight recorder for streams, emitters, providers, logs, injection queues, and session events.",
      parameters: {
        type: "object",
        properties: {
          instanceId: {
            type: "string",
            description: "Stable canvas instance id. Reusing the same id focuses the existing diagnostics canvas."
          },
          limit: {
            type: "integer",
            minimum: 10,
            maximum: 300,
            description: "Maximum retained rows to show per diagnostics section."
          }
        }
      },
      handler: wrapToolHandler("tap_open_diagnostics_canvas", {}, async (args) => {
        const result = await diagnostics.openCanvas(args ?? {});
        return renderCanvasOpenResult(result);
      })
    }
  ];
}
