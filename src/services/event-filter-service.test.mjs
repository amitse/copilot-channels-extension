import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_OUTCOME, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { formatEventFilter } from "../format/event-filter.mjs";
import { compileRegex } from "../util/regex.mjs";
import { normalizeOwnership, normalizeLifespan, normalizeOutcome } from "../util/normalize.mjs";
import { EventFilterService } from "./event-filter-service.mjs";

const SAFE_RULE_OUTCOME = EVENT_OUTCOME.DROP;

function expectedFilter(source = {}, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  const filterSource = source.eventFilter && typeof source.eventFilter === "object" ? source.eventFilter : source;
  const rules = Array.isArray(filterSource.rules) ? filterSource.rules : [];

  return {
    rules: rules.map((rule) => ({
      match: String(rule?.match ?? ""),
      outcome: normalizeOutcome(rule?.outcome, SAFE_RULE_OUTCOME),
      regex: compileRegex(rule?.match, "rule.match")
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
        { match: "cherry", outcome: EVENT_OUTCOME.INJECT },
        { match: "date", outcome: EVENT_OUTCOME.SURFACE }
      ],
      ownership: OWNERSHIP.USER_OWNED,
      lifespan: LIFESPAN.PERSISTENT
    },
    texts: ["apple pie", "banana bread", "cherry tart", "date square", "grape"]
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
  },
  {
    name: "case and whitespace outcome normalization",
    input: {
      rules: [
        { match: "trimmed-drop", outcome: " DROP " },
        { match: "loud-surface", outcome: " Surface\t" },
        { match: "urgent-inject", outcome: "\nInJeCt " },
        { match: "stored-keep", outcome: " Keep " }
      ]
    },
    texts: ["trimmed-drop", "loud-surface", "urgent-inject", "stored-keep", "unmatched"]
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

test("invalid and missing outcomes canonicalize to safe drop", () => {
  const filter = EventFilterService.normalize({
    rules: [
      { match: "invalid", outcome: "notify" },
      { match: "missing" },
      { match: "blank", outcome: "   " }
    ]
  });

  assert.deepEqual(EventFilterService.serialize(filter), {
    rules: [
      { match: "invalid", outcome: EVENT_OUTCOME.DROP },
      { match: "missing", outcome: EVENT_OUTCOME.DROP },
      { match: "blank", outcome: EVENT_OUTCOME.DROP }
    ],
    ownership: OWNERSHIP.MODEL_OWNED,
    lifespan: LIFESPAN.TEMPORARY
  });
  assert.equal(EventFilterService.evaluate(filter, "invalid outcome"), EVENT_OUTCOME.DROP);
  assert.equal(EventFilterService.evaluate(filter, "missing outcome"), EVENT_OUTCOME.DROP);
  assert.equal(EventFilterService.evaluate(filter, "blank outcome"), EVENT_OUTCOME.DROP);
  assert.equal(EventFilterService.evaluate(filter, "no rule matches"), EVENT_OUTCOME.KEEP);
});

test("evaluate normalizes raw rule outcomes before routing", () => {
  const rawFilter = {
    rules: [
      { match: "danger", outcome: "inject-now" },
      { match: "heads-up", outcome: " SURFACE " }
    ]
  };

  assert.equal(EventFilterService.evaluate(rawFilter, "danger"), EVENT_OUTCOME.DROP);
  assert.equal(EventFilterService.evaluate(rawFilter, "heads-up"), EVENT_OUTCOME.SURFACE);
  assert.equal(EventFilterService.evaluate(rawFilter, "quiet"), EVENT_OUTCOME.KEEP);
});

test("invalid outcomes remain safe after serialize and deserialize", () => {
  const serialized = EventFilterService.serialize({
    rules: [{ match: "legacy", outcome: "notify" }]
  });
  const hydrated = EventFilterService.deserialize(serialized);

  assert.deepEqual(serialized.rules, [{ match: "legacy", outcome: EVENT_OUTCOME.DROP }]);
  assert.equal(EventFilterService.evaluate(hydrated, "legacy event"), EVENT_OUTCOME.DROP);
  assert.equal(formatEventFilter(hydrated), EventFilterService.format(hydrated));
});
