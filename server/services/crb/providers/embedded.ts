import { config } from '../../../config.ts';
import { type CrbProvider, type CrbProviderRequest, type CrbProviderResult, CrbProviderError } from '../types.ts';

/**
 * Adapter for the company's existing (embedded) CRB.
 * Configured with CRB_API_URL and CRB_API_KEY. The request and response mapping is completed
 * from that system's API documentation; until then this adapter reports NOT_CONFIGURED and,
 * in demo mode, the CRB service answers with the simulated responder instead.
 */
export class EmbeddedCrbProvider implements CrbProvider {
  readonly key = 'EMBEDDED' as const;
  isConfigured() { return !!(config.crb.baseUrl && config.crb.apiKey); }

  async checkScore(_req: CrbProviderRequest): Promise<CrbProviderResult> {
    if (!this.isConfigured()) throw new CrbProviderError('NOT_CONFIGURED', 'Embedded CRB is not configured');
    // Integration point: call the embedded CRB's score lookup with the subject's ID, the consent
    // reference and requestReference, then map its score, grade, account summary and report
    // reference into CrbProviderResult (raw = full response, stored encrypted).
    throw new CrbProviderError('NOT_CONFIGURED', 'Embedded CRB integration pending its API documentation');
  }
}
