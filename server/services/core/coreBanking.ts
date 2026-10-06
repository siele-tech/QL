import crypto from 'node:crypto';
import { config } from '../../config.ts';
import { db } from '../../db/db.ts';
import { clock } from '../../lib/clock.ts';
import { newId } from '../../lib/ids.ts';

/**
 * CORE BANKING (COMS) — QuickLoan never keeps the books. Every money event is sent to the
 * Wakandi core (accounts, loans, ledger) through this interface, from the server only.
 *
 *   QuickLoan engine → recordCoreEvent() → core_sync_log (outbox) → CoreBankingProvider → COMS
 *
 * The outbox makes sync observable and retryable (reconciliation). GL codes and ledger mappings
 * live in COMS, not here. Until COMS API documentation is available, the mock provider marks
 * events SYNCED with a simulated reference; a configured-but-unimplemented COMS leaves them PENDING.
 */
export type CoreEvent =
  | 'LOAN_CREATED' | 'DISBURSEMENT' | 'REPAYMENT' | 'LATE_FEE' | 'ROLLOVER' | 'LOAN_CLOSED' | 'LOAN_DEFAULTED' | 'CRB_FEE';

export interface CoreBankingProvider {
  readonly name: string;
  readonly simulated: boolean;
  /** Push one event to the core; returns the core's reference. */
  post(event: CoreEvent, payload: Record<string, unknown>): Promise<{ ok: boolean; externalRef?: string; error?: string; retryable?: boolean }>;
}

class MockCoreBanking implements CoreBankingProvider {
  readonly name = 'COMS_MOCK';
  readonly simulated = true;
  async post() { return { ok: true, externalRef: 'COMS-' + crypto.randomBytes(4).toString('hex').toUpperCase() }; }
}

/** Real COMS adapter: integration point — request mapping pending COMS API documentation. */
class ComsProvider implements CoreBankingProvider {
  readonly name = 'COMS';
  readonly simulated = false;
  async post() { return { ok: false, retryable: true, error: 'COMS integration pending API documentation' }; }
}

export const coreBanking: CoreBankingProvider = config.coms.apiUrl && config.coms.apiKey ? new ComsProvider() : new MockCoreBanking();

/** Record a money event for the core. Never throws into lending flows. */
export async function recordCoreEvent(orgId: string, event: CoreEvent, loanId: string | null, payload: Record<string, unknown>) {
  const id = newId('cor');
  db.insert('core_sync_log', { id, organization_id: orgId, event, loan_id: loanId, payload: JSON.stringify(payload), provider: coreBanking.name, status: 'PENDING', created_at: clock.nowIso() });
  try {
    const r = await coreBanking.post(event, { ...payload, loanId, eventId: id });
    db.update('core_sync_log', id, r.ok ? { status: 'SYNCED', external_ref: r.externalRef ?? null } : { status: r.retryable ? 'PENDING' : 'FAILED', error: r.error ?? null });
  } catch (e: any) {
    db.update('core_sync_log', id, { status: 'PENDING', error: e?.message ?? 'Core unreachable' });
  }
  return id;
}
export const recordCoreEventLater = (...a: Parameters<typeof recordCoreEvent>) => { recordCoreEvent(...a).catch(() => null); };

/** Reconciliation: retry PENDING events (daily job). Returns what is still outstanding. */
export async function reconcileCore(orgId?: string) {
  const pending = db.all(`SELECT * FROM core_sync_log WHERE status = 'PENDING' ${orgId ? 'AND organization_id = ?' : ''} ORDER BY created_at LIMIT 200`, ...(orgId ? [orgId] : []));
  let synced = 0;
  for (const p of pending) {
    const r = await coreBanking.post(p.event, { ...JSON.parse(p.payload), loanId: p.loan_id, eventId: p.id }).catch((e) => ({ ok: false, error: e?.message, retryable: true }));
    if (r.ok) { db.update('core_sync_log', p.id, { status: 'SYNCED', external_ref: (r as any).externalRef ?? null, error: null }); synced++; }
  }
  return { retried: pending.length, synced, stillPending: pending.length - synced };
}

export function coreSyncStatus(orgId: string) {
  const rows = db.all('SELECT status, COUNT(*) AS c, MAX(created_at) AS last FROM core_sync_log WHERE organization_id = ? GROUP BY status', orgId);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.c]));
  return { provider: coreBanking.name, simulated: coreBanking.simulated, synced: by.SYNCED ?? 0, pending: by.PENDING ?? 0, failed: by.FAILED ?? 0, lastEventAt: rows.reduce((m, r) => (r.last > m ? r.last : m), '') || null };
}
