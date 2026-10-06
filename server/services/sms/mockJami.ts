import { randomUUID } from 'node:crypto';
import type { DeliveryHandler, SmsProvider, SmsSendRequest, SmsSendResult } from './provider.ts';
import { normalizeKePhone } from './provider.ts';

/**
 * Mock Jami SMS provider for development/demo. Behaves like the real gateway:
 * accepts the message, then delivers a delivery report asynchronously (1–3s).
 * Simulated failures: numbers ending in 0000 are "unreachable".
 */
export class MockJamiProvider implements SmsProvider {
  readonly name = 'JAMI_MOCK';
  private handlers: DeliveryHandler[] = [];

  async send(req: SmsSendRequest): Promise<SmsSendResult> {
    const msisdn = normalizeKePhone(req.to);
    if (!msisdn) return { providerMessageId: '', accepted: false, error: 'Invalid phone number' };
    const id = 'JMI-' + randomUUID().slice(0, 13).toUpperCase();
    const fail = msisdn.endsWith('0000');
    setTimeout(() => this.handlers.forEach((h) => h(id, fail ? 'FAILED' : 'DELIVERED', fail ? 'Subscriber unreachable' : undefined)), 1000 + Math.random() * 2000).unref?.();
    return { providerMessageId: id, accepted: true };
  }
  onDeliveryReport(h: DeliveryHandler) { this.handlers.push(h); }
}
