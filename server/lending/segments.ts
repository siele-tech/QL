import { db, json } from '../db/db.ts';
import { clock, today } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import type { Actor } from '../auth/middleware.ts';
import { audit } from '../services/audit.ts';
import { localPhone } from '../services/sms/provider.ts';
import { memberFacts } from './eligibility.ts';

/**
 * SEGMENTS — dynamic, reusable groups of people (every imported member, with or without a
 * QuickLoan account). Rules are evaluated live, so a segment always reflects current data.
 * Used by quality checks, enabled loans (who can borrow), and communications.
 */
export const SEGMENT_FIELDS = {
  HAS_ACCOUNT: { label: 'Has a QuickLoan account', kind: 'boolean' },
  QUALITY_CHECKED: { label: 'Identity quality-checked', kind: 'boolean' },
  QUALITY_STATUS: { label: 'Quality check result', kind: 'choice', options: [['VERIFIED', 'Verified'], ['CORRECTED', 'Corrected'], ['REVIEWED', 'Reviewed'], ['NEEDS_REVIEW', 'Needs review'], ['NOT_CHECKED', 'Not checked']] },
  GENDER: { label: 'Gender', kind: 'choice', options: [['F', 'Female'], ['M', 'Male']] },
  AGE: { label: 'Age (years)', kind: 'number' },
  MEMBERSHIP_MONTHS: { label: 'Membership (months)', kind: 'number' },
  BEHAVIOUR_SCORE: { label: 'Behaviour score', kind: 'number' },
  CRB_SCORE: { label: 'CRB score', kind: 'number' },
  COMPLETED_LOANS: { label: 'Loans repaid on time', kind: 'number' },
  HAS_OPEN_LOAN: { label: 'Has an open loan', kind: 'boolean' },
  HAS_OVERDUE: { label: 'Has an overdue loan', kind: 'boolean' },
  SOURCE: { label: 'Imported from', kind: 'text' },
  MEMBER_ATTRIBUTE: { label: 'Organization criterion (attribute = value)', kind: 'text' },
} as const;
export type SegmentField = keyof typeof SEGMENT_FIELDS;
export interface SegmentRule { field: SegmentField; operator: 'IS' | 'GTE' | 'LTE' | 'EQ'; value: string }

export const QUALITY_LABEL: Record<string, string> = { VERIFIED: 'Verified', CORRECTED: 'Corrected', REVIEWED: 'Reviewed', NEEDS_REVIEW: 'Needs review', NOT_CHECKED: 'Not checked' };
const CHECKED = ['VERIFIED', 'CORRECTED', 'REVIEWED'];

export function ageOn(dob: string | null | undefined, on = today()) {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = on.split('-').map(Number);
  if (!y || !m || !d) return null;
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/** One person = a registry record (identity) plus their QuickLoan lending facts, if they have an account. */
export function personFacts(r: any, facts?: ReturnType<typeof memberFacts>) {
  const f = r.member_id ? facts ?? memberFacts(r.member_id) : null;
  return {
    registryId: r.id as string, memberId: (r.member_id ?? null) as string | null,
    name: r.full_name as string, memberNumber: r.member_number as string, idNumber: r.id_number as string,
    phone: r.member_phone ?? r.phone ?? null, gender: (r.gender ?? null) as string | null, dateOfBirth: r.date_of_birth ?? null, age: ageOn(r.date_of_birth),
    source: (r.source ?? 'REGISTRY') as string, qualityStatus: (r.quality_status ?? 'NOT_CHECKED') as string, qualityCheckedAt: r.quality_checked_at ?? null,
    hasAccount: !!r.member_id, accountStatus: r.member_status ?? null,
    membershipMonths: f ? f.membershipMonths : null, behaviourScore: f ? f.behaviourScore : null, crbScore: f ? f.crbScore : null,
    completedLoans: f ? f.onTimeLoans : 0, hasOpenLoan: f ? f.openLoans.length > 0 : false, hasOverdue: f ? f.hasOverdue : false,
    attributes: f ? f.attributes : {} as Record<string, string>,
  };
}
export type Person = ReturnType<typeof personFacts>;

const PEOPLE_SQL = `SELECT r.*, m.id AS member_id, m.phone AS member_phone, m.status AS member_status
  FROM registry_members r LEFT JOIN members m ON m.registry_member_id = r.id WHERE r.organization_id = ?`;

export function loadPeople(orgId: string, registryIds?: string[]): Person[] {
  const rows = registryIds
    ? db.all(`${PEOPLE_SQL} AND r.id IN (${registryIds.map(() => '?').join(',') || "''"})`, orgId, ...registryIds)
    : db.all(PEOPLE_SQL, orgId);
  return rows.map((r) => personFacts(r)).sort((a, b) => a.memberNumber.localeCompare(b.memberNumber, undefined, { numeric: true }));
}

export function evaluateSegmentRule(rule: SegmentRule, p: Person): boolean {
  const n = Number(rule.value);
  const num = (v: number | null) => v !== null && (rule.operator === 'LTE' ? v <= n : rule.operator === 'EQ' ? v === n : v >= n);
  const yes = rule.value === 'true';
  switch (rule.field) {
    case 'HAS_ACCOUNT': return p.hasAccount === yes;
    case 'QUALITY_CHECKED': return CHECKED.includes(p.qualityStatus) === yes;
    case 'QUALITY_STATUS': return p.qualityStatus === rule.value;
    case 'GENDER': return (p.gender ?? '').toUpperCase() === rule.value.toUpperCase();
    case 'AGE': return num(p.age);
    case 'MEMBERSHIP_MONTHS': return num(p.membershipMonths);
    case 'BEHAVIOUR_SCORE': return num(p.behaviourScore);
    case 'CRB_SCORE': return num(p.crbScore);
    case 'COMPLETED_LOANS': return num(p.completedLoans);
    case 'HAS_OPEN_LOAN': return p.hasOpenLoan === yes;
    case 'HAS_OVERDUE': return p.hasOverdue === yes;
    case 'SOURCE': return p.source.toLowerCase() === rule.value.trim().toLowerCase();
    case 'MEMBER_ATTRIBUTE': {
      const [k, v] = rule.value.split('=').map((s) => s.trim());
      return (p.attributes[k] ?? '').toLowerCase() === (v ?? '').toLowerCase();
    }
    default: return false;
  }
}

/** Human-readable rule, e.g. "Age (years) at least 18". */
export function describeRule(rule: SegmentRule) {
  const f = SEGMENT_FIELDS[rule.field] as any;
  if (!f) return rule.field;
  if (f.kind === 'boolean') return rule.value === 'true' ? f.label : `Not: ${f.label.toLowerCase()}`;
  if (f.kind === 'choice') return `${f.label}: ${f.options.find((o: string[]) => o[0] === rule.value)?.[1] ?? rule.value}`;
  if (f.kind === 'number') return `${f.label} ${rule.operator === 'LTE' ? 'at most' : rule.operator === 'EQ' ? 'exactly' : 'at least'} ${rule.value}`;
  return `${f.label}: ${rule.value}`;
}

export const matches = (rules: SegmentRule[], p: Person) => rules.every((r) => evaluateSegmentRule(r, p));

export function getSegment(orgId: string, id: string) {
  const s = db.get('SELECT * FROM segments WHERE id = ? AND organization_id = ?', id, orgId);
  if (!s) throw notFound('Segment');
  return { ...s, rules: json<SegmentRule[]>(s.rules, []) };
}

/** People in a segment (or matching an unsaved rule set). */
export function segmentPeople(orgId: string, rules: SegmentRule[], people = loadPeople(orgId)) {
  return people.filter((p) => matches(rules, p));
}

export function segmentSummary(orgId: string, s: any, people: Person[]) {
  const rules = typeof s.rules === 'string' ? json<SegmentRule[]>(s.rules, []) : s.rules;
  const inSeg = segmentPeople(orgId, rules, people);
  const usedBy = db.get(`SELECT COUNT(*) AS c FROM loan_offerings WHERE segment_id = ? AND status != 'ENDED'`, s.id)!.c;
  return {
    id: s.id, name: s.name, description: s.description, color: s.color, isSystem: !!s.is_system, rules, ruleText: rules.map(describeRule),
    size: inSeg.length, withAccount: inSeg.filter((p) => p.hasAccount).length, qualityChecked: inSeg.filter((p) => CHECKED.includes(p.qualityStatus)).length,
    usedByLoans: usedBy, updatedAt: s.updated_at,
  };
}

export function listSegments(orgId: string) {
  const people = loadPeople(orgId);
  return db.all('SELECT * FROM segments WHERE organization_id = ? ORDER BY is_system DESC, name', orgId).map((s) => segmentSummary(orgId, s, people));
}

export function personRow(p: Person) {
  return {
    registryId: p.registryId, memberId: p.memberId, name: p.name, memberNumber: p.memberNumber, idNumber: p.idNumber,
    phone: p.phone ? localPhone(p.phone) : null, gender: p.gender, age: p.age, source: p.source,
    qualityStatus: p.qualityStatus, qualityLabel: QUALITY_LABEL[p.qualityStatus] ?? p.qualityStatus, hasAccount: p.hasAccount,
    behaviourScore: p.behaviourScore, crbScore: p.crbScore, hasOpenLoan: p.hasOpenLoan, hasOverdue: p.hasOverdue,
  };
}

const SEGMENT_COLORS = ['teal', 'gold', 'terra', 'navy'];

export function saveSegment(actor: Actor, input: { id?: string; name: string; description?: string; color?: string; rules: SegmentRule[] }) {
  const name = input.name.trim();
  if (name.length < 2) throw badRequest('Give the segment a name.');
  for (const r of input.rules) if (!(r.field in SEGMENT_FIELDS)) throw badRequest('Unknown segment condition.');
  const dupe = db.get('SELECT id FROM segments WHERE organization_id = ? AND lower(name) = lower(?) AND id != ?', actor.organizationId, name, input.id ?? '');
  if (dupe) throw conflict('A segment with this name already exists.');
  const now = clock.nowIso();
  const color = SEGMENT_COLORS.includes(input.color ?? '') ? input.color! : 'teal';
  if (input.id) {
    const s = getSegment(actor.organizationId, input.id);
    if (s.is_system) throw badRequest('The built-in "All members" segment cannot be changed.');
    db.update('segments', s.id, { name, description: input.description ?? null, color, rules: JSON.stringify(input.rules), updated_at: now });
    audit(actor, 'SEGMENT_UPDATED', `Updated segment "${name}"`, { entityType: 'SEGMENT', entityId: s.id, details: input.rules });
    return s.id;
  }
  const id = newId('seg');
  db.insert('segments', { id, organization_id: actor.organizationId, name, description: input.description ?? null, color, rules: JSON.stringify(input.rules), is_system: 0, created_by: actor.id, created_at: now, updated_at: now });
  audit(actor, 'SEGMENT_CREATED', `Created segment "${name}"`, { entityType: 'SEGMENT', entityId: id, details: input.rules });
  return id;
}

export function deleteSegment(actor: Actor, id: string) {
  const s = getSegment(actor.organizationId, id);
  if (s.is_system) throw badRequest('The built-in "All members" segment cannot be deleted.');
  const used = db.get(`SELECT COUNT(*) AS c FROM loan_offerings WHERE segment_id = ? AND status != 'ENDED'`, id)!.c;
  if (used) throw conflict('This segment is used by an enabled loan. End or change that loan first.');
  db.run('DELETE FROM segments WHERE id = ?', id);
  audit(actor, 'SEGMENT_DELETED', `Deleted segment "${s.name}"`, { entityType: 'SEGMENT', entityId: id });
}

/** Every organization has a built-in "All members" segment. */
export function ensureAllMembersSegment(orgId: string) {
  const s = db.get('SELECT id FROM segments WHERE organization_id = ? AND is_system = 1', orgId);
  if (s) return s.id as string;
  const id = newId('seg');
  const now = clock.nowIso();
  db.insert('segments', { id, organization_id: orgId, name: 'All members', description: 'Everyone in your member list.', color: 'navy', rules: '[]', is_system: 1, created_at: now, updated_at: now });
  return id;
}

