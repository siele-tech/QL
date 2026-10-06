import { Router } from 'express';
import { h } from '../lib/http.ts';
import { paymentProvider } from '../services/payments/paymentService.ts';
import { MpesaDarajaProvider } from '../services/payments/mpesaDaraja.ts';
import { smsProvider } from '../services/sms/smsService.ts';
import { JamiProvider } from '../services/sms/jami.ts';

/**
 * Provider callbacks. In production, restrict these routes to provider IP ranges at the
 * edge (Safaricom publishes its callback IPs) and/or verify signatures where offered.
 */
export const webhooksRouter = Router();

webhooksRouter.post('/payments/mpesa/:kind', h(async (req, res) => {
  if (paymentProvider instanceof MpesaDarajaProvider && (req.params.kind === 'stk' || req.params.kind === 'b2c')) {
    paymentProvider.handleCallback(req.params.kind, req.body);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

webhooksRouter.post('/sms/jami', h(async (req, res) => {
  if (smsProvider instanceof JamiProvider) {
    const { message_id, id, status, error } = req.body ?? {};
    const delivered = String(status ?? '').toUpperCase() === 'DELIVERED';
    smsProvider.deliveryReport(String(message_id ?? id), delivered ? 'DELIVERED' : 'FAILED', delivered ? undefined : String(error ?? status));
  }
  res.json({ ok: true });
}));
