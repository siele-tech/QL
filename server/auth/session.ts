import type { Request, Response } from 'express';
import { db } from '../db/db.ts';
import { config } from '../config.ts';
import { randomToken, sha256 } from '../lib/ids.ts';

export const SESSION_COOKIE = 'ql_session';

/** Sessions are opaque random tokens; only a keyed hash is stored server-side. */
const hashToken = (t: string) => sha256(config.sessionSecret + ':' + t);

export function createSession(res: Response, req: Request, principalType: 'MEMBER', principalId: string, organizationId: string) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionTtlHours * 3600_000);
  db.insert('sessions', {
    token_hash: hashToken(token), principal_type: principalType, principal_id: principalId, organization_id: organizationId,
    created_at: now.toISOString(), expires_at: expires.toISOString(), last_seen_at: now.toISOString(),
    ip: req.ip, user_agent: String(req.headers['user-agent'] ?? '').slice(0, 200),
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', expires,
  });
}

export function readSession(req: Request) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || typeof token !== 'string') return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', hashToken(token));
  if (!s) return null;
  if (s.expires_at < new Date().toISOString()) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
    return null;
  }
  // Sliding expiry: touch at most once per minute.
  if (Date.now() - Date.parse(s.last_seen_at) > 60_000) {
    const expires = new Date(Date.now() + config.sessionTtlHours * 3600_000).toISOString();
    db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?', new Date().toISOString(), expires, s.token_hash);
  }
  return s;
}

export function setSessionOrg(req: Request, organizationId: string) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) db.run('UPDATE sessions SET organization_id = ? WHERE token_hash = ?', organizationId, hashToken(token));
}

export function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export const purgeExpiredSessions = () => db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
