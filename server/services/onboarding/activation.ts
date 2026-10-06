import crypto from 'node:crypto';
import { config } from '../../config.ts';
import { db } from '../../db/db.ts';
import { clock, today } from '../../lib/clock.ts';
import { AppError, badRequest, conflict } from '../../lib/errors.ts';
import { newId, shortRef } from '../../lib/ids.ts';
import { hashSecret, pinProblems } from '../../auth/password.ts';
import { permissionsFor } from '../../auth/rbac.ts';
import type { Actor } from '../../auth/middleware.ts';
import { audit } from '../audit.ts';
import { registry } from '../registry.ts';
import { localPhone, normalizeKePhone } from '../sms/provider.ts';
import { recomputeBehaviour } from '../../lending/behaviour.ts';
import { INVITATION, invitationService } from './invitations.ts';
import { maskPhone, otpService } from './otp.ts';

/**
 * Member account activation and PIN reset.
 *
 * Identity and phone access are two separate things:
 *   - WHO the member is  = the SACCO's member record + a matching National ID.
 *   - HOW they reach us  = any phone number they can receive a code on.
 * The phone does not have to be the one on the SACCO record, and its SIM does not have to be
 * registered in the member's name. Nothing in this file compares SIM ownership with the member.
 */

// A short-lived signed token proves "this browser passed the ID check for this invitation".
const STEP_TTL_MS = 30 * 60_000;
const sign = (payload: string) => {
  const body = `${payload}.${Date.now() + STEP_TTL_MS}`;
  return `${body}.${crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url')}`;
};
const unsign = (token: unknown) => {
  if (typeof token !== 'string') return null;
  const [payload, exp, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', config.sessionSecret).update(`${payload}.${exp}`).digest('base64url');
  if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) || Number(exp) < Date.now()) return null;
  return payload;
};

const normId = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
const sameId = (a: string, b: string) => {
  const x = Buffer.from(normId(a)), y = Buffer.from(normId(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
/** ••••••78 — the member recognises their own ID; nobody else learns it. */
export const maskId = (id: string) => '•'.repeat(Math.max(4, id.length - 2)) + id.slice(-2);
const recordedPhone = (registryId: string) => {
  const p = db.get('SELECT phone FROM registry_members WHERE id = ?', registryId)?.phone as string | null;
  return p ? normalizeKePhone(p) : null;
};
const minutesLeft = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60_000));

/** The invitation, but only for a browser that has passed the ID check. */
function verifiedInvitation(token: string, stepToken: unknown) {
  const inv = invitationService.resolve(token);
  if (unsign(stepToken) !== `inv:${inv.id}` || !inv.identity_verified_at) throw new AppError(401, 'IDENTITY_NOT_VERIFIED', 'Please confirm your National ID again to continue.');
  return inv;
}

export const activationService = {
  /** Step 1: what the invited member sees before proving anything. Name, masked ID, SACCO. */
  details(token: string) {
    const inv = invitationService.resolve(token);
    invitationService.markOpened(inv.id);
    const person = registry.get(inv.registry_member_id)!;
    const org = db.get('SELECT name FROM organizations WHERE id = ?', inv.organization_id)!;
    return { organization: org.name as string, fullName: person.fullName, idNumberMasked: maskId(person.idNumber), expiresAt: inv.expires_at as string };
  },

  /** Step 2: the entered National ID must match the one attached to this invitation. */
  verifyIdentity(token: string, idNumber: string) {
    const inv = invitationService.resolve(token);
    if (inv.locked_until && inv.locked_until > new Date().toISOString()) {
      throw new AppError(423, 'LOCKED', `Too many incorrect attempts. Try again in ${minutesLeft(inv.locked_until)} minute${minutesLeft(inv.locked_until) === 1 ? '' : 's'}.`);
    }
    const person = registry.get(inv.registry_member_id)!;
    if (!sameId(idNumber, person.idNumber)) {
      const attempts = inv.id_attempts + 1;
      const lock = attempts >= INVITATION.maxIdAttempts;
      db.update('member_invitations', inv.id, { id_attempts: lock ? 0 : attempts, locked_until: lock ? new Date(Date.now() + INVITATION.lockMinutes * 60_000).toISOString() : null });
      if (lock) audit({ type: 'SYSTEM', id: null, name: 'QuickLoan System', role: 'system', organizationId: inv.organization_id, homeOrganizationId: inv.organization_id, permissions: new Set() }, 'INVITATION_LOCKED', `Activation for ${person.fullName} paused after repeated wrong National ID entries`, { entityType: 'INVITATION', entityId: inv.id });
      // The same words whether the ID is unknown or belongs to somebody else.
      throw badRequest('We couldn’t verify these details. Please check your National ID and try again.', 'IDENTITY_MISMATCH');
    }
    db.update('member_invitations', inv.id, { id_attempts: 0, locked_until: null, identity_verified_at: new Date().toISOString() });
    const phone = recordedPhone(inv.registry_member_id);
    return { activationToken: sign(`inv:${inv.id}`), firstName: person.fullName.split(' ')[0], recordedPhone: phone ? maskPhone(phone) : null };
  },

  /** Step 3: the member picks the number they actually use; we text a code to it. */
  async choosePhone(token: string, stepToken: unknown, choice: { useRecorded?: boolean; phone?: string }) {
    const inv = verifiedInvitation(token, stepToken);
    const onRecord = recordedPhone(inv.registry_member_id);
    const phone = choice.useRecorded ? onRecord : normalizeKePhone(choice.phone ?? '');
    if (!phone) throw badRequest(choice.useRecorded ? 'There is no phone number on your SACCO record. Please enter the number you use.' : 'Enter a valid Kenyan mobile number, e.g. 0712 345 678.', 'INVALID_PHONE');
    if (db.get('SELECT 1 FROM members WHERE organization_id = ? AND phone = ?', inv.organization_id, phone)) {
      throw conflict('This number is already used for another QuickLoan account at your SACCO. Please use a different number, or contact your SACCO.', 'PHONE_IN_USE');
    }
    const otp = await otpService.start('ACTIVATION', inv.id, inv.organization_id, phone);
    return { ...otp, isNewNumber: phone !== onRecord };
  },

  async resendCode(token: string, stepToken: unknown) {
    const inv = verifiedInvitation(token, stepToken);
    const c = otpService.current('ACTIVATION', inv.id);
    if (!c) throw new AppError(400, 'OTP_NOT_FOUND', 'Please choose your phone number again.');
    return otpService.resend(c.id);
  },

  /** Step 4: a correct code proves access to the phone. It is not a check of SIM ownership. */
  verifyCode(token: string, stepToken: unknown, code: string) {
    const inv = verifiedInvitation(token, stepToken);
    const c = otpService.current('ACTIVATION', inv.id);
    if (!c) throw new AppError(400, 'OTP_NOT_FOUND', 'Please choose your phone number again.');
    const ok = otpService.verify(c.id, code);
    return { verified: true, phone: maskPhone(ok.phone), isNewNumber: ok.phone !== recordedPhone(inv.registry_member_id) };
  },

  /** Step 5: create the account. Requires the ID check and a verified phone for this invitation. */
  activate(token: string, stepToken: unknown, input: { pin: string; crbConsent: boolean }) {
    const inv = verifiedInvitation(token, stepToken);
    const c = otpService.current('ACTIVATION', inv.id);
    if (!c?.verified_at) throw new AppError(400, 'PHONE_NOT_VERIFIED', 'Please verify your phone number first.');
    const pinIssue = pinProblems(input.pin);
    if (pinIssue) throw badRequest(pinIssue, 'WEAK_PIN');
    const person = registry.get(inv.registry_member_id)!;
    const onRecord = recordedPhone(inv.registry_member_id);
    const phone = c.phone as string, id = newId('mem'), now = clock.nowIso();
    const isNewNumber = phone !== onRecord;
    db.tx(() => {
      if (db.get('SELECT 1 FROM members WHERE registry_member_id = ?', inv.registry_member_id)) throw conflict('This invitation has already been used. Sign in with your phone number and PIN.', 'INVITATION_USED');
      if (db.get('SELECT 1 FROM members WHERE organization_id = ? AND phone = ?', inv.organization_id, phone)) throw conflict('This number is already used for another QuickLoan account at your SACCO.', 'PHONE_IN_USE');
      db.insert('members', {
        id, organization_id: inv.organization_id, registry_member_id: inv.registry_member_id, phone, email: null, pin_hash: hashSecret(input.pin),
        status: 'ACTIVE', membership_since: today(), onboarded_at: now, created_at: now,
      });
      db.insert('member_profiles', { member_id: id, disbursement_method: 'MPESA', disbursement_phone: phone, attributes: '{}', updated_at: now });
      for (const type of ['TERMS', 'DATA_PROCESSING', ...(input.crbConsent ? ['CRB_CHECK'] : [])] as const) {
        db.insert('member_consents', { id: newId('cns'), member_id: id, type, reference: shortRef(type === 'CRB_CHECK' ? 'CNS-CRB' : 'CNS'), context: 'Given at activation', granted_at: now });
      }
      // A different number is an access number for QuickLoan. The SACCO's own record is not
      // overwritten: the change waits for the SACCO to approve it.
      if (isNewNumber) {
        db.insert('phone_change_requests', {
          id: newId('pcr'), organization_id: inv.organization_id, registry_member_id: inv.registry_member_id, member_id: id,
          recorded_phone: onRecord, new_phone: phone, status: 'PENDING_APPROVAL', verified_at: c.verified_at, created_at: now,
        });
      }
      invitationService.markUsed(inv.id, id);
      otpService.consume(c.id);
    });
    recomputeBehaviour(id, 'Joined QuickLoan');
    const actor: Actor = { type: 'MEMBER', id, name: person.fullName, role: 'member', organizationId: inv.organization_id, homeOrganizationId: inv.organization_id, permissions: permissionsFor('member') };
    audit(actor, 'MEMBER_ACTIVATED', `${person.fullName} activated QuickLoan (${localPhone(phone)}${isNewNumber ? ', a different number from the SACCO record — update pending approval' : ''})`, { entityType: 'MEMBER', entityId: id });
    return { memberId: id, organizationId: inv.organization_id as string, firstName: person.fullName.split(' ')[0], phoneUpdatePending: isNewNumber };
  },
};

/**
 * Forgot PIN. Because a member's phone may belong to a relative, a code alone is not enough to
 * change a PIN: the National ID on the SACCO record must match as well.
 */
export const pinResetService = {
  /** Always answers the same way, so it cannot be used to discover who has an account. */
  async start(phoneInput: string, idNumber: string) {
    const phone = normalizeKePhone(phoneInput);
    if (!phone) throw badRequest('Enter a valid Kenyan mobile number, e.g. 0712 345 678.', 'INVALID_PHONE');
    const matches = db.all(
      `SELECT m.id, m.organization_id, r.id_number FROM members m JOIN registry_members r ON r.id = m.registry_member_id WHERE m.phone = ? AND m.status != 'INACTIVE'`, phone,
    ).filter((m) => sameId(idNumber, m.id_number));
    if (!matches.length) return otpService.start('PIN_RESET', `none:${crypto.randomBytes(8).toString('hex')}`, null, phone, { send: false });
    return otpService.start('PIN_RESET', matches.map((m) => m.id).join(','), matches[0].organization_id, phone);
  },

  resend(resetId: string) {
    const c = otpService.get(resetId);
    if (!c || c.purpose !== 'PIN_RESET') throw new AppError(400, 'OTP_NOT_FOUND', 'Please start again to get a new code.');
    return otpService.resend(resetId, { send: !c.subject_id.startsWith('none:') });
  },

  complete(resetId: string, code: string, pin: string) {
    const c = otpService.get(resetId);
    if (!c || c.purpose !== 'PIN_RESET') throw new AppError(400, 'OTP_NOT_FOUND', 'Please start again to get a new code.');
    const pinIssue = pinProblems(pin);
    if (pinIssue) throw badRequest(pinIssue, 'WEAK_PIN');
    const ok = otpService.verify(resetId, code); // a challenge that was never sent cannot be passed
    const ids = String(ok.subject_id).split(',').filter((s) => s.startsWith('mem_'));
    if (!ids.length) throw new AppError(400, 'OTP_INCORRECT', 'That code is not correct.');
    const members = ids.map((id) => db.get('SELECT * FROM members WHERE id = ?', id)).filter(Boolean) as any[];
    db.tx(() => {
      for (const m of members) {
        db.run('UPDATE members SET pin_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?', hashSecret(pin), m.id);
        db.run(`DELETE FROM sessions WHERE principal_type = 'MEMBER' AND principal_id = ?`, m.id); // sign out everywhere
      }
      otpService.consume(resetId);
    });
    for (const m of members) {
      const name = registry.get(m.registry_member_id)?.fullName ?? 'Member';
      audit({ type: 'MEMBER', id: m.id, name, role: 'member', organizationId: m.organization_id, homeOrganizationId: m.organization_id, permissions: permissionsFor('member') }, 'MEMBER_PIN_RESET', `${name} reset their PIN`, { entityType: 'MEMBER', entityId: m.id });
    }
    return members.length === 1 ? { memberId: members[0].id as string, organizationId: members[0].organization_id as string } : null;
  },
};
