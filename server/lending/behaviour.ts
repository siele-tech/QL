import { db } from '../db/db.ts';
import { clock } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { getOrgSettings, type OrgSettings } from '../services/orgSettings.ts';

/**
 * QuickLoan Behaviour Score (0–100) — reflects repayment behaviour on QuickLoan only.
 * It is NOT a CRB score. The formula is isolated here and its weights live in organization
 * settings, so it can be tuned or replaced without touching the rest of the application.
 */
export const FORMULA_VERSION = 'v1-weighted';

export interface BehaviourInputs { completedLoans: number; onTime: number; early: number; late: number; currentOverdue: number; defaulted: number }

export function computeScore(i: BehaviourInputs, w: OrgSettings['behaviour']): number {
  const s = w.base
    + Math.min(w.onTimeCap, w.perOnTimeLoan * i.onTime)
    + Math.min(w.earlyCap, w.perEarly * i.early)
    - w.perLate * i.late
    - w.perCurrentOverdue * i.currentOverdue
    - w.perDefault * i.defaulted;
  return Math.max(0, Math.min(100, Math.round(s)));
}

export function behaviourInputs(memberId: string): BehaviourInputs {
  const r = db.get(
    `SELECT
       SUM(status = 'REPAID') AS completed,
       SUM(status = 'REPAID' AND repayment_outcome IN ('EARLY','ON_TIME')) AS on_time,
       SUM(status = 'REPAID' AND repayment_outcome = 'EARLY') AS early,
       SUM(status = 'REPAID' AND repayment_outcome = 'LATE') AS late,
       SUM(status = 'OVERDUE') AS overdue,
       SUM(defaulted_at IS NOT NULL OR status = 'DEFAULTED') AS defaulted
     FROM loans WHERE member_id = ?`, memberId,
  )!;
  return {
    completedLoans: r.completed ?? 0, onTime: r.on_time ?? 0, early: r.early ?? 0, late: r.late ?? 0,
    currentOverdue: r.overdue ?? 0, defaulted: r.defaulted ?? 0,
  };
}

/** Recompute and persist the member's score; records history when it changes. */
export function recomputeBehaviour(memberId: string, reason: string, at = clock.nowIso()) {
  const m = db.get('SELECT organization_id FROM members WHERE id = ?', memberId);
  if (!m) return null;
  const inputs = behaviourInputs(memberId);
  const score = computeScore(inputs, getOrgSettings(m.organization_id).behaviour);
  const prev = db.get('SELECT score FROM behaviour_scores WHERE member_id = ?', memberId);
  db.run(
    `INSERT INTO behaviour_scores (member_id, organization_id, score, completed_loans, on_time_payments, early_payments, late_payments, overdue_loans, defaulted_loans, formula_version, last_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(member_id) DO UPDATE SET score=excluded.score, completed_loans=excluded.completed_loans, on_time_payments=excluded.on_time_payments,
       early_payments=excluded.early_payments, late_payments=excluded.late_payments, overdue_loans=excluded.overdue_loans,
       defaulted_loans=excluded.defaulted_loans, formula_version=excluded.formula_version, last_updated=excluded.last_updated`,
    memberId, m.organization_id, score, inputs.completedLoans, inputs.onTime, inputs.early, inputs.late, inputs.currentOverdue, inputs.defaulted, FORMULA_VERSION, at,
  );
  if (!prev || prev.score !== score) db.insert('behaviour_history', { id: newId('bhv'), member_id: memberId, score, reason, created_at: at });
  return { score, ...inputs };
}

export function getBehaviour(memberId: string) {
  const row = db.get('SELECT * FROM behaviour_scores WHERE member_id = ?', memberId);
  if (row) return row;
  recomputeBehaviour(memberId, 'Initial score');
  return db.get('SELECT * FROM behaviour_scores WHERE member_id = ?', memberId)!;
}

export function scoreBand(score: number) {
  if (score >= 80) return { label: 'Excellent', tone: 'good' };
  if (score >= 65) return { label: 'Good', tone: 'good' };
  if (score >= 50) return { label: 'Fair', tone: 'neutral' };
  return { label: 'Needs attention', tone: 'warn' };
}

/**
 * Responsible gamification: achievements reward repayment behaviour only — never borrowing volume.
 */
export function achievements(memberId: string) {
  const b = behaviourInputs(memberId);
  const score = getBehaviour(memberId).score;
  const first = db.get(`SELECT repaid_at FROM loans WHERE member_id = ? AND status='REPAID' AND repayment_outcome IN ('EARLY','ON_TIME') ORDER BY repaid_at LIMIT 1`, memberId);
  const firstEarly = db.get(`SELECT repaid_at FROM loans WHERE member_id = ? AND status='REPAID' AND repayment_outcome = 'EARLY' ORDER BY repaid_at LIMIT 1`, memberId);
  const third = db.all(`SELECT repaid_at FROM loans WHERE member_id = ? AND status='REPAID' AND repayment_outcome IN ('EARLY','ON_TIME') ORDER BY repaid_at LIMIT 3`, memberId)[2];
  const clean = b.late === 0 && b.defaulted === 0 && b.currentOverdue === 0;
  const list = [
    { key: 'RELIABLE_BORROWER', title: 'Reliable Borrower', description: 'Completed your first loan successfully.', earned: b.onTime >= 1, earnedAt: first?.repaid_at ?? null, progress: Math.min(1, b.onTime), target: 1 },
    { key: 'CONSISTENT_REPAYER', title: 'Consistent Repayer', description: 'Completed 3 loans on time.', earned: b.onTime >= 3, earnedAt: third?.repaid_at ?? null, progress: Math.min(3, b.onTime), target: 3 },
    { key: 'EARLY_REPAYER', title: 'Early Repayer', description: 'Repaid a loan before its due date.', earned: b.early >= 1, earnedAt: firstEarly?.repaid_at ?? null, progress: Math.min(1, b.early), target: 1 },
    { key: 'RESPONSIBLE_BORROWER', title: 'Responsible Borrower', description: 'Kept a strong repayment history: 5 on-time loans, none late.', earned: b.onTime >= 5 && clean, earnedAt: null, progress: clean ? Math.min(5, b.onTime) : 0, target: 5 },
  ];
  const next = list.find((a) => !a.earned) ?? null;
  const active = db.get(`SELECT id FROM loans WHERE member_id = ? AND status IN ('ACTIVE','DUE','ROLLED_OVER')`, memberId);
  const overdue = db.get(`SELECT id FROM loans WHERE member_id = ? AND status IN ('OVERDUE','DEFAULTED')`, memberId);
  let tip: string;
  if (overdue) tip = 'Clearing your overdue balance is the most important step to rebuild your repayment history.';
  else if (active) tip = score >= 80 ? 'Complete your current loan on time to maintain your strong repayment history.' : 'Repaying your current loan on or before the due date will strengthen your repayment history.';
  else if (next) tip = `Next milestone: ${next.title} — ${next.description.toLowerCase()}`;
  else tip = 'You have earned every milestone. Keep repaying on time to maintain your history.';
  return { list, next, tip };
}

/**
 * Repayment progress shown to the member: on-time rate, current on-time streak and a level.
 * Levels describe repayment habits only — they are earned by repaying on time, never by borrowing
 * more, and they do not promise a higher limit.
 */
export const LEVELS = [
  { name: 'New member', onTime: 0, minScore: 0, about: 'Repay your first loan on time to start building your record.' },
  { name: 'Getting started', onTime: 1, minScore: 0, about: 'You have repaid a loan on time.' },
  { name: 'Reliable', onTime: 3, minScore: 65, about: 'You repay on time, loan after loan.' },
  { name: 'Trusted', onTime: 5, minScore: 80, about: 'A long, clean repayment record.' },
] as const;

export function repaymentProgress(memberId: string) {
  const b = behaviourInputs(memberId);
  const score = getBehaviour(memberId).score as number;
  const repaid = db.all(`SELECT repayment_outcome FROM loans WHERE member_id = ? AND status = 'REPAID' ORDER BY repaid_at DESC`, memberId);
  let streak = 0;
  if (!b.currentOverdue && !b.defaulted) for (const l of repaid) { if (l.repayment_outcome === 'LATE') break; streak++; }
  let index = 0;
  LEVELS.forEach((l, i) => { if (b.onTime >= l.onTime && score >= l.minScore) index = i; });
  const next = LEVELS[index + 1] ?? null;
  return {
    onTimeRate: b.completedLoans ? Math.round((b.onTime / b.completedLoans) * 100) : null,
    streak,
    level: {
      index, total: LEVELS.length, name: LEVELS[index].name, about: LEVELS[index].about,
      next: next ? {
        name: next.name, onTimeNeeded: Math.max(0, next.onTime - b.onTime), scoreNeeded: next.minScore,
        progressPct: Math.min(100, Math.round((Math.min(b.onTime, next.onTime) / next.onTime) * 100)),
        hint: b.onTime < next.onTime
          ? `Repay ${next.onTime - b.onTime} more loan${next.onTime - b.onTime === 1 ? '' : 's'} on time to reach "${next.name}".`
          : `Keep your score at ${next.minScore} or above to reach "${next.name}".`,
      } : null,
    },
  };
}
