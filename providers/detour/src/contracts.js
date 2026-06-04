export const MESSAGE_TYPES = Object.freeze({
  IDENTIFY: "identify",
  CONSOLE: "console",
  EVAL: "eval",
  EVAL_RESULT: "eval.result",
  PAGE_MESSAGE: "page.message",
  PAGE_ASK: "page.ask",
  ASK_REPLY: "ask.reply",
  AGENT_REPLY: "agent.reply",
  PAGE_CONTEXT: "page.context",
  PAGE_ANNOTATE: "page.annotate",
});

export const DETAIL_LEVELS = Object.freeze({
  COMPACT: "compact",
  STANDARD: "standard",
  DETAILED: "detailed",
  FORENSIC: "forensic",
});

export const DETAIL_LEVEL_OPTIONS = Object.freeze([
  { value: DETAIL_LEVELS.COMPACT, label: "Compact" },
  { value: DETAIL_LEVELS.STANDARD, label: "Standard" },
  { value: DETAIL_LEVELS.DETAILED, label: "Detailed" },
  { value: DETAIL_LEVELS.FORENSIC, label: "Forensic" },
]);

export const DETAIL_LEVEL_VALUES = Object.freeze(DETAIL_LEVEL_OPTIONS.map((level) => level.value));

export const INTENT_TOKENS = Object.freeze({
  FIX: "fix",
  CHANGE: "change",
  QUESTION: "question",
  APPROVE: "approve",
});

export const INTENT_OPTIONS = Object.freeze([
  { value: INTENT_TOKENS.FIX, icon: "🔧", label: "Fix" },
  { value: INTENT_TOKENS.CHANGE, icon: "✏️", label: "Change" },
  { value: INTENT_TOKENS.QUESTION, icon: "❓", label: "Question" },
  { value: INTENT_TOKENS.APPROVE, icon: "✅", label: "OK" },
]);
