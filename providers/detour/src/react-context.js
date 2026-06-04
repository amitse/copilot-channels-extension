/**
 * React Context Extraction — best-effort React component info from DOM elements.
 *
 * Uses bippy for React Fiber traversal when React is detected on the page.
 * Gracefully degrades to null when React is not present or fibers are inaccessible.
 */

let bippy = null;

// bippy is bundled at build time via esbuild
try {
  // Dynamic require at bundle time — esbuild will resolve this
  bippy = require("bippy");
} catch {
  // bippy not available — React extraction will be skipped
}

// Internal React component names to skip
const INTERNAL_NAMES = new Set([
  "Fragment", "Suspense", "StrictMode", "Profiler", "Portal",
  "Provider", "Consumer", "Context", "ForwardRef", "Memo",
  "InnerLayoutRouter", "ErrorBoundary", "AppRouter", "RenderFromTemplateContext",
  "ScrollAndFocusHandler", "RedirectBoundary", "NotFoundBoundary",
  "HotReload", "Router", "RouterContext",
]);

const LIBRARY_PREFIXES = [
  "motion.", "styled.", "chakra.", "ark.", "radix.",
  "Transition", "AnimatePresence",
];

function isUsefulComponentName(name) {
  if (!name || typeof name !== "string") return false;
  if (INTERNAL_NAMES.has(name)) return false;
  if (LIBRARY_PREFIXES.some((p) => name.startsWith(p))) return false;
  if (name.length <= 1) return false;
  return true;
}

/**
 * Check if React is present on the page.
 */
export function isReactDetected() {
  if (!bippy) return false;
  // Check for React root markers
  const roots = document.querySelectorAll("[data-reactroot], #__next, #root, #app");
  for (const root of roots) {
    const keys = Object.keys(root);
    if (keys.some((k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"))) {
      return true;
    }
  }
  // Broader check — any element with fiber
  try {
    const fiber = bippy.getFiberFromHostInstance(document.body);
    return fiber != null;
  } catch {
    return false;
  }
}

/**
 * Get React Fiber from a DOM element.
 */
function getFiber(element) {
  if (!bippy || !element) return null;
  try {
    return bippy.getFiberFromHostInstance(element);
  } catch {
    // Manual fallback: check __reactFiber$ keys
    const keys = Object.keys(element);
    const fiberKey = keys.find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    return fiberKey ? element[fiberKey] : null;
  }
}

/**
 * Get the display name of a fiber.
 */
function getFiberName(fiber) {
  if (!fiber || !fiber.type) return null;
  if (typeof fiber.type === "string") return null; // HTML element, not component
  return fiber.type.displayName || fiber.type.name || null;
}

/**
 * Walk up the fiber tree to find useful component names.
 */
function getComponentHierarchy(element, maxDepth = 10) {
  const fiber = getFiber(element);
  if (!fiber) return [];

  const components = [];
  let current = fiber;
  let depth = 0;

  while (current && depth < maxDepth) {
    const name = getFiberName(current);
    if (isUsefulComponentName(name)) {
      components.push(name);
    }
    current = current.return;
    depth++;
  }

  return components;
}

/**
 * Get the nearest useful React component name for an element.
 */
export function getNearestComponentName(element) {
  const hierarchy = getComponentHierarchy(element, 20);
  return hierarchy.length > 0 ? hierarchy[0] : null;
}

/**
 * Get source file location from React fiber debug info.
 * Only available in development builds.
 */
export function getSourceLocation(element) {
  const fiber = getFiber(element);
  if (!fiber) return null;

  let current = fiber;
  let depth = 0;
  while (current && depth < 20) {
    const source = current._debugSource;
    if (source && source.fileName) {
      return {
        fileName: source.fileName,
        lineNumber: source.lineNumber || null,
        columnNumber: source.columnNumber || null,
      };
    }
    current = current.return;
    depth++;
  }
  return null;
}

/**
 * Get full React context for an element — component hierarchy, source, props summary.
 */
export function getReactContext(element) {
  if (!bippy && !getFiber(element)) return null;

  const hierarchy = getComponentHierarchy(element, 15);
  const source = getSourceLocation(element);
  const nearest = hierarchy.length > 0 ? hierarchy[0] : null;

  if (!nearest && !source) return null;

  return {
    component: nearest,
    hierarchy: hierarchy.length > 0 ? hierarchy : undefined,
    source: source || undefined,
    reactDetected: true,
  };
}
