/** An error whose message is safe to show a customer. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code = 'INTERNAL_ERROR',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Some of the details provided need checking.') {
    super(message, 400, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication required.') {
    super(message, 401, 'UNAUTHENTICATED');
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please wait a moment and try again.') {
    super(message, 429, 'RATE_LIMITED');
    this.name = 'RateLimitError';
  }
}

/** Generic customer-facing copy. Technical detail stays in the logs. */
/**
 * Shown when the booking itself could not be saved. It always offers a way
 * through, so a technical fault never costs CHFR the enquiry.
 */
export const GENERIC_ERROR_MESSAGE =
  'Something went wrong sending your request. Please try again — or message CHFR directly ' +
  'on Instagram @chfrldn and we will arrange your journey from there.';
