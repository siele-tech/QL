/**
 * SMS provider contract. QuickLoan talks to Jami SMS through this interface only,
 * so the mock can be swapped for the real Jami integration via configuration.
 */
export interface SmsSendRequest { to: string; body: string; senderId: string; clientReference: string; wakandiId?: string }
export interface SmsSendResult { providerMessageId: string; accepted: boolean; error?: string }
export type DeliveryHandler = (providerMessageId: string, status: 'DELIVERED' | 'FAILED', error?: string) => void;

export interface SmsProvider {
  readonly name: string;
  send(req: SmsSendRequest): Promise<SmsSendResult>;
  /** Providers push delivery reports; the mock simulates this asynchronously. */
  onDeliveryReport(handler: DeliveryHandler): void;
}

/** GSM-7 segment count (153 chars per part in concatenated messages). */
export function smsSegments(body: string): number {
  return body.length <= 160 ? 1 : Math.ceil(body.length / 153);
}

/** Normalise Kenyan MSISDNs to 2547XXXXXXXX / 2541XXXXXXXX. Returns null if invalid. */
export function normalizeKePhone(phone: string): string | null {
  const d = phone.replace(/[^\d]/g, '');
  let m: RegExpMatchArray | null;
  if ((m = d.match(/^0([17]\d{8})$/))) return '254' + m[1];
  if ((m = d.match(/^254([17]\d{8})$/))) return '254' + m[1];
  if ((m = d.match(/^([17]\d{8})$/))) return '254' + m[1];
  return null;
}
/** Display format 07XX XXX XXX */
export function localPhone(phone: string): string {
  const n = normalizeKePhone(phone);
  return n ? '0' + n.slice(3) : phone;
}
