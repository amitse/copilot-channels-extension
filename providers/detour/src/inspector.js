/**
 * Element Inspector — extracts structured context from DOM elements.
 *
 * 4 detail levels:
 *   compact:  element name + tag
 *   standard: + selector, bounding box, viewport, tag path
 *   detailed: + CSS classes, key styles, nearby text
 *   forensic: + full DOM path, accessibility, React context, source file
 */

import { getReactContext, isReactDetected, getNearestComponentName } from "./react-context.js";

const DETAIL_LEVELS = ["compact", "standard", "detailed", "forensic"];

// ── Element identification ──────────────────────────────────────────────

/**
 * Deep element from point — pierces shadow DOM.
 */
export function deepElementFromPoint(x, y) {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const deeper = element.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === element) break;
    element = deeper;
  }
  return element;
}

/**
 * Build a concise CSS selector for an element.
 */
export function buildSelector(el) {
  if (!el || el === document.body || el === document.documentElement) return el ? el.tagName.toLowerCase() : "";

  if (el.id) return `#${CSS.escape(el.id)}`;

  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList)
    .filter((c) => c.length < 30 && !/^[a-z]{6,}$/.test(c)) // skip hash classes
    .slice(0, 3);

  if (classes.length > 0) {
    const sel = `${tag}.${classes.map(CSS.escape).join(".")}`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }

  // Fallback: nth-child path
  const parent = el.parentElement;
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (siblings.length === 1) return `${buildSelector(parent)} > ${tag}`;
  const idx = siblings.indexOf(el) + 1;
  return `${buildSelector(parent)} > ${tag}:nth-child(${idx})`;
}

/**
 * Build a human-readable tag path: article > section > div > button
 */
export function buildTagPath(el) {
  const parts = [];
  let current = el;
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    const tag = current.tagName.toLowerCase();
    const cls = current.classList.length > 0 ? `.${Array.from(current.classList).slice(0, 2).join(".")}` : "";
    parts.unshift(tag + cls);
    current = current.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

/**
 * Build full DOM path from document root.
 */
function buildFullPath(el) {
  const parts = [];
  let current = el;
  while (current && current !== document) {
    const tag = current.tagName ? current.tagName.toLowerCase() : "";
    if (tag) parts.unshift(tag + (current.id ? `#${current.id}` : ""));
    current = current.parentNode;
  }
  return parts.join(" > ");
}

// ── Style extraction ────────────────────────────────────────────────────

const KEY_STYLE_PROPS = [
  "display", "position", "color", "backgroundColor", "fontSize",
  "fontWeight", "padding", "margin", "border", "borderRadius",
  "width", "height", "overflow", "opacity", "zIndex",
];

function getKeyStyles(el) {
  const computed = getComputedStyle(el);
  const styles = {};
  for (const prop of KEY_STYLE_PROPS) {
    const val = computed[prop];
    if (val && val !== "none" && val !== "normal" && val !== "auto" && val !== "0px" && val !== "rgba(0, 0, 0, 0)") {
      styles[prop] = val;
    }
  }
  return Object.keys(styles).length > 0 ? styles : undefined;
}

// ── Text extraction ─────────────────────────────────────────────────────

function getNearbyText(el) {
  const own = el.textContent || "";
  const trimmed = own.replace(/\s+/g, " ").trim().slice(0, 150);
  return trimmed || undefined;
}

// ── Accessibility ───────────────────────────────────────────────────────

function getAccessibility(el) {
  const info = {};
  const role = el.getAttribute("role");
  const ariaLabel = el.getAttribute("aria-label");
  const ariaDescribedBy = el.getAttribute("aria-describedby");
  const altText = el.getAttribute("alt");
  const title = el.getAttribute("title");

  if (role) info.role = role;
  if (ariaLabel) info.ariaLabel = ariaLabel;
  if (ariaDescribedBy) info.ariaDescribedBy = ariaDescribedBy;
  if (altText) info.alt = altText;
  if (title) info.title = title;

  return Object.keys(info).length > 0 ? info : undefined;
}

// ── Element display name ────────────────────────────────────────────────

export function getElementDisplayName(el) {
  const tag = el.tagName.toLowerCase();
  const reactName = getNearestComponentName(el);
  if (reactName) return `<${reactName}> (${tag})`;
  if (el.id) return `${tag}#${el.id}`;
  if (el.classList.length > 0) return `${tag}.${Array.from(el.classList).slice(0, 2).join(".")}`;
  return tag;
}

// ── Main extraction function ────────────────────────────────────────────

/**
 * Extract structured context from an element at a given detail level.
 *
 * @param {HTMLElement} element
 * @param {string} detailLevel — "compact" | "standard" | "detailed" | "forensic"
 * @returns {object} context
 */
export function extractElementContext(element, detailLevel = "standard") {
  if (!element) return null;

  const tag = element.tagName.toLowerCase();

  // Compact: minimal info
  const context = {
    tag,
    displayName: getElementDisplayName(element),
  };

  if (detailLevel === "compact") return context;

  // Standard: + selector, bounding box, viewport, tag path
  context.selector = buildSelector(element);
  context.tagPath = buildTagPath(element);
  const rect = element.getBoundingClientRect();
  context.boundingBox = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  context.viewport = { width: window.innerWidth, height: window.innerHeight };
  context.text = getNearbyText(element);

  if (detailLevel === "standard") return context;

  // Detailed: + classes, styles, nearby text
  context.classes = element.className || undefined;
  context.styles = getKeyStyles(element);

  if (detailLevel === "detailed") return context;

  // Forensic: + full DOM path, accessibility, React context, source
  context.fullDOMPath = buildFullPath(element);
  context.accessibility = getAccessibility(element);

  const reactCtx = getReactContext(element);
  if (reactCtx) {
    context.reactComponent = reactCtx.component;
    context.reactHierarchy = reactCtx.hierarchy;
    if (reactCtx.source) {
      context.sourceFile = reactCtx.source.fileName;
      if (reactCtx.source.lineNumber) context.sourceLine = reactCtx.source.lineNumber;
    }
  }

  return context;
}

/**
 * Generate structured markdown from annotations for AI consumption.
 */
export function generateAnnotationMarkdown(annotations, detailLevel = "standard") {
  const lines = [];
  const url = location.href;
  const title = document.title;

  lines.push(`## Page Feedback: ${title}`);
  lines.push(`**URL:** ${url}`);
  lines.push(`**Viewport:** ${window.innerWidth}×${window.innerHeight}`);
  if (isReactDetected()) lines.push(`**Framework:** React detected`);
  lines.push("");

  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i];
    const num = i + 1;
    const header = ann.context?.selector || ann.context?.displayName || `Annotation ${num}`;
    const src = ann.context?.sourceFile ? ` (${ann.context.sourceFile}${ann.context.sourceLine ? ":" + ann.context.sourceLine : ""})` : "";

    lines.push(`### ${num}. ${header}${src}`);

    if (ann.context) {
      const ctx = ann.context;
      if (ctx.tagPath) lines.push(`**Path:** ${ctx.tagPath}`);
      if (ctx.classes) lines.push(`**Classes:** ${ctx.classes}`);
      if (ctx.boundingBox) lines.push(`**Position:** ${ctx.boundingBox.x},${ctx.boundingBox.y} (${ctx.boundingBox.width}×${ctx.boundingBox.height}px)`);
      if (ctx.reactComponent) lines.push(`**React:** ${ctx.reactHierarchy ? ctx.reactHierarchy.join(" > ") : ctx.reactComponent}`);
      if (ctx.styles) lines.push(`**Styles:** ${JSON.stringify(ctx.styles)}`);
      if (ctx.accessibility) lines.push(`**A11y:** ${JSON.stringify(ctx.accessibility)}`);
      if (ctx.text) lines.push(`**Text:** "${ctx.text}"`);
    }

    if (ann.intent) lines.push(`**Intent:** ${ann.intent}`);
    if (ann.comment) lines.push(`**Feedback:** ${ann.comment}`);
    lines.push("");
  }

  return lines.join("\n");
}
