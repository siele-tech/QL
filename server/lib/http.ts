import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { AppError } from './errors.ts';

/** Wrap async handlers so rejections reach the error middleware (Express 4). */
export const h = (fn: (req: Request, res: Response, next: NextFunction) => any): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Validate input against a schema; the first issue becomes a clear 400 message. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue.path.join('.');
    throw new AppError(400, 'VALIDATION_ERROR', issue.message.startsWith('Expected') || issue.message === 'Required' ? `Please check ${field || 'your input'}.` : issue.message, { field });
  }
  return r.data;
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.userMessage, details: err.details } });
  }
  if (err instanceof ZodError) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Please check your input.' } });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid request.' } });
  // Unexpected: log server-side with a correlation id; never leak internals to clients.
  const ref = Math.random().toString(36).slice(2, 10).toUpperCase();
  console.error(`[error ${ref}] ${req.method} ${req.path}:`, err?.stack ?? err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.', ref } });
}

/** Tiny in-memory rate limiter (per key, sliding window). */
export function rateLimit(opts: { windowMs: number; max: number; key: (req: Request) => string }): RequestHandler {
  const hits = new Map<string, number[]>();
  return (req, _res, next) => {
    const k = opts.key(req);
    const now = Date.now();
    const arr = (hits.get(k) ?? []).filter((t) => now - t < opts.windowMs);
    arr.push(now);
    hits.set(k, arr);
    if (arr.length > opts.max) return next(new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a few minutes and try again.'));
    next();
  };
}

export const kesAmount = z.coerce.number({ invalid_type_error: 'Enter a valid amount.' }).int('Enter a whole amount in KES.').positive('Enter an amount greater than zero.').max(10_000_000, 'Amount is too large.');
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date.');
