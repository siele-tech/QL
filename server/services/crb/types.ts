/**
 * CRB Service contracts — provider-agnostic. QuickLoan, the standalone CRB application and
 * any other consumer receive the same standardized result regardless of bureau.
 */
import { config } from '../../config.ts';

/**
 * QuickLoan uses the CRB the company already runs (embedded CRB), not individual bureaus.
 * The key type stays a union so another provider can be added later without touching consumers.
 */
export type CrbProviderKey = 'EMBEDDED';

export const CRB_PROVIDERS: Record<CrbProviderKey, { name: string; notes: string }> = {
  EMBEDDED: { name: config.crb.name, notes: 'The company’s existing CRB, used by QuickLoan for score and credit information.' },
};

export interface CrbSubject { idNumber: string; idType: 'NATIONAL_ID' | 'PASSPORT' | 'ALIEN_ID'; fullName?: string }

export interface CrbProviderRequest { subject: CrbSubject; consentReference: string; requestReference: string }

/** Only non-sensitive, decision-relevant summary fields leave the CRB service. */
export interface CrbSummary {
  openAccounts: number;
  nonPerformingAccounts: number;
  hasAdverseListing: boolean;
  enquiriesLast90Days: number;
}

export interface CrbProviderResult {
  score: number;
  grade: string;
  reportReference: string;
  summary: CrbSummary;
  /** Full provider payload — stored encrypted, never returned to clients. */
  raw: unknown;
  simulated?: boolean;
}

export class CrbProviderError extends Error {
  constructor(public code: 'UNAVAILABLE' | 'NOT_FOUND' | 'AUTH' | 'INVALID_REQUEST' | 'NOT_CONFIGURED', message: string) { super(message); }
}

export interface CrbProvider {
  readonly key: CrbProviderKey;
  isConfigured(): boolean;
  /** Score lookup + summary credit information. */
  checkScore(req: CrbProviderRequest): Promise<CrbProviderResult>;
  /** Full report retrieval — future capability, intentionally not used in V1. */
  fetchFullReport?(reportReference: string): Promise<unknown>;
}

/** The standardized response consumed by QuickLoan and the standalone CRB application. */
export interface CrbCheckResult {
  id: string;
  provider: CrbProviderKey;
  providerName: string;
  status: 'COMPLETED' | 'FAILED';
  score: number | null;
  grade: string | null;
  summary: CrbSummary | null;
  reference: string | null;
  checkedAt: string;
  simulated: boolean;
  costCents: number;
  error?: { code: string; message: string };
}

export function gradeFor(score: number): string {
  if (score >= 750) return 'A';
  if (score >= 680) return 'B';
  if (score >= 620) return 'C';
  if (score >= 550) return 'D';
  return 'E';
}
