import assert from "node:assert/strict";
import test from "node:test";

import { generateAnnotationMarkdown } from "./inspector.js";

test("generateAnnotationMarkdown preserves ordering, fallbacks, and formatting", () => {
  globalThis.document = { title: "Checkout" };
  globalThis.location = { href: "https://example.test/cart?step=pay" };
  globalThis.window = { innerWidth: 1024, innerHeight: 768 };

  const markdown = generateAnnotationMarkdown([
    {
      context: {
        selector: "#pay",
        displayName: "button.primary",
        sourceFile: "/src/Checkout.jsx",
        sourceLine: 42,
        tagPath: "main > form > button.primary",
        classes: "primary cta",
        boundingBox: { x: 10, y: 20, width: 200, height: 40 },
        reactComponent: "PayButton",
        reactHierarchy: ["CheckoutPage", "PaymentForm", "PayButton"],
        styles: { color: "rgb(255, 255, 255)", backgroundColor: "rgb(0, 0, 0)" },
        accessibility: { role: "button", ariaLabel: "Pay now" },
        text: "Pay now",
      },
      intent: "fix",
      comment: "Make the loading state clearer.",
    },
    {
      comment: "This annotation intentionally has no context.",
    },
  ]);

  assert.equal(markdown, `## Page Feedback: Checkout
**URL:** https://example.test/cart?step=pay
**Viewport:** 1024×768

### 1. #pay (/src/Checkout.jsx:42)
**Path:** main > form > button.primary
**Classes:** primary cta
**Position:** 10,20 (200×40px)
**React:** CheckoutPage > PaymentForm > PayButton
**Styles:** {"color":"rgb(255, 255, 255)","backgroundColor":"rgb(0, 0, 0)"}
**A11y:** {"role":"button","ariaLabel":"Pay now"}
**Text:** "Pay now"
**Intent:** fix
**Feedback:** Make the loading state clearer.

### 2. Annotation 2
**Feedback:** This annotation intentionally has no context.
`);
});
