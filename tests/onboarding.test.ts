/**
 * Member onboarding acceptance tests: personal invitation → National ID → phone code → PIN,
 * returning sign-in and PIN reset. Identity (SACCO record + National ID) and phone access (OTP)
 * are checked separately; SIM ownership is never checked. In-process server, fresh demo database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = ':memory:';
process.env.DEMO_MODE = 'true';
process.env.NODE_ENV = 'test';

const { db } = await import('../server/db/db.ts');
const { seedRoles } = await import('../server/auth/rbac.ts');
const { seedIfEmpty } = await import('../server/db/seed.ts');
const { createApp } = await import('../server/app.ts');
const { normalizeKePhone, localPhone } = await import('../server/services/sms/provider.ts');
const { invitationService } = await import('../server/services/onboarding/invitations.ts');
const { SYSTEM_ACTOR } = await import('../server/auth/middleware.ts');

let base = '';
let server: any;
class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-quickloan': '1', cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
}
type Person = { id: string; full_name: string; id_number: string; phone: string };
let people: Person[] = [], noId: Person[] = [];
let org = '';
/** The lender's side of an invitation. It is issued outside this app; the tests call the service directly. */
const sendInvite = (p: Person) => invitationService.createAndSend({ ...SYSTEM_ACTOR(org), name: 'Umoja SACCO' }, p.id);
const tokenOf = (link: string) => link.split('/member/activate/')[1];
const inv = (t: string) => `/api/auth/invitations/${t}`;

/** The lender invites one member; returns the token from their personal link. */
const invite = async (p: Person) => tokenOf((await sendInvite(p)).link);
/** Open the link and pass the National ID check. */
async function identify(c: Client, token: string, p: Person) {
  const r = await c.post(`${inv(token)}/identity`, { idNumber: p.id_number });
  assert.equal(r.status, 200);
  return r.body.activationToken as string;
}
const consents = { acceptTerms: true, dataConsent: true, crbConsent: true };

before(async () => {
  db.open(':memory:');
  seedRoles();
  await seedIfEmpty();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  org = db.get(`SELECT id FROM organizations WHERE name = 'Umoja SACCO'`)!.id;
  people = (db.all(`SELECT r.* FROM registry_members r WHERE r.organization_id = ? AND NOT EXISTS (SELECT 1 FROM members m WHERE m.registry_member_id = r.id) ORDER BY r.member_number`, org) as Person[])
    .filter((p) => p.phone && normalizeKePhone(p.phone) && /^[0-9]{7,}$/.test(p.id_number));
  noId = db.all(`SELECT r.* FROM registry_members r WHERE r.organization_id = ? AND length(trim(r.id_number)) < 5`, org) as Person[];
  assert.ok(people.length >= 6, 'seed has members on the register who have not activated');
});
after(() => server?.close());

test('invitations are personal: org-scoped, opaque, and a new one replaces the old', async () => {
  const p = people[5];
  const imara = db.get(`SELECT id FROM organizations WHERE id <> ? LIMIT 1`, org)!.id;
  await assert.rejects(invitationService.createAndSend(SYSTEM_ACTOR(imara), p.id), { status: 404 }, 'another organization cannot invite this member');

  const first = await sendInvite(p);
  assert.equal(first.sent, true);
  const t1 = tokenOf(first.link);
  assert.ok(t1.length >= 40, 'token is long and random');
  assert.ok(!first.link.includes(p.id_number) && !first.link.includes(p.id), 'no member details in the URL');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM member_invitations WHERE token_hash = ?', t1)!.n, 0, 'only a hash of the token is stored');
  const sms = db.get(`SELECT body FROM sms_messages WHERE phone = ? ORDER BY created_at DESC`, normalizeKePhone(p.phone))!;
  assert.ok(sms.body.includes(first.link), 'the link is texted to the number on the SACCO record');

  const open = await new Client().get(inv(t1));
  assert.equal(open.status, 200);
  assert.equal(open.body.fullName, p.full_name);
  assert.equal(open.body.organization, 'Umoja SACCO');
  assert.ok(open.body.idNumberMasked.endsWith(p.id_number.slice(-2)) && !open.body.idNumberMasked.includes(p.id_number.slice(0, -2)), 'National ID is masked');
  assert.ok(!JSON.stringify(open.body).includes(localPhone(p.phone)), 'phone is not shown before the ID check');

  const t2 = await invite(p);
  assert.equal((await new Client().get(inv(t1))).status, 404, 'the earlier link stops working');
  assert.equal((await new Client().get(inv(t2))).status, 200);
  assert.equal((await new Client().get(inv('not-a-real-token-not-a-real-token-xxxx'))).status, 404);
  assert.equal((await new Client().get(inv('not-a-real-token-not-a-real-token-xxxx'))).body.error.code, 'INVITATION_INVALID');
});

test('TEST 1: ID matches and the SACCO phone is used → account activated, signed in, lands on the dashboard', async () => {
  const p = people[0], c = new Client();
  const token = await invite(p);
  const idr = await c.post(`${inv(token)}/identity`, { idNumber: ` ${p.id_number} ` });
  assert.equal(idr.status, 200);
  assert.equal(idr.body.recordedPhone, `${localPhone(p.phone).slice(0, 4)} ••• •••`, 'number on record is shown masked, after the ID check');
  const at = idr.body.activationToken;

  // Steps cannot be skipped
  assert.equal((await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '2580', ...consents })).body.error.code, 'PHONE_NOT_VERIFIED');
  assert.equal((await c.post(`${inv(token)}/phone`, { activationToken: 'forged.9999999999999.sig', useRecorded: true })).status, 401);

  const sent = await c.post(`${inv(token)}/phone`, { activationToken: at, useRecorded: true });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.isNewNumber, false);
  assert.match(sent.body.demoCode, /^\d{6}$/);
  const otpSms = db.get(`SELECT body FROM sms_messages WHERE phone = ? ORDER BY created_at DESC`, normalizeKePhone(p.phone))!;
  assert.ok(otpSms.body.includes('verification code') && !otpSms.body.includes(sent.body.demoCode), 'code is sent by SMS and not kept readable in the message log');
  assert.ok(!JSON.stringify(db.all('SELECT * FROM otp_challenges')).includes(sent.body.demoCode), 'codes are stored hashed');

  assert.equal((await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: sent.body.demoCode })).status, 200);
  // PIN rules
  assert.equal((await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '1111', ...consents })).body.error.code, 'WEAK_PIN');
  assert.equal((await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '1234', ...consents })).body.error.code, 'WEAK_PIN');
  assert.equal((await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '2580', acceptTerms: false, dataConsent: true })).status, 400);

  const done = await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '2580', ...consents });
  assert.equal(done.status, 201);
  assert.equal(done.body.redirect, '/member');
  assert.equal(done.body.phoneUpdatePending, false);
  const home = await c.get('/api/member/home');
  assert.equal(home.status, 200, 'signed in straight away — no trip back to the sign-in page');
  assert.equal(home.body.member.firstName, p.full_name.split(' ')[0]);
  const m = db.get('SELECT * FROM members WHERE registry_member_id = ?', p.id)!;
  assert.equal(m.phone, normalizeKePhone(p.phone));
  assert.ok(m.pin_hash.startsWith('scrypt$') && !m.pin_hash.includes('2580'), 'PIN is stored hashed');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM phone_change_requests WHERE member_id = ?', m.id)!.n, 0);
});

test('TEST 2: phone the member uses is registered to a relative → activation succeeds after the code; SIM ownership is never checked', async () => {
  const p = people[1], c = new Client();
  const token = await invite(p);
  const at = await identify(c, token, p);
  const relativesLine = '0790 111 222'; // a line in a parent's name: nothing about its owner is asked or looked up
  const sent = await c.post(`${inv(token)}/phone`, { activationToken: at, phone: relativesLine });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.isNewNumber, true);
  assert.equal(sent.body.phone, '0790 ••• •••');
  assert.equal((await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: sent.body.demoCode })).status, 200);
  const done = await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '4826', ...consents });
  assert.equal(done.status, 201);
  assert.equal((await c.get('/api/member/home')).status, 200);
  const profile = (await c.get('/api/member/profile')).body;
  assert.equal(profile.name, p.full_name, 'identity is still the SACCO member');
  assert.equal(profile.idNumber, p.id_number);
  assert.equal(profile.phone, '0790111222');
});

test('TEST 3: member uses a new number → verified and usable; SACCO record unchanged, update pending approval', async () => {
  const p = people[2], c = new Client();
  const token = await invite(p);
  const at = await identify(c, token, p);
  assert.equal((await c.post(`${inv(token)}/phone`, { activationToken: at, phone: '12345' })).body.error.code, 'INVALID_PHONE');
  assert.equal((await c.post(`${inv(token)}/phone`, { activationToken: at, phone: '0712345678' })).body.error.code, 'PHONE_IN_USE', 'cannot take a number another account signs in with');
  const sent = await c.post(`${inv(token)}/phone`, { activationToken: at, phone: '+254 798 000 333' });
  assert.equal(sent.status, 200);
  const v = await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: sent.body.demoCode });
  assert.equal(v.body.verified, true);
  assert.equal(v.body.isNewNumber, true);
  const done = await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '7391', ...consents });
  assert.equal(done.status, 201);
  assert.equal(done.body.phoneUpdatePending, true);
  const reg = db.get('SELECT * FROM registry_members WHERE id = ?', p.id)!;
  assert.equal(reg.phone, p.phone, 'the SACCO master record is not silently changed');
  assert.equal(reg.id_number, p.id_number);
  const pcr = db.get('SELECT * FROM phone_change_requests WHERE registry_member_id = ?', p.id)!;
  assert.equal(pcr.status, 'PENDING_APPROVAL');
  assert.equal(pcr.new_phone, '254798000333');
  assert.equal(pcr.recorded_phone, normalizeKePhone(p.phone));
  assert.equal((await new Client().post('/api/auth/member/login', { phone: '0798000333', pin: '7391' })).status, 200);
});

test('TEST 4: National ID does not match the invited member → blocked, nothing revealed, locked after repeated tries', async () => {
  const p = people[3], c = new Client();
  const token = await invite(p);
  const someoneElse = people[0].id_number; // a real ID, but not this member's
  const a = await c.post(`${inv(token)}/identity`, { idNumber: someoneElse });
  const b = await c.post(`${inv(token)}/identity`, { idNumber: '00000000' });
  assert.equal(a.status, 400);
  assert.equal(a.body.error.code, 'IDENTITY_MISMATCH');
  assert.deepEqual(a.body, b.body, 'same answer whether the ID is unknown or belongs to another member');
  assert.ok(!JSON.stringify(a.body).includes(p.id_number));
  assert.equal(a.body.error.message, 'We couldn’t verify these details. Please check your National ID and try again.');
  // Having the link alone gets you nothing further
  assert.equal((await c.post(`${inv(token)}/phone`, { activationToken: 'x'.repeat(40), useRecorded: true })).status, 401);
  for (let i = 0; i < 3; i++) await c.post(`${inv(token)}/identity`, { idNumber: '11112222' });
  const locked = await c.post(`${inv(token)}/identity`, { idNumber: p.id_number });
  assert.equal(locked.status, 423, 'even the right ID waits out the lock after 5 wrong tries');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM members WHERE registry_member_id = ?', p.id)!.n, 0);
  db.run('UPDATE member_invitations SET locked_until = NULL WHERE registry_member_id = ?', p.id);
  assert.equal((await c.post(`${inv(token)}/identity`, { idNumber: p.id_number })).status, 200, 'the rightful member can continue once the lock ends');
});

test('TEST 5 + 6: wrong code → error and attempt limit; expired code → resend works; resend is rate-limited', async () => {
  const p = people[4], c = new Client();
  const token = await invite(p);
  const at = await identify(c, token, p);
  const sent = await c.post(`${inv(token)}/phone`, { activationToken: at, useRecorded: true });
  const wrong = sent.body.demoCode === '000000' ? '111111' : '000000';

  const w = await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: wrong });
  assert.equal(w.status, 400);
  assert.equal(w.body.error.code, 'OTP_INCORRECT');
  assert.equal(w.body.error.details.attemptsLeft, 4);
  assert.equal((await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '2580', ...consents })).body.error.code, 'PHONE_NOT_VERIFIED');

  const soon = await c.post(`${inv(token)}/otp/resend`, { activationToken: at });
  assert.equal(soon.status, 429);
  assert.equal(soon.body.error.code, 'OTP_RESEND_TOO_SOON');
  assert.ok(soon.body.error.details.retryInSeconds > 0);

  // Expired code
  db.run(`UPDATE otp_challenges SET expires_at = ?, last_sent_at = ? WHERE subject_id IN (SELECT id FROM member_invitations WHERE registry_member_id = ?)`, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 120_000).toISOString(), p.id);
  const expired = await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: sent.body.demoCode });
  assert.equal(expired.body.error.code, 'OTP_EXPIRED');
  const again = await c.post(`${inv(token)}/otp/resend`, { activationToken: at });
  assert.equal(again.status, 200);
  assert.notEqual(again.body.demoCode, undefined);
  assert.equal((await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: sent.body.demoCode === again.body.demoCode ? wrong : sent.body.demoCode })).body.error.code, 'OTP_INCORRECT', 'the old code no longer works');

  // Too many wrong tries locks this code; a fresh one is needed
  for (let i = 0; i < 4; i++) await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: again.body.demoCode === '222222' ? '333333' : '222222' });
  const burnt = await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: again.body.demoCode });
  assert.equal(burnt.status, 429);
  assert.equal(burnt.body.error.code, 'OTP_TOO_MANY_ATTEMPTS', 'even the right code is refused after 5 wrong tries');
  db.run(`UPDATE otp_challenges SET last_sent_at = ? WHERE consumed_at IS NULL`, new Date(Date.now() - 120_000).toISOString());
  const fresh = await c.post(`${inv(token)}/otp/resend`, { activationToken: at });
  assert.equal((await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: fresh.body.demoCode })).status, 200);
  assert.equal((await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '9053', ...consents })).status, 201);
});

test('TEST 7: expired invitation link → blocked at every step', async () => {
  const p = people[5], c = new Client();
  const token = await invite(p);
  const at = await identify(c, token, p);
  db.run('UPDATE member_invitations SET expires_at = ? WHERE registry_member_id = ? AND status = ?', new Date(Date.now() - 1000).toISOString(), p.id, 'PENDING');
  const open = await c.get(inv(token));
  assert.equal(open.status, 410);
  assert.equal(open.body.error.code, 'INVITATION_EXPIRED');
  assert.ok(!JSON.stringify(open.body).includes(p.full_name), 'an expired link shows no member details');
  assert.equal((await c.post(`${inv(token)}/identity`, { idNumber: p.id_number })).status, 410);
  assert.equal((await c.post(`${inv(token)}/phone`, { activationToken: at, useRecorded: true })).status, 410);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM members WHERE registry_member_id = ?', p.id)!.n, 0);
});

test('TEST 8: an invitation that has been used cannot be used again, and no second invitation is issued', async () => {
  const p = people[0]; // activated in TEST 1
  const used = db.get(`SELECT * FROM member_invitations WHERE registry_member_id = ? AND status = 'ACTIVATED'`, p.id)!;
  assert.ok(used.activated_at && used.member_id);
  // The original token is unknown to us (only its hash is stored); replay a fresh flow against the same member instead.
  await assert.rejects(sendInvite(p), { status: 409, code: 'ALREADY_ACTIVATED' });

  // Full replay: activate once, then try every step again with the same link.
  const q = people[6] ?? people[5], c = new Client();
  const token = await invite(q);
  const at = await identify(c, token, q);
  const sent = await c.post(`${inv(token)}/phone`, { activationToken: at, phone: '0791 555 666' });
  await c.post(`${inv(token)}/otp/verify`, { activationToken: at, code: sent.body.demoCode });
  assert.equal((await c.post(`${inv(token)}/activate`, { activationToken: at, pin: '6172', ...consents })).status, 201);
  const other = new Client();
  const reopen = await other.get(inv(token));
  assert.equal(reopen.status, 409);
  assert.equal(reopen.body.error.code, 'INVITATION_USED');
  assert.equal((await other.post(`${inv(token)}/identity`, { idNumber: q.id_number })).status, 409);
  assert.equal((await other.post(`${inv(token)}/activate`, { activationToken: at, pin: '6172', ...consents })).status, 409);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM members WHERE registry_member_id = ?', q.id)!.n, 1);
});

test('TEST 9: returning member signs in with phone + PIN; forgot PIN needs National ID + code and does not reveal accounts', async () => {
  const p = people[0];
  const c = new Client();
  assert.equal((await c.post('/api/auth/member/login', { phone: localPhone(p.phone), pin: '2580' })).status, 200);
  assert.equal((await c.get('/api/member/home')).status, 200);
  assert.equal((await new Client().post('/api/auth/member/login', { phone: localPhone(p.phone), pin: '0000' })).status, 401);

  // Forgot PIN — same reply for a real account, a wrong ID and an unknown phone
  const real = await new Client().post('/api/auth/member/pin-reset/start', { phone: localPhone(p.phone), idNumber: p.id_number });
  const wrongId = await new Client().post('/api/auth/member/pin-reset/start', { phone: localPhone(p.phone), idNumber: '99999999' });
  const unknown = await new Client().post('/api/auth/member/pin-reset/start', { phone: '0799 999 999', idNumber: p.id_number });
  for (const r of [real, wrongId, unknown]) { assert.equal(r.status, 200); assert.ok(r.body.resetId); }
  assert.deepEqual(Object.keys(wrongId.body).filter((k) => k !== 'demoCode').sort(), Object.keys(real.body).filter((k) => k !== 'demoCode').sort());
  assert.equal(wrongId.body.demoCode, undefined, 'no code is sent unless phone and National ID both match');

  // A phone alone (e.g. a relative holding it) cannot reset the PIN
  assert.equal((await new Client().post('/api/auth/member/pin-reset/complete', { resetId: wrongId.body.resetId, code: '123456', pin: '8642' })).status, 400);
  assert.equal((await new Client().post('/api/auth/member/pin-reset/complete', { resetId: real.body.resetId, code: real.body.demoCode, pin: '1111' })).body.error.code, 'WEAK_PIN');
  const r = new Client();
  const done = await r.post('/api/auth/member/pin-reset/complete', { resetId: real.body.resetId, code: real.body.demoCode, pin: '8642' });
  assert.equal(done.status, 200);
  assert.equal(done.body.signedIn, true);
  assert.equal((await r.get('/api/member/home')).status, 200);
  assert.equal((await c.get('/api/member/home')).status, 401, 'other sessions are signed out when the PIN changes');
  assert.equal((await new Client().post('/api/auth/member/login', { phone: localPhone(p.phone), pin: '2580' })).status, 401, 'old PIN no longer works');
  assert.equal((await new Client().post('/api/auth/member/login', { phone: localPhone(p.phone), pin: '8642' })).status, 200);
  assert.equal((await new Client().post('/api/auth/member/pin-reset/complete', { resetId: real.body.resetId, code: real.body.demoCode, pin: '8642' })).status, 400, 'a reset code works once');

  // The old open self-registration is gone
  assert.equal((await new Client().post('/api/auth/member/activate/verify', { organizationId: 'x', memberNumber: 'MBR-006', idNumber: '67890123' })).status, 404);
});

test('audit trail records invitations, activations and PIN resets; demo invitation endpoint works in demo mode only', async () => {
  const actions = db.all('SELECT DISTINCT action FROM audit_logs').map((a: any) => a.action);
  for (const a of ['MEMBER_INVITED', 'MEMBER_ACTIVATED', 'MEMBER_PIN_RESET', 'INVITATION_LOCKED']) assert.ok(actions.includes(a), `${a} is audited`);
  // A member with no usable National ID on the register cannot be invited: there would be nothing to verify against.
  if (noId.length) await assert.rejects(sendInvite(noId[0]), { code: 'NO_ID_ON_RECORD' });
  const demo = await new Client().post('/api/public/demo/invitation');
  assert.equal(demo.status, 200);
  assert.match(demo.body.link, /^\/member\/activate\/.{40,}$/);
  assert.equal((await new Client().get(inv(tokenOf(demo.body.link)))).status, 200);
});
