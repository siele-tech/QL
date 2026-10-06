import { config } from '../../config.ts';
import { db } from '../../db/db.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import { newId, randomToken, sha256 } from '../../lib/ids.ts';
import type { Actor } from '../../auth/middleware.ts';
import { audit } from '../audit.ts';
import { registry } from '../registry.ts';
import { sendSms } from '../sms/smsService.ts';
import { normalizeKePhone } from '../sms/provider.ts';

/**
 * Invitations: a SACCO invites one specific member from its register.
 *
 * The link carries only an opaque random token — no name, ID or phone. Only the token's hash is
 * stored, so a database leak does not yield usable links. An invitation is tied to one registry
 * member, expires, and stops working once that member's account is activated.
 */
export const INVITATION = { ttlDays: 7, maxIdAttempts: 5, lockMinutes: 15 };
export const INVITATION_SMS = 'Hello {first_name}, {org} has invited you to QuickLoan. Activate your account here: {link} (valid for {days} days). Do not share this link.';

const hashToken = (token: string) => sha256(config.sessionSecret + ':invite:' + token);
export const activationLink = (token: string) => `${config.appUrl.replace(/\/$/, '')}/member/activate/${token}`;

export const invitationService = {
  /** Create a personal invitation. Any earlier unused invitation for the same member stops working. */
  create(actor: Actor, registryMemberId: string) {
    const person = registry.get(registryMemberId);
    if (!person || person.organizationId !== actor.organizationId) throw notFound('Member');
    if (db.get('SELECT 1 FROM members WHERE registry_member_id = ?', registryMemberId)) throw new AppError(409, 'ALREADY_ACTIVATED', `${person.fullName} already has a QuickLoan account.`);
    if (person.idNumber.replace(/[\s-]/g, '').length < 5) throw new AppError(422, 'NO_ID_ON_RECORD', `${person.fullName} has no valid National ID on record. Correct their details before inviting them.`);
    const token = randomToken(32), id = newId('inv'), now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION.ttlDays * 86400_000).toISOString();
    db.tx(() => {
      db.run(`UPDATE member_invitations SET status = 'REVOKED' WHERE registry_member_id = ? AND status = 'PENDING'`, registryMemberId);
      db.insert('member_invitations', {
        id, organization_id: person.organizationId, registry_member_id: registryMemberId, token_hash: hashToken(token), status: 'PENDING',
        expires_at: expiresAt, created_by: actor.id, created_by_name: actor.name, created_at: now.toISOString(),
      });
    });
    audit(actor, 'MEMBER_INVITED', `Invited ${person.fullName} to QuickLoan`, { entityType: 'INVITATION', entityId: id });
    return { id, token, link: activationLink(token), expiresAt, person };
  },

  /** Create an invitation and text the link to the number on the SACCO record. */
  async createAndSend(actor: Actor, registryMemberId: string, opts: { campaignId?: string | null } = {}) {
    const inv = invitationService.create(actor, registryMemberId);
    const recorded = db.get('SELECT phone FROM registry_members WHERE id = ?', registryMemberId)?.phone as string | null;
    const phone = recorded ? normalizeKePhone(recorded) : null;
    const org = db.get('SELECT name FROM organizations WHERE id = ?', actor.organizationId)!;
    const body = invitationSms(inv.person.fullName, org.name, inv.link);
    let sent = false;
    if (phone) sent = (await sendSms({ organizationId: actor.organizationId, phone, body, type: 'NOTIFICATION', campaignId: opts.campaignId ?? null, actor })).accepted;
    return { ...inv, sent, body };
  },

  /**
   * Resolve a link token. Unknown, replaced, expired and already-used links each get a clear,
   * safe answer — none of them reveals anything about the member.
   */
  resolve(token: string) {
    const inv = typeof token === 'string' && token.length >= 20 ? db.get('SELECT * FROM member_invitations WHERE token_hash = ?', hashToken(token)) : null;
    if (!inv || inv.status === 'REVOKED') throw new AppError(404, 'INVITATION_INVALID', 'This invitation link is not valid. Please ask your SACCO to send you a new one.');
    if (inv.status === 'ACTIVATED' || db.get('SELECT 1 FROM members WHERE registry_member_id = ?', inv.registry_member_id)) {
      throw new AppError(409, 'INVITATION_USED', 'This invitation has already been used. Sign in with your phone number and PIN.');
    }
    if (inv.expires_at < new Date().toISOString()) throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation link has expired. Please ask your SACCO to send you a new one.');
    return inv;
  },

  markOpened: (id: string) => db.run('UPDATE member_invitations SET opened_at = COALESCE(opened_at, ?) WHERE id = ?', new Date().toISOString(), id),
  markUsed: (id: string, memberId: string) => db.run(`UPDATE member_invitations SET status = 'ACTIVATED', member_id = ?, activated_at = ? WHERE id = ?`, memberId, new Date().toISOString(), id),
};

export const invitationSms = (fullName: string, orgName: string, link: string) => INVITATION_SMS
  .replace('{first_name}', fullName.split(' ')[0]).replace('{org}', orgName).replace('{link}', link).replace('{days}', String(INVITATION.ttlDays));
