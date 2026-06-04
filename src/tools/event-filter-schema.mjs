import { EVENT_OUTCOME } from "../consts.mjs";

const EVENT_FILTER_OUTCOMES = Object.freeze(Object.values(EVENT_OUTCOME));

const EVENT_FILTER_RULE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    match: {
      type: "string",
      description: "Regex pattern matched against each event line."
    },
    outcome: {
      type: "string",
      description: `Event outcome (${EVENT_FILTER_OUTCOMES.join(", ")}). Case and surrounding whitespace are normalized; invalid or missing outcomes safely drop matched lines.`
    }
  },
  required: ["match", "outcome"]
});

export const EVENT_FILTER_PARAMETER_SCHEMA = Object.freeze({
  type: "object",
  description: "Canonical event filter object. Provide ordered rules as [{ match, outcome }].",
  properties: {
    rules: {
      type: "array",
      minItems: 1,
      items: EVENT_FILTER_RULE_SCHEMA
    }
  }
});
