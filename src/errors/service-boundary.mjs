import { AppError, toAppError } from "./index.mjs";

export function rethrowServiceError(error, message, context) {
  if (error instanceof AppError) {
    throw error;
  }

  throw toAppError(error, {
    message,
    context,
    retryable: false
  });
}
