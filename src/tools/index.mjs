import { createStreamTools } from "./channels.mjs";
import { createEmitterTools } from "./monitors.mjs";

export function createTools(deps) {
  const source = deps?.tools ?? deps?.runtime?.tools ?? {};
  const streams = deps?.streams ?? source.streams ?? deps?.runtime;
  const emitters = deps?.emitters ?? source.emitters ?? deps?.runtime;

  return [
    ...createStreamTools({ streams }),
    ...createEmitterTools({ emitters })
  ];
}
