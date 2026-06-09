const DEFAULT_ERROR_CODE = "INTERNAL";

function cloneContext(context) {
  if (context === undefined || context === null) {
    return {};
  }
  if (typeof context !== "object" || Array.isArray(context)) {
    return { value: context };
  }
  return { ...context };
}

export class AppError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? DEFAULT_ERROR_CODE;
    this.context = Object.freeze(cloneContext(options.context));
    this.retryable = options.retryable === true;
  }
}

export class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? "VALIDATION",
      retryable: false
    });
  }
}

export class ConflictError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? "CONFLICT",
      retryable: false
    });
  }
}

export class LifecycleError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? "LIFECYCLE",
      retryable: options.retryable ?? false
    });
  }
}

export class TimeoutError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? "TIMEOUT",
      retryable: options.retryable ?? true
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? "NOT_FOUND",
      retryable: false
    });
  }
}

export function toAppError(error, options = {}) {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(error.message || options.message || "Unexpected error", {
      code: options.code ?? DEFAULT_ERROR_CODE,
      context: options.context,
      retryable: options.retryable ?? false,
      cause: error
    });
  }

  if (typeof error === "string") {
    return new AppError(error, {
      code: options.code ?? DEFAULT_ERROR_CODE,
      context: options.context,
      retryable: options.retryable ?? false
    });
  }

  return new AppError(options.message ?? "Unexpected error", {
    code: options.code ?? DEFAULT_ERROR_CODE,
    context: options.context,
    retryable: options.retryable ?? false
  });
}
