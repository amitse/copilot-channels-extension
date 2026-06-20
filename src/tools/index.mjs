import { createStreamTools } from "./channels.mjs";
import { createEmitterTools } from "./monitors.mjs";
import { createDiagnosticsTools } from "./diagnostics.mjs";

export function createTools(deps) {
  const source = deps?.tools ?? deps?.runtime?.tools ?? {};
  const streams = deps?.streams ?? source.streams ?? deps?.runtime;
  const emitters = deps?.emitters ?? source.emitters ?? deps?.runtime;
  const diagnostics = deps?.diagnostics ?? source.diagnostics ?? deps?.runtime;

  return [
    ...createStreamTools({ streams }),
    ...createEmitterTools({ emitters }),
    ...createDiagnosticsTools({ diagnostics })
  ];
}
