import { config } from '../../config.ts';
import { db } from '../../db/db.ts';
import { clock } from '../../lib/clock.ts';
import { newId } from '../../lib/ids.ts';

/**
 * Push notification channel. The provider contract lets a real push service (e.g. FCM via
 * Wakandi) replace the mock once its API is available. The mock records the message only.
 */
export interface PushProvider {
  readonly name: string;
  send(req: { memberId: string; title: string; body: string }): Promise<{ accepted: boolean; error?: string }>;
}

class MockPushProvider implements PushProvider {
  readonly name = 'PUSH_MOCK';
  async send() { return { accepted: true }; }
}

/** Real push adapter: integration pending the push service's API documentation. */
class PendingPushProvider implements PushProvider {
  readonly name = 'PUSH';
  async send() { return { accepted: false, error: 'Push integration pending API documentation' }; }
}

export const pushProvider: PushProvider = config.push.apiUrl && config.push.apiKey ? new PendingPushProvider() : new MockPushProvider();

export async function sendPush(organizationId: string, memberId: string, title: string, body: string) {
  const r = await pushProvider.send({ memberId, title, body });
  const id = newId('psh');
  db.insert('push_messages', { id, organization_id: organizationId, member_id: memberId, title, body, provider: pushProvider.name, status: r.accepted ? 'SENT' : 'FAILED', created_at: clock.nowIso() });
  return { id, accepted: r.accepted };
}
