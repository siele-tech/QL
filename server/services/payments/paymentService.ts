import { config } from '../../config.ts';
import { db } from '../../db/db.ts';
import { clock } from '../../lib/clock.ts';
import { newId } from '../../lib/ids.ts';
import type { Actor } from '../../auth/middleware.ts';
import type { PaymentProvider } from './provider.ts';
import { MockPaymentProvider } from './mockProvider.ts';
import { MpesaDarajaProvider } from './mpesaDaraja.ts';
import { WakandiPayProvider } from './wakandiPay.ts';

/** PAYMENT_PROVIDER picks the rail; default: M-PESA when configured, otherwise the mock (demo). */
function pickProvider(): PaymentProvider {
  const want = config.paymentProvider.toLowerCase();
  if (want === 'wakandipay' && WakandiPayProvider.configured()) return new WakandiPayProvider();
  if ((want === 'mpesa' || !want) && config.mpesa.consumerKey && config.mpesa.consumerSecret) return new MpesaDarajaProvider();
  return new MockPaymentProvider();
}
export const paymentProvider: PaymentProvider = pickProvider();

type TxRow = Record<string, any>;
type Listener = (tx: TxRow) => void | Promise<void>;
const listeners: Record<'DISBURSEMENT' | 'COLLECTION', Listener[]> = { DISBURSEMENT: [], COLLECTION: [] };

/** The lending engine subscribes to confirmed/failed transactions. */
export function onPaymentCompleted(direction: 'DISBURSEMENT' | 'COLLECTION', fn: Listener) { listeners[direction].push(fn); }

paymentProvider.onResult(async (r) => {
  const tx = db.get(`SELECT * FROM payment_transactions WHERE provider_reference = ?`, r.providerReference);
  if (!tx || tx.status !== 'PENDING') return; // idempotent: duplicate callbacks are ignored
  db.update('payment_transactions', tx.id, {
    status: r.success ? 'SUCCESS' : 'FAILED', receipt_number: r.receiptNumber ?? null, failure_reason: r.failureReason ?? null, completed_at: clock.nowIso(),
  });
  const updated = db.get('SELECT * FROM payment_transactions WHERE id = ?', tx.id)!;
  for (const fn of listeners[tx.direction as 'DISBURSEMENT' | 'COLLECTION']) {
    try { await fn(updated); } catch (e: any) { console.error('[payments] listener failed', e?.message); }
  }
});

/** Create a PENDING transaction and hand it to the provider. */
export async function initiatePayment(opts: {
  direction: 'DISBURSEMENT' | 'COLLECTION'; organizationId: string; memberId: string; phone: string; amount: number;
  loanId?: string; applicationId?: string; reference: string; description: string; actor: Actor;
  /** What the payment is for when it is not a loan movement (e.g. 'CRB_FEE'). */
  referenceType?: string;
}) {
  const id = newId('ptx');
  db.insert('payment_transactions', {
    id, organization_id: opts.organizationId, direction: opts.direction, provider: paymentProvider.name, member_id: opts.memberId,
    loan_id: opts.loanId ?? null, application_id: opts.applicationId ?? null, phone: opts.phone, amount: opts.amount, status: 'PENDING',
    initiated_by_type: opts.actor.type, initiated_by_id: opts.actor.id, created_at: clock.nowIso(), reference_type: opts.referenceType ?? null,
  });
  const req = { phone: opts.phone, amount: opts.amount, reference: opts.reference, description: opts.description };
  const init = opts.direction === 'DISBURSEMENT' ? await paymentProvider.disburse(req) : await paymentProvider.collect(req);
  if (!init.accepted) {
    db.update('payment_transactions', id, { status: 'FAILED', failure_reason: init.error ?? 'Not accepted', completed_at: clock.nowIso() });
  } else {
    db.update('payment_transactions', id, { provider_reference: init.providerReference });
  }
  return db.get('SELECT * FROM payment_transactions WHERE id = ?', id)!;
}
