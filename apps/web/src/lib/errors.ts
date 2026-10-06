import { ApiError } from './api';

/** A sentence for a person. The server's own messages are already written for people, so they pass through. */
export function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return e.message;
    if (e.status === 429) return e.message; // "Too many attempts. Try again in N seconds."
    if (e.status >= 500) return 'The server had a problem. Try again in a moment.';
    return e.message;
  }
  return 'Something went wrong.';
}

/** True when the server says this caller is not (or no longer) allowed in: the page should ask for the password again. */
export const lostAccess = (e: unknown) => e instanceof ApiError && e.status === 401 && (e.code === 'password_required' || e.code === 'invalid_token');
