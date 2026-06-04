import {
  AppError,
  ConflictError,
  LifecycleError,
  NotFoundError,
  TimeoutError,
  ValidationError,
  toAppError
} from "./index.mjs";

const STATUS_BY_CLASS = new Map([
  [ValidationError, 400],
  [ConflictError, 409],
  [LifecycleError, 409],
  [NotFoundError, 404],
  [TimeoutError, 504],
  [AppError, 500]
]);

function sanitizeContext(context) {
  if (!context || typeof context !== "object") {
    return undefined;
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === null) {
      sanitized[key] = null;
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function mapErrorToResponse(error, options = {}) {
  const appError = toAppError(error, options);
  const statusCode = STATUS_BY_CLASS.get(appError.constructor) ?? 500;
  const isServerError = statusCode >= 500;

  const response = {
    error: {
      code: appError.code,
      message: isServerError ? "Internal server error" : appError.message,
      retryable: appError.retryable === true
    }
  };

  const sanitizedContext = sanitizeContext(appError.context);
  if (options.includeContext === true && sanitizedContext) {
    response.error.context = sanitizedContext;
  }

  return {
    statusCode,
    response,
    diagnostics: {
      name: appError.name,
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable === true,
      context: appError.context
    },
    error: appError
  };
}

export function normalizeToolError(error, options = {}) {
  return mapErrorToResponse(error, options).error;
}
