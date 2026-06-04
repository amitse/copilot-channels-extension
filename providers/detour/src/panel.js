/**
 * Detour Context Panel — floating UI for element inspection, annotations, and agent chat.
 *
 * Uses regular DOM with prefixed classes (__dp-*) for isolation.
 * No Shadow DOM — simpler, more compatible.
 */

import { deepElementFromPoint, extractElementContext, getElementDisplayName, buildSelector, generateAnnotationMarkdown } from "./inspector.js";
import { isReactDetected } from "./react-context.js";

export function createPanel(bridge) {
  let detailLevel = "standard";
  let annotations = [];
  let pickerActive = false;
  let panelOpen = false;
  let hoveredElement = null;
  let highlightOverlay = null;
  let labelOverlay = null;
  let pickerAbort = null;
  let activePopup = null;
  const markers = new Map();

  // ── Inject styles ─────────────────────────────────────────────────────
  const styleEl = document.createElement("style");
  styleEl.textContent = `
    .__dp-fab {
      all: initial; position: fixed !important; bottom: 16px !important; right: 16px !important;
      width: 44px !important; height: 44px !important; border-radius: 50% !important;
      background: linear-gradient(135deg, #667eea, #764ba2) !important;
      color: #fff !important; border: none !important; cursor: pointer !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      font-size: 20px !important; box-shadow: 0 4px 16px rgba(0,0,0,.3) !important;
      z-index: 2147483647 !important; font-family: system-ui !important;
      transition: transform .2s !important;
    }
    .__dp-fab:hover { transform: scale(1.1) !important; }
    .__dp-fab.active { background: linear-gradient(135deg, #e53e3e, #dd6b20) !important; }

    .__dp-panel {
      all: initial; position: fixed !important; bottom: 72px !important; right: 16px !important;
      width: 360px !important; max-height: 500px !important;
      background: #1a1a2e !important; color: #e0e0e0 !important;
      border-radius: 12px !important; overflow: hidden !important;
      box-shadow: 0 8px 40px rgba(0,0,0,.5) !important;
      font: 13px/1.4 -apple-system, system-ui, sans-serif !important;
      z-index: 2147483647 !important; display: flex !important; flex-direction: column !important;
    }
    .__dp-panel.hidden { display: none !important; }

    .__dp-header {
      padding: 12px 16px !important; background: #16213e !important;
      display: flex !important; align-items: center !important; justify-content: space-between !important;
      border-bottom: 1px solid #2a2a4a !important;
    }
    .__dp-title { font: 600 14px system-ui !important; color: #fff !important; }
    .__dp-react { color: #61dafb !important; font-size: 11px !important; margin-left: 6px !important; }
    .__dp-status { font-size: 11px !important; color: #8888aa !important; }

    .__dp-toolbar {
      padding: 8px 12px !important; display: flex !important; gap: 6px !important;
      align-items: center !important; border-bottom: 1px solid #2a2a4a !important;
    }
    .__dp-btn {
      all: initial; padding: 5px 10px !important; border-radius: 6px !important;
      border: 1px solid #3a3a5a !important; background: #2a2a4a !important;
      color: #ccc !important; cursor: pointer !important; font: 12px system-ui !important;
    }
    .__dp-btn:hover { background: #3a3a6a !important; }
    .__dp-btn.active { background: #667eea !important; color: #fff !important; border-color: #667eea !important; }
    .__dp-btn.danger { background: #e53e3e !important; border-color: #e53e3e !important; color: #fff !important; }
    .__dp-select {
      all: initial; padding: 4px 6px !important; border-radius: 6px !important;
      border: 1px solid #3a3a5a !important; background: #2a2a4a !important;
      color: #ccc !important; font: 12px system-ui !important; cursor: pointer !important;
    }

    .__dp-list {
      flex: 1 !important; overflow-y: auto !important; padding: 8px 12px !important;
      max-height: 260px !important; min-height: 40px !important;
    }
    .__dp-ann {
      padding: 8px 10px !important; margin-bottom: 6px !important;
      background: #2a2a4a !important; border-radius: 8px !important;
      border-left: 3px solid #667eea !important;
    }
    .__dp-ann-head { display: flex !important; justify-content: space-between !important; align-items: center !important; }
    .__dp-ann-name { font: 600 12px system-ui !important; color: #fff !important; }
    .__dp-ann-intent {
      font: 10px system-ui !important; padding: 2px 6px !important; border-radius: 4px !important;
      background: #3a3a5a !important; color: #aaa !important; text-transform: uppercase !important;
    }
    .__dp-ann-intent.fix { background: #e53e3e33 !important; color: #fc8181 !important; }
    .__dp-ann-intent.change { background: #ecc94b33 !important; color: #ecc94b !important; }
    .__dp-ann-intent.question { background: #667eea33 !important; color: #a3bffa !important; }
    .__dp-ann-comment { font: 12px system-ui !important; color: #aaa !important; margin-top: 4px !important; }
    .__dp-ann-del {
      all: initial; color: #666 !important; cursor: pointer !important;
      font: 14px system-ui !important; padding: 2px 4px !important; margin-left: 4px !important;
    }
    .__dp-ann-del:hover { color: #e53e3e !important; }
    .__dp-empty { padding: 20px !important; text-align: center !important; color: #666 !important; font: 12px system-ui !important; }

    .__dp-chat {
      border-top: 1px solid #2a2a4a !important; padding: 8px 12px !important;
      display: flex !important; gap: 6px !important;
    }
    .__dp-input {
      all: initial; flex: 1 !important; padding: 8px 10px !important; border-radius: 8px !important;
      border: 1px solid #3a3a5a !important; background: #2a2a4a !important; color: #e0e0e0 !important;
      font: 13px system-ui !important;
    }
    .__dp-input:focus { border-color: #667eea !important; outline: none !important; }
    .__dp-send {
      all: initial; padding: 8px 14px !important; border-radius: 8px !important;
      background: #667eea !important; color: #fff !important; cursor: pointer !important;
      font: 600 13px system-ui !important; white-space: nowrap !important;
    }
    .__dp-send:hover { background: #5a6fd6 !important; }

    .__dp-popup {
      all: initial; position: fixed !important; z-index: 2147483647 !important;
      width: 300px !important; padding: 12px !important; border-radius: 10px !important;
      background: #1a1a2e !important; border: 1px solid #3a3a5a !important;
      box-shadow: 0 8px 32px rgba(0,0,0,.5) !important; font-family: system-ui !important;
    }
    .__dp-popup-name { font: 600 13px system-ui !important; color: #fff !important; margin-bottom: 8px !important; }
    .__dp-popup-ta {
      all: initial; display: block !important; width: 100% !important; height: 60px !important;
      padding: 8px !important; border-radius: 6px !important; border: 1px solid #3a3a5a !important;
      background: #2a2a4a !important; color: #e0e0e0 !important; font: 12px system-ui !important;
      resize: vertical !important; box-sizing: border-box !important;
    }
    .__dp-popup-ta:focus { border-color: #667eea !important; outline: none !important; }
    .__dp-popup-intents { display: flex !important; gap: 4px !important; margin: 8px 0 !important; }
    .__dp-intent-btn {
      all: initial; padding: 3px 8px !important; border-radius: 4px !important;
      border: 1px solid #3a3a5a !important; background: #2a2a4a !important;
      color: #aaa !important; cursor: pointer !important; font: 11px system-ui !important;
    }
    .__dp-intent-btn.selected { border-color: #667eea !important; color: #fff !important; background: #667eea33 !important; }
    .__dp-popup-actions { display: flex !important; gap: 6px !important; justify-content: flex-end !important; margin-top: 8px !important; }

    .__dp-highlight {
      position: fixed !important; pointer-events: none !important; z-index: 2147483645 !important;
      border: 2px solid #667eea !important; border-radius: 3px !important;
      background: rgba(102,126,234,.08) !important; transition: all .1s !important;
    }
    .__dp-label {
      position: fixed !important; pointer-events: none !important; z-index: 2147483646 !important;
      padding: 4px 8px !important; border-radius: 4px !important;
      background: #1a1a2e !important; color: #e0e0e0 !important; font: 600 11px system-ui !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.4) !important; white-space: nowrap !important;
    }
    .__dp-marker {
      position: absolute !important; width: 22px !important; height: 22px !important;
      border-radius: 50% !important; background: #667eea !important; color: #fff !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      font: 700 11px system-ui !important; z-index: 2147483646 !important;
      cursor: pointer !important; box-shadow: 0 2px 8px rgba(0,0,0,.4) !important;
    }
  `;

  // ── Build DOM ─────────────────────────────────────────────────────────
  const fab = document.createElement("button");
  fab.className = "__dp-fab";
  fab.textContent = "⚡";
  fab.title = "Detour Context Panel";

  const panel = document.createElement("div");
  panel.className = "__dp-panel hidden";
  panel.innerHTML = `
    <div class="__dp-header">
      <div><span class="__dp-title">⚡ Detour</span><span class="__dp-react"></span></div>
      <span class="__dp-status">connected</span>
    </div>
    <div class="__dp-toolbar">
      <button class="__dp-btn" data-action="pick">🎯 Pick</button>
      <select class="__dp-select" data-action="detail">
        <option value="compact">Compact</option>
        <option value="standard" selected>Standard</option>
        <option value="detailed">Detailed</option>
        <option value="forensic">Forensic</option>
      </select>
      <button class="__dp-btn" data-action="submit">📤 Send All</button>
      <button class="__dp-btn danger" data-action="clear" style="margin-left:auto">Clear</button>
    </div>
    <div class="__dp-list"></div>
    <div class="__dp-chat">
      <input class="__dp-input" placeholder="Message the agent..." />
      <button class="__dp-send" data-action="send">Send</button>
    </div>
  `;

  // ── Refs ──────────────────────────────────────────────────────────────
  const listEl = panel.querySelector(".__dp-list");
  const chatInput = panel.querySelector(".__dp-input");
  const reactBadge = panel.querySelector(".__dp-react");

  // ── Event delegation on panel (single handler, no per-button wiring) ─
  panel.addEventListener("click", (e) => {
    e.stopPropagation();
    const action = e.target.closest("[data-action]")?.dataset.action;
    const delBtn = e.target.closest("[data-del]");
    if (action === "pick") startPicker();
    else if (action === "submit") submitAll();
    else if (action === "clear") clearAll();
    else if (action === "send") sendChat();
    else if (delBtn) removeAnnotation(delBtn.dataset.del);
  }, true);

  panel.addEventListener("mousedown", (e) => e.stopPropagation(), true);
  panel.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
  panel.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && document.activeElement === chatInput) {
      e.preventDefault();
      sendChat();
    }
  }, true);

  panel.querySelector(".__dp-select").addEventListener("change", (e) => {
    e.stopPropagation();
    detailLevel = e.target.value;
  }, true);

  fab.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(); }, true);
  fab.addEventListener("mousedown", (e) => e.stopPropagation(), true);

  // ── Panel toggle ──────────────────────────────────────────────────────
  function togglePanel() {
    panelOpen = !panelOpen;
    panel.classList.toggle("hidden", !panelOpen);
    fab.classList.toggle("active", panelOpen);
    if (panelOpen) reactBadge.textContent = isReactDetected() ? "⚛ React" : "";
    if (!panelOpen) { stopPicker(); removeAnnotationPopup(); }
  }

  // ── Annotations ───────────────────────────────────────────────────────
  function addAnnotation(element, context, comment, intent, rect) {
    const annotation = {
      id: "ann-" + Date.now(),
      context, comment: comment || "", intent,
      selector: context?.selector || buildSelector(element),
      timestamp: new Date().toISOString(),
      anchorRect: { x: rect.x, y: rect.y + window.scrollY },
      anchorText: (element.textContent || "").slice(0, 50),
    };
    annotations.push(annotation);
    renderAnnotations();
    placeMarker(annotation);
    bridge.sendMessage("page.annotate", { annotation });
  }

  function removeAnnotation(id) {
    annotations = annotations.filter((a) => a.id !== id);
    removeMarker(id);
    renderAnnotations();
  }

  function clearAll() {
    annotations = [];
    for (const [id] of markers) removeMarker(id);
    renderAnnotations();
  }

  function renderAnnotations() {
    if (annotations.length === 0) {
      listEl.innerHTML = '<div class="__dp-empty">Click 🎯 Pick to annotate elements</div>';
      return;
    }
    listEl.innerHTML = annotations.map((ann, i) => `
      <div class="__dp-ann">
        <div class="__dp-ann-head">
          <span class="__dp-ann-name">${i + 1}. ${esc(ann.context?.displayName || ann.selector || "Element")}</span>
          <span>
            <span class="__dp-ann-intent ${ann.intent}">${ann.intent}</span>
            <button class="__dp-ann-del" data-del="${ann.id}" title="Remove">×</button>
          </span>
        </div>
        ${ann.comment ? `<div class="__dp-ann-comment">${esc(ann.comment)}</div>` : ""}
      </div>
    `).join("");
  }

  // ── Page markers ──────────────────────────────────────────────────────
  function placeMarker(ann) {
    const m = document.createElement("div");
    m.className = "__dp-marker";
    m.textContent = annotations.indexOf(ann) + 1;
    m.title = ann.comment || ann.intent;
    m.style.left = ann.anchorRect.x + "px";
    m.style.top = ann.anchorRect.y + "px";
    document.body.appendChild(m);
    markers.set(ann.id, m);
  }

  function removeMarker(id) {
    const m = markers.get(id);
    if (m && m.parentNode) m.remove();
    markers.delete(id);
  }

  // ── Annotation popup ─────────────────────────────────────────────────
  function createAnnotationPopup(element, rect) {
    removeAnnotationPopup();
    const ctx = extractElementContext(element, detailLevel);
    const displayName = ctx?.displayName || element.tagName.toLowerCase();

    const popup = document.createElement("div");
    popup.className = "__dp-popup";
    popup.style.left = Math.min(rect.right + 8, window.innerWidth - 320) + "px";
    popup.style.top = Math.min(rect.top, window.innerHeight - 240) + "px";
    popup.innerHTML = `
      <div class="__dp-popup-name">${esc(displayName)}</div>
      <textarea class="__dp-popup-ta" placeholder="What's the feedback?"></textarea>
      <div class="__dp-popup-intents">
        <button class="__dp-intent-btn selected" data-intent="fix">🔧 Fix</button>
        <button class="__dp-intent-btn" data-intent="change">✏️ Change</button>
        <button class="__dp-intent-btn" data-intent="question">❓ Question</button>
        <button class="__dp-intent-btn" data-intent="approve">✅ OK</button>
      </div>
      <div class="__dp-popup-actions">
        <button class="__dp-btn" data-popup="cancel">Cancel</button>
        <button class="__dp-btn active" data-popup="save">Add Note</button>
      </div>
    `;

    let selectedIntent = "fix";

    popup.addEventListener("click", (e) => {
      e.stopPropagation();
      const intentBtn = e.target.closest("[data-intent]");
      if (intentBtn) {
        popup.querySelectorAll(".__dp-intent-btn").forEach((b) => b.classList.remove("selected"));
        intentBtn.classList.add("selected");
        selectedIntent = intentBtn.dataset.intent;
      }
      const popupAction = e.target.closest("[data-popup]")?.dataset.popup;
      if (popupAction === "cancel") removeAnnotationPopup();
      if (popupAction === "save") {
        addAnnotation(element, ctx, popup.querySelector("textarea").value.trim(), selectedIntent, rect);
        removeAnnotationPopup();
      }
    }, true);
    popup.addEventListener("mousedown", (e) => e.stopPropagation(), true);
    popup.addEventListener("keydown", (e) => e.stopPropagation(), true);

    document.body.appendChild(popup);
    activePopup = popup;
    setTimeout(() => popup.querySelector("textarea").focus(), 50);
  }

  function removeAnnotationPopup() {
    if (activePopup) { activePopup.remove(); activePopup = null; }
  }

  // ── Element picker ────────────────────────────────────────────────────
  function startPicker() {
    if (pickerActive) { stopPicker(); return; }
    pickerActive = true;
    panel.querySelector("[data-action=pick]").classList.add("active");
    pickerAbort = new AbortController();
    const signal = pickerAbort.signal;

    highlightOverlay = document.createElement("div");
    highlightOverlay.className = "__dp-highlight";
    highlightOverlay.style.display = "none";
    document.body.appendChild(highlightOverlay);

    labelOverlay = document.createElement("div");
    labelOverlay.className = "__dp-label";
    labelOverlay.style.display = "none";
    document.body.appendChild(labelOverlay);

    document.addEventListener("mousemove", onPickerMove, { capture: true, signal });
    document.addEventListener("click", onPickerClick, { capture: true, signal });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { stopPicker(); e.preventDefault(); } }, { capture: true, signal });
  }

  function stopPicker() {
    pickerActive = false;
    const pickBtn = panel.querySelector("[data-action=pick]");
    if (pickBtn) pickBtn.classList.remove("active");
    if (pickerAbort) { pickerAbort.abort(); pickerAbort = null; }
    if (highlightOverlay) { highlightOverlay.remove(); highlightOverlay = null; }
    if (labelOverlay) { labelOverlay.remove(); labelOverlay = null; }
    hoveredElement = null;
  }

  function onPickerMove(e) {
    const el = deepElementFromPoint(e.clientX, e.clientY);
    if (!el || el.closest(".__dp-panel, .__dp-fab, .__dp-popup, .__dp-marker")) {
      if (highlightOverlay) highlightOverlay.style.display = "none";
      if (labelOverlay) labelOverlay.style.display = "none";
      hoveredElement = null;
      return;
    }
    hoveredElement = el;
    const rect = el.getBoundingClientRect();
    Object.assign(highlightOverlay.style, {
      display: "block",
      left: rect.left + "px", top: rect.top + "px",
      width: rect.width + "px", height: rect.height + "px",
    });
    labelOverlay.textContent = getElementDisplayName(el);
    Object.assign(labelOverlay.style, {
      display: "block",
      left: Math.min(e.clientX + 12, window.innerWidth - 200) + "px",
      top: Math.max(e.clientY - 28, 4) + "px",
    });
  }

  function onPickerClick(e) {
    if (!hoveredElement) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = hoveredElement.getBoundingClientRect();
    createAnnotationPopup(hoveredElement, rect);
    stopPicker();
  }

  // ── Chat / Send ───────────────────────────────────────────────────────
  function submitAll() {
    if (annotations.length === 0) return;
    const markdown = generateAnnotationMarkdown(annotations, detailLevel);
    bridge.sendMessage("page.context", { markdown, annotations, detailLevel });
  }

  function sendChat() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    if (annotations.length > 0) {
      const markdown = generateAnnotationMarkdown(annotations, detailLevel);
      bridge.sendMessage("page.context", { message: msg, markdown, annotations, detailLevel });
    } else {
      bridge.sendMessage("page.message", { message: msg });
    }
    chatInput.value = "";
  }

  function showAgentReply(message) {
    console.log("[Detour] Agent:", message);
  }

  // ── Mount / unmount ───────────────────────────────────────────────────
  function mount() {
    const target = document.body || document.documentElement;
    target.appendChild(styleEl);
    target.appendChild(fab);
    target.appendChild(panel);
    renderAnnotations();
  }

  function unmount() {
    stopPicker(); removeAnnotationPopup(); clearAll();
    styleEl.remove(); fab.remove(); panel.remove();
  }

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  return { mount, unmount, showAgentReply, togglePanel };
}
