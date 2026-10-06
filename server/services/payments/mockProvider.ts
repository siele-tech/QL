import crypto from 'node:crypto';
import type { PaymentInitResult, PaymentProvider, PaymentRequest, PaymentResultHandler } from './provider.ts';
import { normalizeKePhone } from '../sms/provider.ts';

/**
 * Mock M-PESA-like provider for development and demos.
 * Accepts the request and confirms asynchronously (~1.5–2.5s), like a real callback.
 * Simulated failures (to demonstrate error handling):
 *  - phone numbers ending in 0000  → "The M-PESA request was cancelled by the user"
 *  - collection of exactly KES 999 → "Insufficient M-PESA balance"
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'MPESA_MOCK';
  private handlers: PaymentResultHandler[] = [];

  private schedule(ref: string, req: PaymentRequest, kind: 'B2C' | 'STK') {
    const msisdn = normalizeKePhone(req.phone)!;
    let failure: string | undefined;
    if (msisdn.endsWith('0000')) failure = kind === 'STK' ? 'The M-PESA request was cancelled by the user' : 'Recipient M-PESA account is unavailable';
    else if (kind === 'STK' && req.amount === 999) failure = 'Insufficient M-PESA balance';
    const receipt = 'S' + crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 9);
    setTimeout(() => {
      this.handlers.forEach((h) => h({ providerReference: ref, success: !failure, receiptNumber: failure ? undefined : receipt, failureReason: failure }));
    }, 1500 + Math.random() * 1000).unref?.();
  }
  async disburse(req: PaymentRequest): Promise<PaymentInitResult> {
    if (!normalizeKePhone(req.phone)) return { accepted: false, error: 'Invalid M-PESA number' };
    const ref = 'AG_' + crypto.randomBytes(6).toString('hex').toUpperCase();
    this.schedule(ref, req, 'B2C');
    return { accepted: true, providerReference: ref };
  }
  async collect(req: PaymentRequest): Promise<PaymentInitResult> {
    if (!normalizeKePhone(req.phone)) return { accepted: false, error: 'Invalid M-PESA number' };
    const ref = 'ws_CO_' + crypto.randomBytes(6).toString('hex').toUpperCase();
    this.schedule(ref, req, 'STK');
    return { accepted: true, providerReference: ref };
  }
  onResult(h: PaymentResultHandler) { this.handlers.push(h); }
}
