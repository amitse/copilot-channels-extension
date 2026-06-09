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
  if (LIBRARY_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (name.length <= 1) return false;
  return true;
}

/**
 * Check if React is present on the page.
 */
export function isReactDetectedWithBippy(bippy, documentRef) {
  if (!bippy) return false;
  // Check for React root markers
  const roots = documentRef.querySelectorAll("[data-reactroot], #__next, #root, #app");
  for (const root of roots) {
    const keys = Object.keys(root);
    if (keys.some((key) => key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance"))) {
      return true;
    }
  }
  // Broader check — any element with fiber
  try {
    const fiber = bippy.getFiberFromHostInstance(documentRef.body);
    return fiber != null;
  } catch {
    return false;
  }
}

/**
 * Get React Fiber from a DOM element.
 */
function getFiber(bippy, element) {
  if (!bippy || !element) return null;
  try {
    return bippy.getFiberFromHostInstance(element);
  } catch {
    // Manual fallback: check __reactFiber$ keys
    const keys = Object.keys(element);
    const fiberKey = keys.find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
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
function getComponentHierarchy(bippy, element, maxDepth = 10) {
  const fiber = getFiber(bippy, element);
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
export function getNearestComponentNameWithBippy(bippy, element) {
  const hierarchy = getComponentHierarchy(bippy, element, 20);
  return hierarchy.length > 0 ? hierarchy[0] : null;
}

/**
 * Get source file location from React fiber debug info.
 * Only available in development builds.
 */
function getSourceLocation(bippy, element) {
  const fiber = getFiber(bippy, element);
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
export function getReactContextWithBippy(bippy, element) {
  if (!bippy && !getFiber(bippy, element)) return null;

  const hierarchy = getComponentHierarchy(bippy, element, 15);
  const source = getSourceLocation(bippy, element);
  const nearest = hierarchy.length > 0 ? hierarchy[0] : null;

  if (!nearest && !source) return null;

  return {
    component: nearest,
    hierarchy: hierarchy.length > 0 ? hierarchy : undefined,
    source: source || undefined,
    reactDetected: true,
  };
}
