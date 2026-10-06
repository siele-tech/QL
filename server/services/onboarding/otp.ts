import crypto from 'node:crypto';
import { config } from '../../config.ts';
import { db } from '../../db/db.ts';
import { AppError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { SYSTEM_ACTOR } from '../../auth/middleware.ts';
import { sendSms, smsProvider } from '../sms/smsService.ts';
import { MockJamiProvider } from '../sms/mockJami.ts';
import { localPhone } from '../sms/provider.ts';

/**
 * One-time codes by SMS.
 *
 * A verified code means exactly one thing: the person has access to that phone number right now.
 * It says nothing about whose name the SIM is registered under, and nothing here checks that —
 * members often use a line registered to a parent, spouse or sibling.
 *
 * Delivery goes through the SMS service, so the real Wakandi message service is used as soon as
 * it is configured. A dedicated OTP API can replace `deliver()` without touching callers.
 */
export type OtpPurpose = 'ACTIVATION' | 'PIN_RESET';

export const OTP = { digits: 6, ttlSeconds: 5 * 60, maxAttempts: 5, resendAfterSeconds: 60, maxSends: 5, maxChallengesPerHour: 6 };

const hashCode = (id: string, code: string) => crypto.createHmac('sha256', config.sessionSecret).update(`${id}:${code}`).digest('hex');
const newCode = () => String(crypto.randomInt(0, 10 ** OTP.digits)).padStart(OTP.digits, '0');
const secondsUntil = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 1000));

/** Demo only: with the mock SMS provider nothing reaches a phone, so the code is shown on screen. */
const revealForDemo = () => config.demoMode && smsProvider instanceof MockJamiProvider;

export interface OtpView { id: string; phone: string; resendInSeconds: number; expiresInSeconds: number; demoCode?: string }

const view = (c: any, code?: string): OtpView => ({
  id: c.id, phone: maskPhone(c.phone),
  resendInSeconds: secondsUntil(new Date(Date.parse(c.last_sent_at) + OTP.resendAfterSeconds * 1000).toISOString()),
  expiresInSeconds: secondsUntil(c.expires_at),
  ...(code && revealForDemo() ? { demoCode: code } : {}),
});

/** 0712 ••• ••• — enough for the owner to recognise the number, not enough to learn it. */
export function maskPhone(phone: string) {
  const l = localPhone(phone);
  return l.length >= 4 ? `${l.slice(0, 4)} ••• •••` : '•••• ••• •••';
}

async function deliver(c: any, code: string, send: boolean) {
  if (!send || !c.organization_id) return;
  const body = `${code} is your QuickLoan verification code. It expires in ${OTP.ttlSeconds / 60} minutes. Do not share it with anyone.`;
  const r = await sendSms({ organizationId: c.organization_id, phone: c.phone, body, type: 'NOTIFICATION', actor: SYSTEM_ACTOR(c.organization_id) });
  // The stored message must not keep a usable code.
  db.run('UPDATE sms_messages SET body = ? WHERE id = ?', body.replace(code, '••••••'), r.id);
  if (!r.accepted) throw new AppError(502, 'OTP_NOT_SENT', 'We could not send the code right now. Please try again in a moment.');
}

export const otpService = {
  /**
   * Start a challenge and send the code. `send: false` creates a challenge nobody can pass —
   * used so that callers can answer identically whether or not an account exists.
   */
  async start(purpose: OtpPurpose, subjectId: string, organizationId: string | null, phone: string, opts: { send?: boolean } = {}): Promise<OtpView> {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const recent = db.get('SELECT COUNT(*) AS n FROM otp_challenges WHERE purpose = ? AND subject_id = ? AND created_at > ?', purpose, subjectId, hourAgo)!.n as number;
    if (recent >= OTP.maxChallengesPerHour) throw new AppError(429, 'OTP_SEND_LIMIT', 'Too many codes have been requested. Please wait an hour and try again.');
    // Only one live challenge per subject.
    db.run('UPDATE otp_challenges SET consumed_at = ? WHERE purpose = ? AND subject_id = ? AND consumed_at IS NULL', new Date().toISOString(), purpose, subjectId);
    const id = newId('otp'), code = newCode(), now = new Date();
    const row = {
      id, purpose, subject_id: subjectId, organization_id: organizationId, phone, code_hash: hashCode(id, code),
      expires_at: new Date(now.getTime() + OTP.ttlSeconds * 1000).toISOString(), attempts: 0, send_count: 1, last_sent_at: now.toISOString(), created_at: now.toISOString(),
    };
    db.insert('otp_challenges', row);
    await deliver(row, code, opts.send !== false);
    return view(row, opts.send !== false ? code : undefined);
  },

  /** The live (not yet used) challenge for a subject, if any. */
  current(purpose: OtpPurpose, subjectId: string) {
    return db.get('SELECT * FROM otp_challenges WHERE purpose = ? AND subject_id = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1', purpose, subjectId) ?? null;
  },
  get: (id: string) => db.get('SELECT * FROM otp_challenges WHERE id = ?', id) ?? null,

  /** Send a fresh code for the same challenge (new code, new expiry, attempts reset). */
  async resend(id: string, opts: { send?: boolean } = {}): Promise<OtpView> {
    const c = db.get('SELECT * FROM otp_challenges WHERE id = ? AND consumed_at IS NULL', id);
    if (!c) throw new AppError(400, 'OTP_NOT_FOUND', 'Please start again to get a new code.');
    const wait = secondsUntil(new Date(Date.parse(c.last_sent_at) + OTP.resendAfterSeconds * 1000).toISOString());
    if (wait > 0) throw new AppError(429, 'OTP_RESEND_TOO_SOON', `Please wait ${wait} seconds before asking for another code.`, { retryInSeconds: wait });
    if (c.send_count >= OTP.maxSends) throw new AppError(429, 'OTP_SEND_LIMIT', 'Too many codes have been requested. Please wait an hour and try again.');
    const code = newCode(), now = new Date();
    const next = { ...c, code_hash: hashCode(id, code), expires_at: new Date(now.getTime() + OTP.ttlSeconds * 1000).toISOString(), attempts: 0, send_count: c.send_count + 1, last_sent_at: now.toISOString(), verified_at: null };
    db.update('otp_challenges', id, { code_hash: next.code_hash, expires_at: next.expires_at, attempts: 0, send_count: next.send_count, last_sent_at: next.last_sent_at, verified_at: null });
    await deliver(next, code, opts.send !== false);
    return view(next, opts.send !== false ? code : undefined);
  },

  /** Check a code. Throws a specific, user-safe error; returns the challenge once verified. */
  verify(id: string, code: string) {
    const c = db.get('SELECT * FROM otp_challenges WHERE id = ? AND consumed_at IS NULL', id);
    if (!c) throw new AppError(400, 'OTP_NOT_FOUND', 'Please start again to get a new code.');
    if (c.verified_at) return c;
    if (c.expires_at < new Date().toISOString()) throw new AppError(400, 'OTP_EXPIRED', 'This code has expired. Tap “Resend code” to get a new one.');
    if (c.attempts >= OTP.maxAttempts) throw new AppError(429, 'OTP_TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Tap “Resend code” to get a new one.');
    const given = hashCode(id, code.replace(/\D/g, ''));
    if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(c.code_hash))) {
      db.run('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?', id);
      const left = OTP.maxAttempts - c.attempts - 1;
      if (left <= 0) throw new AppError(429, 'OTP_TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Tap “Resend code” to get a new one.');
      throw new AppError(400, 'OTP_INCORRECT', `That code is not correct. You have ${left} ${left === 1 ? 'try' : 'tries'} left.`, { attemptsLeft: left });
    }
    const at = new Date().toISOString();
    db.update('otp_challenges', id, { verified_at: at });
    return { ...c, verified_at: at };
  },

  /** A verified challenge is used once. */
  consume: (id: string) => db.run('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?', new Date().toISOString(), id),
};
