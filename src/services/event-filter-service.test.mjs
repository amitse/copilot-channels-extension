import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { formatEventFilter } from "../format/event-filter.mjs";
import { compileRegex } from "../util/regex.mjs";
import { normalizeOwnership, normalizeLifespan } from "../util/normalize.mjs";
import { EventFilterService } from "./event-filter-service.mjs";

function expectedFilter(source = {}, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  const filterSource = source.eventFilter && typeof source.eventFilter === "object" ? source.eventFilter : source;
  const rules = Array.isArray(filterSource.rules) ? filterSource.rules : [];

  return {
    rules: rules.map((rule) => ({
      ...rule,
      regex: compileRegex(rule.match, "rule.match")
    })),
    ownership: normalizeOwnership(filterSource.ownership ?? filterSource.managedBy, fallbackOwnership),
    lifespan: normalizeLifespan(filterSource.lifespan ?? filterSource.scope, fallbackLifespan)
  };
}

const cases = [
  {
    name: "canonical rule list",
    input: {
      rules: [
        { match: "apple", outcome: EVENT_OUTCOME.KEEP },
        { match: "banana", outcome: EVENT_OUTCOME.DROP },
        { match: "cherry", outcome: EVENT_OUTCOME.INJECT }
      ],
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    },
    texts: ["apple pie", "banana bread", "cherry tart", "grape"]
  },
  {
    name: "eventFilter wrapper",
    input: {
      eventFilter: {
        rules: [
          { match: "sync", outcome: EVENT_OUTCOME.INJECT },
          { match: ".*", outcome: EVENT_OUTCOME.KEEP }
        ],
        ownership: OWNERSHIP.USER_OWNED,
        lifespan: LIFESPAN.TEMPORARY
      }
    },
    texts: ["sync now", "async later"]
  },
  {
    name: "legacy aliases",
    input: {
      rules: [{ match: "legacy", outcome: EVENT_OUTCOME.DROP }],
      managedBy: OWNERSHIP.USER_OWNED,
      scope: LIFESPAN.PERSISTENT
    },
    texts: ["legacy path", "modern path"]
  }
];

for (const item of cases) {
  test(item.name, () => {
    const expected = expectedFilter(item.input);
    const service = EventFilterService.normalize(item.input);

    assert.deepEqual(EventFilterService.serialize(service), EventFilterService.serialize(expected));
    assert.equal(service.ownership, expected.ownership);
    assert.equal(service.lifespan, expected.lifespan);

    for (const text of item.texts) {
      assert.equal(EventFilterService.evaluate(service, text), EventFilterService.evaluate(expected, text));
    }

    assert.equal(formatEventFilter(service), EventFilterService.format(service));
  });
}

test("update preserves ownership and lifespan for wrapper changes", () => {
  const current = EventFilterService.normalize({
    rules: [{ match: "old", outcome: EVENT_OUTCOME.KEEP }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });

  const updated = EventFilterService.update(current, {
    eventFilter: {
      rules: [{ match: "new", outcome: EVENT_OUTCOME.INJECT }]
    }
  });

  assert.deepEqual(EventFilterService.serialize(updated), {
    rules: [{ match: "new", outcome: EVENT_OUTCOME.INJECT }],
    ownership: OWNERSHIP.USER_OWNED,
    lifespan: LIFESPAN.PERSISTENT
  });
});
