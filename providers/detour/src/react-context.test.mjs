import assert from "node:assert/strict";
import test from "node:test";

import { getNearestComponentName, getReactContext, isReactDetected } from "./react-context.js";

function reactFiberLikeElement() {
  const appFiber = {
    type: { name: "CheckoutPage" },
    _debugSource: { fileName: "/src/CheckoutPage.jsx", lineNumber: 12, columnNumber: 4 },
    return: null,
  };
  const buttonFiber = {
    type: { displayName: "PayButton" },
    return: appFiber,
  };
  return {
    "__reactFiber$detour": {
      type: "button",
      return: buttonFiber,
    },
  };
}

test("React detection degrades to false without bundled bippy", () => {
  const root = reactFiberLikeElement();
  globalThis.document = {
    querySelectorAll: () => [root],
    body: root,
  };

  // In Node ESM, react-context.js intentionally imports with bippy unavailable;
  // these browserless tests lock the public graceful-degradation behavior.
  assert.equal(isReactDetected(), false);
});

test("React context exports return null for fiber-like elements without bippy", () => {
  const element = reactFiberLikeElement();

  assert.equal(getNearestComponentName(element), null);
  assert.equal(getReactContext(element), null);
});
