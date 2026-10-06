import { config } from '../../config.ts';
import type { PaymentInitResult, PaymentProvider, PaymentRequest, PaymentResultHandler } from './provider.ts';

/**
 * Wakandi Pay adapter — disbursement and collection through Wakandi's connected payment rails.
 * Integration point: request/response mapping and its callback (webhook) are completed from the
 * Wakandi Pay API documentation. Until then it refuses requests, so no money moves through it.
 * Select it with PAYMENT_PROVIDER=wakandipay once WAKANDI_PAY_API_URL and WAKANDI_PAY_API_KEY are set.
 */
export class WakandiPayProvider implements PaymentProvider {
  readonly name = 'WAKANDI_PAY';
  private handlers: PaymentResultHandler[] = [];
  static configured() { return !!(config.wakandiPay.apiUrl && config.wakandiPay.apiKey); }
  private pending(): PaymentInitResult { return { accepted: false, error: 'Wakandi Pay integration pending API documentation' }; }
  async disburse(_req: PaymentRequest) { return this.pending(); }
  async collect(_req: PaymentRequest) { return this.pending(); }
  onResult(h: PaymentResultHandler) { this.handlers.push(h); }
}
