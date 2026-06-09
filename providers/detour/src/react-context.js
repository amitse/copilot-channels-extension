/**
 * React Context Extraction — best-effort React component info from DOM elements.
 *
 * Uses bippy for React Fiber traversal when React is detected on the page.
 * Gracefully degrades to null when React is not present or fibers are inaccessible.
 */

import {
  getNearestComponentNameWithBippy,
  getReactContextWithBippy,
  isReactDetectedWithBippy,
} from "./react-context-core.js";

let bippy = null;

// bippy is bundled at build time via esbuild
try {
  // Dynamic require at bundle time — esbuild will resolve this
  bippy = require("bippy");
} catch {
  // bippy not available — React extraction will be skipped
}

/**
 * Check if React is present on the page.
 */
export function isReactDetected() {
  if (!bippy) return false;
  return isReactDetectedWithBippy(bippy, document);
}

/**
 * Get the nearest useful React component name for an element.
 */
export function getNearestComponentName(element) {
  return getNearestComponentNameWithBippy(bippy, element);
}

/**
 * Get full React context for an element — component hierarchy, source, props summary.
 */
export function getReactContext(element) {
  return getReactContextWithBippy(bippy, element);
}
