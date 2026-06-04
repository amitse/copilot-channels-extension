import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { compileRegex } from "../util/regex.mjs";
import { normalizeOwnership, normalizeLifespan } from "../util/normalize.mjs";
import { EventFilterService } from "./event-filter-service.mjs";

function legacyCreateEventFilter(source = {}, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  const filterSource = source.eventFilter && typeof source.eventFilter === "object"
    ? source.eventFilter
    : source.classifier && typeof source.classifier === "object"
      ? source.classifier
      : source;

  const rawRules = Array.isArray(filterSource.rules)
    ? filterSource.rules
    : (() => {
        const rules = [];
        if (filterSource.excludePattern) {
          rules.push({ match: String(filterSource.excludePattern), outcome: EVENT_OUTCOME.DROP });
        }
        if (filterSource.notifyPattern) {
          rules.push({ match: String(filterSource.notifyPattern), outcome: EVENT_OUTCOME.INJECT });
        }
        if (filterSource.includePattern) {
          rules.push({ match: String(filterSource.includePattern), outcome: EVENT_OUTCOME.KEEP });
          rules.push({ match: ".*", outcome: EVENT_OUTCOME.DROP });
        }
        return rules;
      })();

  return {
    rules: rawRules.map((rule) => ({
      ...rule,
      regex: compileRegex(rule.match, "rule.match")
    })),
    ownership: normalizeOwnership(filterSource.ownership ?? filterSource.managedBy ?? source.ownership ?? source.managedBy, fallbackOwnership),
    lifespan: normalizeLifespan(filterSource.lifespan ?? filterSource.scope ?? source.lifespan ?? source.scope, fallbackLifespan)
  };
}

function legacyEvaluate(filter, text) {
  if (!filter || !filter.rules) {
    return EVENT_OUTCOME.KEEP;
  }

  for (const rule of filter.rules) {
    if (rule.regex && rule.regex.test(text)) {
      return rule.outcome;
    }
  }

  return EVENT_OUTCOME.KEEP;
}

const cases = [
  {
    name: "legacy include/exclude/notify ordering",
    input: {
      includePattern: "apple",
      excludePattern: "banana",
      notifyPattern: "cherry",
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    },
    texts: ["apple pie", "banana bread", "cherry tart", "grape"]
  },
  {
    name: "explicit rule array",
    input: {
      rules: [
        { match: "error", outcome: EVENT_OUTCOME.DROP },
        { match: "warn", outcome: EVENT_OUTCOME.INJECT }
      ],
      ownership: OWNERSHIP.MODEL_OWNED,
      lifespan: LIFESPAN.TEMPORARY
    },
    texts: ["error", "warning", "info"]
  },
  {
    name: "classifier wrapper",
    input: {
      classifier: {
        notifyPattern: "sync",
        ownership: OWNERSHIP.USER_OWNED
      }
    },
    texts: ["sync now", "async later"]
  }
];

for (const item of cases) {
  test(item.name, () => {
    const legacy = legacyCreateEventFilter(item.input);
    const service = EventFilterService.normalize(item.input);

    assert.deepEqual(EventFilterService.serialize(service), EventFilterService.serialize(legacy));
    assert.equal(service.ownership, legacy.ownership);
    assert.equal(service.lifespan, legacy.lifespan);

    for (const text of item.texts) {
      assert.equal(EventFilterService.evaluate(service, text), legacyEvaluate(legacy, text));
    }
  });
}
