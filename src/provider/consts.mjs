export const GATEWAY_PORT = 9400;
export const PROTOCOL_VERSION = 2;
export const RELOAD_DEBOUNCE_MS = 200;
export const TOKEN_PREFIX = "ptk-";

export const PAYLOAD_LIMIT = Object.freeze({
  TOOL_RESULT: 5 * 1024 * 1024,
  DEFAULT: 2 * 1024 * 1024
});

export const MAX_TOOLS_PER_PROVIDER = 100;

export const CONNECTION_STATE = Object.freeze({
  AWAIT_AUTH: "AwaitAuth",
  AWAIT_HELLO: "AwaitHello",
  BOUND: "Bound",
  DISCONNECTED: "Disconnected",
  ERROR: "Error"
});

export const MESSAGE_TYPE = Object.freeze({
  // Provider → Gateway
  AUTH: "auth",
  HELLO: "hello",
  TOOL_RESULT: "tool.result",
  GOODBYE: "goodbye",
  // Gateway → Provider
  SESSIONS: "sessions",
  HELLO_ACK: "hello.ack",
  TOOL_CALL: "tool.call",
  TOOL_CANCEL: "tool.cancel",
  SESSION_LIFECYCLE: "session.lifecycle",
  ERROR: "error"
});

export const ERROR_CODE = Object.freeze({
  AUTH_FAILED: "AUTH_FAILED",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  INVALID_SESSION: "INVALID_SESSION",
  TOOL_CONFLICT: "TOOL_CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
  INVALID_JSON: "INVALID_JSON",
  UNKNOWN_TYPE: "UNKNOWN_TYPE"
});

export const FATAL_ERROR_CODES = Object.freeze([
  ERROR_CODE.AUTH_FAILED,
  ERROR_CODE.UNSUPPORTED_VERSION
]);

export const SESSION_LIFECYCLE_STATE = Object.freeze({
  STARTED: "started",
  IDLE: "idle",
  SHUTDOWN_PENDING: "shutdown.pending"
});

export const TOOL_RESULT_ERROR = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
  INTERNAL: "INTERNAL",
  DISCONNECTED: "DISCONNECTED"
});
