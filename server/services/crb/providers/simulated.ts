import crypto from 'node:crypto';
import { type CrbProvider, type CrbProviderKey, type CrbProviderRequest, type CrbProviderResult, CrbProviderError, gradeFor } from '../types.ts';

/**
 * Simulated CRB used in development/demo until the embedded CRB is configured.
 * Deterministic per ID number so repeated checks are consistent. Known demo identities
 * have fixed scores. ID numbers ending in "000" simulate a bureau outage; ending in "404"
 * simulate "no record found".
 */
const FIXTURES: Record<string, number> = {
  '12345678': 742, // John Kamau
  '23456789': 705, // Mary Wanjiku
  '34567890': 612, // Peter Otieno
  '45678901': 781, // Faith Achieng
  '56789012': 580, // Samuel Mutua
  '67890123': 690, // Grace Njeri
};

export class SimulatedBureau implements CrbProvider {
  constructor(readonly key: CrbProviderKey) {}
  isConfigured() { return true; }

  async checkScore(req: CrbProviderRequest): Promise<CrbProviderResult> {
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 700));
    const id = req.subject.idNumber.trim();
    if (!/^\d{6,10}$/.test(id)) throw new CrbProviderError('INVALID_REQUEST', 'Invalid identification number');
    if (id.endsWith('000')) throw new CrbProviderError('UNAVAILABLE', 'Bureau service temporarily unavailable');
    if (id.endsWith('404')) throw new CrbProviderError('NOT_FOUND', 'No credit record found for subject');
    const h = crypto.createHash('sha256').update(this.key + id).digest();
    const score = FIXTURES[id] ?? 480 + (h.readUInt16BE(0) % 330);
    const npl = score < 600 ? 1 + (h[3] % 2) : 0;
    const summary = { openAccounts: 1 + (h[4] % 4), nonPerformingAccounts: npl, hasAdverseListing: npl > 0, enquiriesLast90Days: h[5] % 5 };
    return {
      score, grade: gradeFor(score), reportReference: `CRB-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      summary, simulated: true,
      raw: { provider: this.key, simulated: true, subject: { idNumber: id }, score, accounts: summary, consent: req.consentReference, requestRef: req.requestReference },
    };
  }
}
