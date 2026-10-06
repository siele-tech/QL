import { api } from '../api';

/**
 * Client for member onboarding and sign-in. Screens call these functions and never build
 * requests themselves, so the real invitation, registry, OTP and phone-update APIs can be
 * swapped in here without touching the UI.
 */
export interface InvitationDetails { organization: string; fullName: string; idNumberMasked: string; expiresAt: string }
export interface IdentityResult { activationToken: string; firstName: string; recordedPhone: string | null }
export interface CodeSent { phone: string; resendInSeconds: number; expiresInSeconds: number; isNewNumber?: boolean; demoCode?: string }
export interface Activated { ok: true; firstName: string; phoneUpdatePending: boolean }

const inv = (token: string) => `/auth/invitations/${encodeURIComponent(token)}`;

/** Invitation service: what the personal link resolves to. */
export const invitations = {
  get: (token: string) => api.get<InvitationDetails>(inv(token)),
  /** Demo only: a fresh personal link, standing in for the SMS a SACCO sends. */
  demo: () => api.post<{ link: string; name: string; idNumber: string }>('/public/demo/invitation'),
};

/** Member service: identity (SACCO record + National ID) and account creation. */
export const memberOnboarding = {
  verifyIdentity: (token: string, idNumber: string) => api.post<IdentityResult>(`${inv(token)}/identity`, { idNumber }),
  activate: (token: string, activationToken: string, pin: string, consents: { crbConsent: boolean }) =>
    api.post<Activated>(`${inv(token)}/activate`, { activationToken, pin, acceptTerms: true, dataConsent: true, ...consents }),
};

/** OTP service: proves access to a phone number. It does not check who the SIM is registered to. */
export const phoneVerification = {
  useRecorded: (token: string, activationToken: string) => api.post<CodeSent>(`${inv(token)}/phone`, { activationToken, useRecorded: true }),
  useNumber: (token: string, activationToken: string, phone: string) => api.post<CodeSent>(`${inv(token)}/phone`, { activationToken, phone }),
  resend: (token: string, activationToken: string) => api.post<CodeSent>(`${inv(token)}/otp/resend`, { activationToken }),
  verify: (token: string, activationToken: string, code: string) => api.post<{ verified: true; phone: string; isNewNumber: boolean }>(`${inv(token)}/otp/verify`, { activationToken, code }),
};

/** Authentication service: returning members. */
export const memberAuth = {
  login: (phone: string, pin: string, organizationId?: string) => api.post('/auth/member/login', { phone, pin, organizationId }),
  startPinReset: (phone: string, idNumber: string) => api.post<CodeSent & { resetId: string }>('/auth/member/pin-reset/start', { phone, idNumber }),
  resendPinReset: (resetId: string) => api.post<CodeSent & { resetId: string }>('/auth/member/pin-reset/resend', { resetId }),
  completePinReset: (resetId: string, code: string, pin: string) => api.post<{ ok: true; signedIn: boolean }>('/auth/member/pin-reset/complete', { resetId, code, pin }),
};

/** The same weak-PIN rules the server enforces, so the member hears about it before submitting. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return 'Your PIN must be 4 digits.';
  if (/^(\d)\1{3}$/.test(pin)) return 'Choose a PIN that is not the same digit repeated.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Choose a PIN that is harder to guess than digits in a row.';
  return null;
}
