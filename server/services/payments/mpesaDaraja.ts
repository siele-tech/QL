import { config } from '../../config.ts';
import type { PaymentInitResult, PaymentProvider, PaymentRequest, PaymentResultHandler } from './provider.ts';
import { normalizeKePhone } from '../sms/provider.ts';

/**
 * Safaricom M-PESA (Daraja) provider.
 *  - Collections: Lipa Na M-PESA Online (STK push)   POST /mpesa/stkpush/v1/processrequest
 *  - Disbursements: B2C BusinessPayment               POST /mpesa/b2c/v3/paymentrequest
 * Results arrive at /api/webhooks/payments/mpesa/{stk|b2c} and are parsed by `handleCallback`.
 * Activated when MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET are configured.
 */
export class MpesaDarajaProvider implements PaymentProvider {
  readonly name = 'MPESA';
  private handlers: PaymentResultHandler[] = [];
  private token: { value: string; expires: number } | null = null;
  private get base() { return config.mpesa.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'; }

  private async accessToken() {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    const basic = Buffer.from(`${config.mpesa.consumerKey}:${config.mpesa.consumerSecret}`).toString('base64');
    const res = await fetch(`${this.base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Daraja auth failed (${res.status})`);
    const body: any = await res.json();
    this.token = { value: body.access_token, expires: Date.now() + (Number(body.expires_in ?? 3599) - 60) * 1000 };
    return this.token.value;
  }

  private async post(path: string, payload: unknown) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
    });
    return { ok: res.ok, body: (await res.json().catch(() => ({}))) as any };
  }

  async collect(req: PaymentRequest): Promise<PaymentInitResult> {
    const phone = normalizeKePhone(req.phone);
    if (!phone) return { accepted: false, error: 'Invalid M-PESA number' };
    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(config.mpesa.shortcode + config.mpesa.passkey + ts).toString('base64');
    try {
      const { ok, body } = await this.post('/mpesa/stkpush/v1/processrequest', {
        BusinessShortCode: config.mpesa.shortcode, Password: password, Timestamp: ts, TransactionType: 'CustomerPayBillOnline',
        Amount: req.amount, PartyA: phone, PartyB: config.mpesa.shortcode, PhoneNumber: phone,
        CallBackURL: `${config.mpesa.callbackBaseUrl}/api/webhooks/payments/mpesa/stk`, AccountReference: req.reference.slice(0, 12), TransactionDesc: req.description.slice(0, 13),
      });
      if (!ok || body.ResponseCode !== '0') return { accepted: false, error: 'M-PESA request was not accepted' };
      return { accepted: true, providerReference: body.CheckoutRequestID };
    } catch {
      return { accepted: false, error: 'M-PESA is unavailable' };
    }
  }

  async disburse(req: PaymentRequest): Promise<PaymentInitResult> {
    const phone = normalizeKePhone(req.phone);
    if (!phone) return { accepted: false, error: 'Invalid M-PESA number' };
    try {
      const { ok, body } = await this.post('/mpesa/b2c/v3/paymentrequest', {
        OriginatorConversationID: req.reference, InitiatorName: config.mpesa.b2cInitiator, SecurityCredential: config.mpesa.b2cSecurityCredential,
        CommandID: 'BusinessPayment', Amount: req.amount, PartyA: config.mpesa.shortcode, PartyB: phone, Remarks: req.description.slice(0, 100),
        QueueTimeOutURL: `${config.mpesa.callbackBaseUrl}/api/webhooks/payments/mpesa/b2c-timeout`,
        ResultURL: `${config.mpesa.callbackBaseUrl}/api/webhooks/payments/mpesa/b2c`, Occasion: req.reference,
      });
      if (!ok || body.ResponseCode !== '0') return { accepted: false, error: 'M-PESA disbursement was not accepted' };
      return { accepted: true, providerReference: body.ConversationID };
    } catch {
      return { accepted: false, error: 'M-PESA is unavailable' };
    }
  }

  onResult(h: PaymentResultHandler) { this.handlers.push(h); }

  /** Parse a Daraja callback body (STK or B2C) and dispatch a normalised result. */
  handleCallback(kind: 'stk' | 'b2c', body: any) {
    if (kind === 'stk') {
      const cb = body?.Body?.stkCallback;
      if (!cb) return;
      const items: any[] = cb.CallbackMetadata?.Item ?? [];
      const receipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;
      this.handlers.forEach((h) => h({ providerReference: cb.CheckoutRequestID, success: cb.ResultCode === 0, receiptNumber: receipt, failureReason: cb.ResultCode === 0 ? undefined : cb.ResultDesc }));
    } else {
      const r = body?.Result;
      if (!r) return;
      this.handlers.forEach((h) => h({ providerReference: r.ConversationID, success: r.ResultCode === 0, receiptNumber: r.TransactionID, failureReason: r.ResultCode === 0 ? undefined : r.ResultDesc }));
    }
  }
}
