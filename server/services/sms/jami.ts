import { config } from '../../config.ts';
import type { DeliveryHandler, SmsProvider, SmsSendRequest, SmsSendResult } from './provider.ts';
import { normalizeKePhone } from './provider.ts';

/**
 * Real Jami SMS integration. Activated when JAMI_API_URL and JAMI_API_KEY are set.
 * NOTE: align the request/response field names with Jami's API contract when credentials
 * are issued; delivery reports arrive at POST /api/webhooks/sms/jami (see routes/webhooks.ts).
 */
export class JamiProvider implements SmsProvider {
  readonly name = 'JAMI';
  private handlers: DeliveryHandler[] = [];

  async send(req: SmsSendRequest): Promise<SmsSendResult> {
    const to = normalizeKePhone(req.to);
    if (!to) return { providerMessageId: '', accepted: false, error: 'Invalid phone number' };
    try {
      const res = await fetch(`${config.jami.apiUrl.replace(/\/$/, '')}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.jami.apiKey}` },
        body: JSON.stringify({ to, message: req.body, sender_id: req.senderId, reference: req.clientReference }),
        signal: AbortSignal.timeout(15_000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) return { providerMessageId: '', accepted: false, error: `Gateway error ${res.status}` };
      return { providerMessageId: String(body.id ?? body.message_id ?? req.clientReference), accepted: true };
    } catch {
      return { providerMessageId: '', accepted: false, error: 'SMS gateway unavailable' };
    }
  }
  onDeliveryReport(h: DeliveryHandler) { this.handlers.push(h); }
  /** Called by the webhook route. */
  deliveryReport(providerMessageId: string, status: 'DELIVERED' | 'FAILED', error?: string) {
    this.handlers.forEach((h) => h(providerMessageId, status, error));
  }
}
