import crypto from 'node:crypto';
import { config } from '../../config.ts';
import { db, json } from '../../db/db.ts';
import { clock } from '../../lib/clock.ts';
import { newId } from '../../lib/ids.ts';
import { AppError, badRequest } from '../../lib/errors.ts';
import type { Actor } from '../../auth/middleware.ts';
import { audit } from '../audit.ts';
import { CRB_PROVIDERS, CrbProviderError, type CrbCheckResult, type CrbProvider, type CrbProviderKey, type CrbSubject } from './types.ts';
import { SimulatedBureau } from './providers/simulated.ts';
import { EmbeddedCrbProvider } from './providers/embedded.ts';

/**
 * CRB SERVICE — reusable, provider-agnostic credit bureau service.
 *
 *   Consumer (QuickLoan)  →  CrbService  →  Embedded CRB adapter  →  Company CRB
 *
 * Responsibilities: provider selection & configuration, consent enforcement, lookup, standardized
 * result, encrypted raw-response storage, cost tracking, error handling and audit trail.
 */
const live: Record<CrbProviderKey, CrbProvider> = {
  EMBEDDED: new EmbeddedCrbProvider(),
};

/**
 * Startup: every organization uses the embedded CRB. Earlier data recorded checks against
 * individual bureaus (all simulated); relabel them so history stays readable.
 */
export function ensureEmbeddedCrb() {
  const keys = Object.keys(CRB_PROVIDERS);
  const marks = keys.map(() => '?').join(',');
  db.tx(() => {
    db.run(`UPDATE crb_checks SET provider = 'EMBEDDED' WHERE provider NOT IN (${marks})`, ...keys);
    db.run(`UPDATE crb_raw_responses SET provider = 'EMBEDDED' WHERE provider NOT IN (${marks})`, ...keys);
    db.run(`DELETE FROM crb_provider_configs WHERE provider NOT IN (${marks})`, ...keys);
    for (const o of db.all('SELECT id FROM organizations')) {
      if (!db.get(`SELECT 1 FROM crb_provider_configs WHERE organization_id = ? AND provider = 'EMBEDDED'`, o.id)) {
        db.insert('crb_provider_configs', { organization_id: o.id, provider: 'EMBEDDED', enabled: 1, is_default: 1, cost_per_check_cents: 0, updated_at: clock.nowIso() });
      }
    }
  });
}

function resolveProvider(key: CrbProviderKey): CrbProvider {
  const p = live[key];
  if (p.isConfigured()) return p;
  if (config.demoMode) return new SimulatedBureau(key);
  throw new CrbProviderError('NOT_CONFIGURED', `${key} not configured`);
}

// ---- raw response encryption at rest (AES-256-GCM) ----
const rawKey = crypto.createHash('sha256').update(config.sessionSecret + ':crb-raw').digest();
function encrypt(obj: unknown) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', rawKey, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
export function decryptRaw(payload: string) {
  const [iv, tag, data] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', rawKey, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

// ---- provider configuration per organization ----
export function providerConfigs(orgId: string) {
  const rows = db.all('SELECT * FROM crb_provider_configs WHERE organization_id = ?', orgId);
  return (Object.keys(CRB_PROVIDERS) as CrbProviderKey[]).map((key) => {
    const r = rows.find((x) => x.provider === key);
    return {
      provider: key, name: CRB_PROVIDERS[key].name, notes: CRB_PROVIDERS[key].notes,
      enabled: !!r?.enabled, isDefault: !!r?.is_default, costPerCheckCents: r?.cost_per_check_cents ?? 0,
      liveConfigured: live[key].isConfigured(), mode: live[key].isConfigured() ? 'LIVE' : config.demoMode ? 'SIMULATED' : 'NOT_CONFIGURED',
    };
  });
}

export function updateProviderConfig(actor: Actor, provider: CrbProviderKey, patch: { enabled?: boolean; isDefault?: boolean; costPerCheckCents?: number }) {
  if (!CRB_PROVIDERS[provider]) throw badRequest('Unknown CRB provider.');
  const org = actor.organizationId;
  db.tx(() => {
    const existing = db.get('SELECT * FROM crb_provider_configs WHERE organization_id = ? AND provider = ?', org, provider);
    if (!existing) db.insert('crb_provider_configs', { organization_id: org, provider, enabled: 0, is_default: 0, cost_per_check_cents: 0, updated_at: clock.nowIso() });
    if (patch.isDefault) db.run('UPDATE crb_provider_configs SET is_default = 0 WHERE organization_id = ?', org);
    db.run(
      `UPDATE crb_provider_configs SET enabled = COALESCE(?, enabled), is_default = COALESCE(?, is_default), cost_per_check_cents = COALESCE(?, cost_per_check_cents), updated_at = ?
       WHERE organization_id = ? AND provider = ?`,
      patch.enabled === undefined ? null : patch.enabled ? 1 : 0, patch.isDefault === undefined ? null : patch.isDefault ? 1 : 0,
      patch.costPerCheckCents ?? null, clock.nowIso(), org, provider,
    );
  });
  audit(actor, 'CRB_PROVIDER_UPDATED', `Updated CRB provider ${CRB_PROVIDERS[provider].name}`, { entityType: 'CRB_PROVIDER', entityId: provider, details: patch });
  return providerConfigs(org);
}

// ---- standardized mapping ----
export function toResult(r: any): CrbCheckResult {
  const key = r.provider as CrbProviderKey;
  return {
    id: r.id, provider: key, providerName: CRB_PROVIDERS[key]?.name ?? key, status: r.status, score: r.score ?? null, grade: r.grade ?? null,
    summary: json(r.summary, null), reference: r.report_reference ?? null, checkedAt: r.checked_at, simulated: !!json<any>(r.summary, {})?.simulated || r.raw_simulated === 1,
    costCents: r.cost_cents, ...(r.status === 'FAILED' ? { error: { code: r.error_code, message: 'Credit check could not be completed. Please try again.' } } : {}),
  };
}

export const latestCompletedCheck = (memberId: string) =>
  db.get(`SELECT * FROM crb_checks WHERE member_id = ? AND status = 'COMPLETED' ORDER BY checked_at DESC LIMIT 1`, memberId);

/**
 * Run a CRB check. Consent is mandatory: for QuickLoan members it must exist as an active
 * CRB_CHECK consent; external consumers must pass the reference of consent they captured.
 */
export async function runCrbCheck(opts: {
  actor: Actor; subject: CrbSubject & { fullName?: string }; memberId?: string | null; consentReference?: string;
  provider?: CrbProviderKey; source?: 'QUICKLOAN' | 'CRB_APP' | 'API' | 'MEMBER'; ip?: string;
}): Promise<CrbCheckResult> {
  const org = opts.actor.organizationId;
  let consentRef = opts.consentReference;
  if (opts.memberId) {
    const consent = db.get(
      `SELECT reference FROM member_consents WHERE member_id = ? AND type = 'CRB_CHECK' AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1`, opts.memberId,
    );
    if (!consent) throw new AppError(422, 'CRB_CONSENT_MISSING', 'This member has not given consent for a credit bureau check.');
    consentRef = consent.reference;
  }
  if (!consentRef) throw new AppError(422, 'CRB_CONSENT_MISSING', 'A consent reference is required for a credit bureau check.');

  const configs = providerConfigs(org).filter((c) => c.enabled);
  const chosen = opts.provider ? configs.find((c) => c.provider === opts.provider) : configs.find((c) => c.isDefault) ?? configs[0];
  if (!chosen) throw new AppError(422, 'CRB_NO_PROVIDER', 'CRB checks are switched off for your organization.');

  const id = newId('crb');
  const base = {
    id, organization_id: org, member_id: opts.memberId ?? null, subject_id_number: opts.subject.idNumber, subject_name: opts.subject.fullName ?? null,
    provider: chosen.provider, consent_reference: consentRef, source: opts.source ?? 'QUICKLOAN',
    requested_by_type: opts.actor.type, requested_by_id: opts.actor.id, checked_at: clock.nowIso(),
  };
  try {
    const provider = resolveProvider(chosen.provider);
    const r = await provider.checkScore({ subject: opts.subject, consentReference: consentRef, requestReference: id });
    const rawId = newId('crr');
    db.tx(() => {
      db.insert('crb_raw_responses', { id: rawId, check_id: id, provider: chosen.provider, payload_encrypted: encrypt(r.raw), created_at: clock.nowIso() });
      db.insert('crb_checks', {
        ...base, status: 'COMPLETED', score: r.score, grade: r.grade, summary: JSON.stringify({ ...r.summary, simulated: !!r.simulated }),
        report_reference: r.reportReference, raw_response_ref: rawId, cost_cents: chosen.costPerCheckCents,
      });
    });
    audit(opts.actor, 'CRB_CHECKED', `CRB check (${CRB_PROVIDERS[chosen.provider].name}) completed for ID ••••${opts.subject.idNumber.slice(-3)}`,
      { entityType: opts.memberId ? 'MEMBER' : 'CRB_SUBJECT', entityId: opts.memberId ?? undefined, details: { checkId: id, provider: chosen.provider, source: base.source }, ip: opts.ip });
  } catch (e: any) {
    const code = e instanceof CrbProviderError ? e.code : 'UNAVAILABLE';
    console.warn(`[crb] check ${id} failed: ${code}`); // never log subject data or payloads
    db.insert('crb_checks', { ...base, status: 'FAILED', error_code: code, cost_cents: 0 });
    audit(opts.actor, 'CRB_CHECK_FAILED', `CRB check (${CRB_PROVIDERS[chosen.provider].name}) failed: ${code}`,
      { entityType: opts.memberId ? 'MEMBER' : 'CRB_SUBJECT', entityId: opts.memberId ?? undefined, details: { checkId: id, code }, ip: opts.ip });
    const msg = code === 'NOT_FOUND' ? 'No credit record was found for this person.' : 'Credit check could not be completed. Please try again.';
    throw new AppError(code === 'NOT_FOUND' ? 404 : 502, `CRB_${code}`, msg, { checkId: id });
  }
  return toResult(db.get('SELECT * FROM crb_checks WHERE id = ?', id));
}
