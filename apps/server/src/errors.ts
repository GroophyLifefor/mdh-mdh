/** An error that is safe to show to the client. Anything else becomes a plain 500. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const passwordRequired = () => new AppError(401, 'password_required', 'This project needs a password');
export const unauthorized = (message = 'Not signed in') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(429, 'too_many_requests', `Too many attempts. Try again in ${retryAfterSeconds} seconds.`, { retryAfterSeconds });
