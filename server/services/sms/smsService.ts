import { config } from '../../config.ts';
import { db } from '../../db/db.ts';
import { clock } from '../../lib/clock.ts';
import { newId } from '../../lib/ids.ts';
import type { Actor } from '../../auth/middleware.ts';
import type { SmsProvider } from './provider.ts';
import { smsSegments } from './provider.ts';
import { MockJamiProvider } from './mockJami.ts';
import { JamiProvider } from './jami.ts';
import { WakandiMessageServiceProvider } from './messageService.ts';
import { getOrgSettings } from '../orgSettings.ts';

export type SmsType = 'OFFER' | 'REMINDER' | 'NOTIFICATION';

/** Wakandi message service when configured, else Jami, else the mock (demo). */
export const smsProvider: SmsProvider = WakandiMessageServiceProvider.configured() ? new WakandiMessageServiceProvider()
  : config.jami.apiUrl && config.jami.apiKey ? new JamiProvider() : new MockJamiProvider();

/** The organization's own Sender ID once operators approve it; otherwise the shared default. */
export function senderIdFor(orgId: string) {
  const s = getOrgSettings(orgId).sms.senderId;
  return s.status === 'APPROVED' && s.name ? s.name : config.jami.senderId;
}

smsProvider.onDeliveryReport((providerMessageId, status, error) => {
  db.run(
    `UPDATE sms_messages SET status = ?, error = ?, delivered_at = ? WHERE provider_message_id = ? AND status IN ('QUEUED','SENT')`,
    status, error ?? null, status === 'DELIVERED' ? clock.nowIso() : null, providerMessageId,
  );
});

export const estimateSmsCostCents = (body: string, recipients = 1) => smsSegments(body) * config.jami.costPerSegmentCents * recipients;

/** Send one SMS via Jami and persist it with its delivery status. */
export async function sendSms(opts: {
  organizationId: string; phone: string; body: string; type: SmsType; memberId?: string | null;
  campaignId?: string | null; loanId?: string | null; actor: Actor;
}) {
  const id = newId('sms');
  const segments = smsSegments(opts.body);
  db.insert('sms_messages', {
    id, organization_id: opts.organizationId, member_id: opts.memberId ?? null, phone: opts.phone, body: opts.body, segments,
    type: opts.type, campaign_id: opts.campaignId ?? null, loan_id: opts.loanId ?? null, provider: smsProvider.name,
    status: 'QUEUED', cost_cents: 0, sent_by_type: opts.actor.type, sent_by_id: opts.actor.id, created_at: clock.nowIso(),
  });
  const result = await smsProvider.send({ to: opts.phone, body: opts.body, senderId: senderIdFor(opts.organizationId), clientReference: id, wakandiId: getOrgSettings(opts.organizationId).sms.wakandiId || undefined });
  if (result.accepted) {
    db.update('sms_messages', id, { status: 'SENT', provider_message_id: result.providerMessageId, cost_cents: segments * config.jami.costPerSegmentCents });
  } else {
    db.update('sms_messages', id, { status: 'FAILED', error: result.error ?? 'Not accepted' });
  }
  return { id, accepted: result.accepted };
}
