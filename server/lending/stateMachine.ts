import { db } from '../db/db.ts';
import { clock } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { AppError } from '../lib/errors.ts';
import type { Actor } from '../auth/middleware.ts';

/**
 * QuickLoan lifecycle:
 *
 *   INVITED → APPLIED → UNDER_REVIEW → APPROVED → DISBURSING → ACTIVE → DUE → REPAID
 *   alternatives: REJECTED, OVERDUE, DEFAULTED, ROLLED_OVER
 *
 * The lifecycle spans three records — LoanOffer (INVITED/OPENED), LoanApplication
 * (APPLIED … DISBURSING, then DISBURSED as its hand-off marker) and Loan (ACTIVE … REPAID).
 * Every status change goes through `transition`, which rejects invalid moves and writes history.
 */
export type OfferStatus = 'INVITED' | 'OPENED' | 'APPLIED' | 'EXPIRED';
export type ApplicationStatus = 'APPLIED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'DISBURSING' | 'DISBURSED';
export type LoanStatus = 'ACTIVE' | 'DUE' | 'OVERDUE' | 'REPAID' | 'DEFAULTED' | 'ROLLED_OVER';

const OFFER: Record<OfferStatus, OfferStatus[]> = {
  INVITED: ['OPENED', 'APPLIED', 'EXPIRED'],
  OPENED: ['APPLIED', 'EXPIRED'],
  APPLIED: [],
  EXPIRED: [],
};
const APPLICATION: Record<ApplicationStatus, ApplicationStatus[]> = {
  APPLIED: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['DISBURSING', 'REJECTED'],
  DISBURSING: ['DISBURSED', 'APPROVED'], // APPROVED = disbursement failed, may retry
  DISBURSED: [],
  REJECTED: [],
};
const LOAN: Record<LoanStatus, LoanStatus[]> = {
  ACTIVE: ['DUE', 'OVERDUE', 'REPAID', 'ROLLED_OVER'],
  ROLLED_OVER: ['DUE', 'OVERDUE', 'REPAID', 'ROLLED_OVER'],
  DUE: ['REPAID', 'OVERDUE', 'ROLLED_OVER'],
  OVERDUE: ['REPAID', 'DEFAULTED', 'ROLLED_OVER'],
  DEFAULTED: ['REPAID'],
  REPAID: [],
};

export const MACHINES = { OFFER, APPLICATION, LOAN } as const;
export type Entity = keyof typeof MACHINES;

const TABLE: Record<Entity, string> = { OFFER: 'loan_offers', APPLICATION: 'loan_applications', LOAN: 'loans' };

export function canTransition(entity: Entity, from: string, to: string) {
  return ((MACHINES[entity] as Record<string, string[]>)[from] ?? []).includes(to);
}

export const REPAYABLE: LoanStatus[] = ['ACTIVE', 'DUE', 'OVERDUE', 'ROLLED_OVER', 'DEFAULTED'];
export const OPEN_LOAN: LoanStatus[] = REPAYABLE;
export const PENDING_APPLICATION: ApplicationStatus[] = ['APPLIED', 'UNDER_REVIEW', 'APPROVED', 'DISBURSING'];

/** Move an entity to a new status (must be inside a transaction when combined with other writes). */
export function transition(entity: Entity, id: string, to: string, actor: Actor, note?: string, extra: Record<string, any> = {}) {
  const row = db.get(`SELECT id, status, organization_id FROM ${TABLE[entity]} WHERE id = ?`, id);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Record not found.');
  if (!canTransition(entity, row.status, to)) {
    throw new AppError(409, 'INVALID_TRANSITION', `This ${entity.toLowerCase()} cannot move from ${row.status.replace('_', ' ').toLowerCase()} to ${to.replace('_', ' ').toLowerCase()}.`);
  }
  const patch: Record<string, any> = { status: to, ...extra };
  if (entity !== 'OFFER') patch.updated_at = clock.nowIso();
  db.update(TABLE[entity], id, patch);
  recordHistory(entity, id, row.organization_id, row.status, to, actor, note);
}

export function recordHistory(entity: Entity, id: string, orgId: string, from: string | null, to: string, actor: Actor, note?: string, at = clock.nowIso()) {
  db.insert('status_history', {
    id: newId('sth'), organization_id: orgId, entity_type: entity, entity_id: id, from_status: from, to_status: to,
    actor_type: actor.type, actor_id: actor.id, actor_name: actor.name, note: note ?? null, created_at: at,
  });
}
