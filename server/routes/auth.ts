import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { db } from '../db/db.ts';
import { AppError, badRequest, unauthorized } from '../lib/errors.ts';
import { h, parse, rateLimit } from '../lib/http.ts';
import { verifySecret } from '../auth/password.ts';
import { createSession, destroySession } from '../auth/session.ts';
import { permissionsFor } from '../auth/rbac.ts';
import { audit } from '../services/audit.ts';
import { normalizeKePhone } from '../services/sms/provider.ts';
import { activationService, pinResetService } from '../services/onboarding/activation.ts';
import type { Actor } from '../auth/middleware.ts';

export const authRouter = Router();

const LOCK_AFTER = 5, LOCK_MINUTES = 15;
const loginLimiter = rateLimit({ windowMs: 10 * 60_000, max: 30, key: (req) => 'login:' + req.ip });

function lockedMessage(until: string) {
  const mins = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60_000));
  return `Too many incorrect attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
}

function registerFailure(row: any) {
  const attempts = row.failed_attempts + 1;
  const lock = attempts >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
  db.run('UPDATE members SET failed_attempts = ?, locked_until = ? WHERE id = ?', lock ? 0 : attempts, lock, row.id);
}

// ── Member login: phone + 4-digit PIN ──
authRouter.post('/member/login', loginLimiter, h(async (req, res) => {
  const body = parse(z.object({ phone: z.string().min(9, 'Enter your phone number.'), pin: z.string().min(4, 'Enter your 4-digit PIN.'), organizationId: z.string().optional() }), req.body);
  const phone = normalizeKePhone(body.phone);
  if (!phone) throw badRequest('Enter a valid Kenyan phone number, e.g. 0712 345 678.');
  let candidates = db.all('SELECT * FROM members WHERE phone = ?', phone);
  if (body.organizationId) candidates = candidates.filter((m) => m.organization_id === body.organizationId);
  const locked = candidates.find((m) => m.locked_until && m.locked_until > new Date().toISOString());
  if (locked) throw new AppError(423, 'LOCKED', lockedMessage(locked.locked_until));
  const matches = candidates.filter((m) => verifySecret(body.pin, m.pin_hash));
  if (!matches.length) {
    candidates.forEach(registerFailure);
    throw unauthorized('Incorrect phone number or PIN.');
  }
  if (matches.length > 1) {
    const orgs = matches.map((m) => db.get('SELECT id, name FROM organizations WHERE id = ?', m.organization_id));
    throw new AppError(409, 'CHOOSE_ORGANIZATION', 'You are a member of more than one lender. Choose one to continue.', { organizations: orgs });
  }
  const m = matches[0];
  if (m.status === 'INACTIVE') throw unauthorized('This account is not active. Please contact your lender.');
  db.run('UPDATE members SET failed_attempts = 0, locked_until = NULL WHERE id = ?', m.id);
  createSession(res, req, 'MEMBER', m.id, m.organization_id);
  res.json({ ok: true, redirect: '/member' });
}));

authRouter.post('/logout', h(async (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
}));

authRouter.get('/me', h(async (req, res) => {
  const a = req.actor;
  if (!a) return res.json({ authenticated: false });
  const org = db.get('SELECT id, name, type, code FROM organizations WHERE id = ?', a.organizationId);
  const role = db.get('SELECT name FROM roles WHERE key = ?', a.role);
  res.json({
    authenticated: true,
    principal: { type: a.type, id: a.id, name: a.name, role: a.role, roleName: role?.name ?? a.role, permissions: [...a.permissions] },
    organization: org, home: '/member', demoMode: config.demoMode,
  });
}));

// ── Member onboarding: a personal invitation → National ID → phone code → PIN ──
// The routes only translate HTTP; the rules live in services/onboarding.
const perIp = (name: string, max: number) => rateLimit({ windowMs: 10 * 60_000, max, key: (r) => `${name}:${r.ip}` });
const stepToken = z.string().min(10, 'Please confirm your National ID again to continue.');

authRouter.get('/invitations/:token', perIp('invite-open', 60), h(async (req, res) => {
  res.json(activationService.details(req.params.token));
}));

authRouter.post('/invitations/:token/identity', perIp('invite-id', 20), h(async (req, res) => {
  const body = parse(z.object({ idNumber: z.string().trim().min(4, 'Enter your National ID number.').max(20) }), req.body);
  res.json(activationService.verifyIdentity(req.params.token, body.idNumber));
}));

authRouter.post('/invitations/:token/phone', perIp('invite-phone', 20), h(async (req, res) => {
  const body = parse(z.object({ activationToken: stepToken, useRecorded: z.boolean().optional(), phone: z.string().max(20).optional() }), req.body);
  res.json(await activationService.choosePhone(req.params.token, body.activationToken, body));
}));

authRouter.post('/invitations/:token/otp/resend', perIp('invite-otp', 40), h(async (req, res) => {
  const body = parse(z.object({ activationToken: stepToken }), req.body);
  res.json(await activationService.resendCode(req.params.token, body.activationToken));
}));

authRouter.post('/invitations/:token/otp/verify', perIp('invite-otp', 40), h(async (req, res) => {
  const body = parse(z.object({ activationToken: stepToken, code: z.string().trim().min(6, 'Enter the 6-digit code.').max(12) }), req.body);
  res.json(activationService.verifyCode(req.params.token, body.activationToken, body.code));
}));

authRouter.post('/invitations/:token/activate', perIp('invite-activate', 20), h(async (req, res) => {
  const body = parse(z.object({
    activationToken: stepToken, pin: z.string(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'Please accept the QuickLoan terms.' }) }),
    dataConsent: z.literal(true, { errorMap: () => ({ message: 'Please allow QuickLoan to process your data.' }) }), crbConsent: z.boolean().default(false),
  }), req.body);
  const out = activationService.activate(req.params.token, body.activationToken, body);
  createSession(res, req, 'MEMBER', out.memberId, out.organizationId);
  res.status(201).json({ ok: true, redirect: '/member', firstName: out.firstName, phoneUpdatePending: out.phoneUpdatePending });
}));

// ── Forgot PIN: phone + National ID → code → new PIN ──
authRouter.post('/member/pin-reset/start', perIp('pin-reset', 10), h(async (req, res) => {
  const body = parse(z.object({ phone: z.string().min(9, 'Enter your phone number.').max(20), idNumber: z.string().trim().min(4, 'Enter your National ID number.').max(20) }), req.body);
  const otp = await pinResetService.start(body.phone, body.idNumber);
  res.json({ resetId: otp.id, phone: otp.phone, resendInSeconds: otp.resendInSeconds, expiresInSeconds: otp.expiresInSeconds, demoCode: otp.demoCode });
}));

authRouter.post('/member/pin-reset/resend', perIp('pin-reset-otp', 30), h(async (req, res) => {
  const body = parse(z.object({ resetId: z.string().min(5) }), req.body);
  const otp = await pinResetService.resend(body.resetId);
  res.json({ resetId: otp.id, phone: otp.phone, resendInSeconds: otp.resendInSeconds, expiresInSeconds: otp.expiresInSeconds, demoCode: otp.demoCode });
}));

authRouter.post('/member/pin-reset/complete', perIp('pin-reset-otp', 30), h(async (req, res) => {
  const body = parse(z.object({ resetId: z.string().min(5), code: z.string().trim().min(6, 'Enter the 6-digit code.').max(12), pin: z.string() }), req.body);
  const m = pinResetService.complete(body.resetId, body.code, body.pin);
  if (m) createSession(res, req, 'MEMBER', m.memberId, m.organizationId);
  res.json({ ok: true, signedIn: !!m, redirect: m ? '/member' : '/member/login' });
}));
