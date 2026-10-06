import type { NextFunction, Request, Response } from 'express';
import { db } from '../db/db.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import { permissionsFor } from './rbac.ts';
import { readSession } from './session.ts';

/** The authenticated principal attached to every protected request. */
export interface Actor {
  type: 'MEMBER' | 'SYSTEM';
  id: string | null;
  name: string;
  role: string;
  /** Organization whose data this request may touch — the isolation boundary. */
  organizationId: string;
  homeOrganizationId: string;
  permissions: Set<string>;
}

declare global {
  namespace Express { interface Request { actor?: Actor } }
}

export const SYSTEM_ACTOR = (organizationId: string): Actor => ({
  type: 'SYSTEM', id: null, name: 'QuickLoan System', role: 'system', organizationId, homeOrganizationId: organizationId, permissions: new Set(),
});

/** Resolve the session (if any) into req.actor. Never throws. */
export function attachActor(req: Request, _res: Response, next: NextFunction) {
  const s = readSession(req);
  if (s && s.principal_type === 'MEMBER') {
    const m = db.get(
      `SELECT m.id, m.organization_id, m.status, r.full_name FROM members m JOIN registry_members r ON r.id = m.registry_member_id WHERE m.id = ?`,
      s.principal_id,
    );
    if (m && m.status !== 'INACTIVE') {
      req.actor = {
        type: 'MEMBER', id: m.id, name: m.full_name, role: 'member', organizationId: m.organization_id,
        homeOrganizationId: m.organization_id, permissions: permissionsFor('member'),
      };
    }
  }
  next();
}

/** CSRF defence in depth (cookies are SameSite=Lax): mutating API calls must carry a custom header. */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['x-quickloan'] !== '1' && !req.headers['x-api-key']) {
    return next(forbidden('Request blocked.'));
  }
  next();
}

export const requireMember = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.actor) return next(unauthorized());
  if (req.actor.type !== 'MEMBER') return next(forbidden('This area is for members only.'));
  next();
};
