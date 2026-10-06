import crypto from 'node:crypto';
import { config } from '../../config.ts';
import type { DeliveryHandler, SmsProvider, SmsSendRequest, SmsSendResult } from './provider.ts';

/**
 * Wakandi message service adapter — the same integration Wakandi Jamii uses:
 * an OAuth client_credentials token from Wakandi SSO, then `send-external-message`
 * (Africa's Talking behind it). A 2xx means accepted, not delivered; the service does not
 * forward delivery reports today, so messages stay SENT.
 * Sends are attributed to the organization's Wakandi account id ("wakandi-id" header).
 */
let cached: { token: string; expiresAt: number } | null = null;

async function token() {
  const c = config.messageService;
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const res = await fetch(c.ssoUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`SSO responded ${res.status}`);
  const j = (await res.json()) as { access_token?: string; expires_on?: number; expires_in?: number };
  if (!j.access_token) throw new Error('SSO returned no access_token');
  cached = { token: j.access_token, expiresAt: (j.expires_on ? j.expires_on * 1000 : 0) || (j.expires_in ? Date.now() + j.expires_in * 1000 : 0) || Date.now() + 5 * 60_000 };
  return cached.token;
}

export class WakandiMessageServiceProvider implements SmsProvider {
  readonly name = 'WAKANDI_MESSAGE_SERVICE';
  static configured() { const c = config.messageService; return !!(c.url && c.ssoUrl && c.clientId && c.clientSecret); }

  async send(req: SmsSendRequest): Promise<SmsSendResult> {
    const clientRef = crypto.randomBytes(10).toString('hex');
    if (!req.wakandiId) return { providerMessageId: clientRef, accepted: false, error: 'No Wakandi account id for this organization — it is not provisioned for sending yet.' };
    try {
      const res = await fetch(config.messageService.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}`, 'wakandi-id': req.wakandiId, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          type: 'sms', channels: ['sms'], appName: config.messageService.appName, isBulk: false, batchRef: req.clientReference,
          messageObject: { messageBody: req.body }, recipient: [{ phone: req.to.replace(/^\+/, ''), clientRef }], secure: false,
          ...(req.senderId ? { senderId: req.senderId } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return { providerMessageId: clientRef, accepted: false, error: `Message service responded ${res.status}` };
      return { providerMessageId: clientRef, accepted: true };
    } catch (e: any) {
      return { providerMessageId: clientRef, accepted: false, error: e?.message ?? 'Network failure contacting the message service' };
    }
  }
  onDeliveryReport(_h: DeliveryHandler) { /* not forwarded by the message service today */ }
}
