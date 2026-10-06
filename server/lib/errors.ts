/** Errors carry a safe, user-facing message. Raw internals are logged server-side, never returned. */
export class AppError extends Error {
  constructor(public status: number, public code: string, public userMessage: string, public details?: unknown) {
    super(userMessage);
  }
}
export const badRequest = (msg: string, code = 'BAD_REQUEST', details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Please sign in to continue.') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (msg: string, code = 'CONFLICT') => new AppError(409, code, msg);
