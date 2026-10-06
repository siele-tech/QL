/**
 * Refinement acceptance tests, member side: what a member sees when the lender enables a loan,
 * late fee → rollover → default, reminders, CRB self-check, statements and core-banking sync.
 * In-process server, fresh demo database.
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
const { runDailyProcessing } = await import('../server/lending/collections.ts');
const { addDays, today, clock } = await import('../server/lib/clock.ts');
const { enableLoan, setOfferingStatus } = await import('../server/lending/offerings.ts');
const { saveOrgSettings } = await import('../server/services/orgSettings.ts');
const { SYSTEM_ACTOR } = await import('../server/auth/middleware.ts');
const { newId } = await import('../server/lib/ids.ts');

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
  put = (p: string, b: unknown) => this.req('PUT', p, b);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 12000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) { await sleep(250); v = await fn(); }
  return v;
}

const john = new Client(), faith = new Client(), mary = new Client();
const channels = { sms: true, push: true, app: true };

/**
 * The lender's side. Products and loan offers are managed outside this app, so the tests set them
 * up directly through the lending services and the database.
 */
let org = '';
const lender = () => ({ ...SYSTEM_ACTOR(org), name: 'Umoja SACCO' });
const segmentId = (name?: string) => db.get(name ? 'SELECT id FROM segments WHERE organization_id = ? AND name = ?' : 'SELECT id FROM segments WHERE organization_id = ? AND is_system = 1', ...(name ? [org, name] : [org]))!.id as string;
function addProduct(p: Record<string, unknown>) {
  const id = newId('prd'), now = clock.nowIso();
  db.insert('loan_products', {
    id, organization_id: org, status: 'ACTIVE', created_at: now, updated_at: now, fee_type: 'NONE', fee_value: 0, allow_partial: 1,
    early_repayment_enabled: 0, rollover_enabled: 0, approval_mode: 'AUTO', ...p,
  });
  db.insert('eligibility_rules', { id: newId('rul'), product_id: id, field: 'ACTIVE_MEMBER', operator: 'IS', value: 'true', position: 0 });
  return id;
}
const enable = (input: Record<string, unknown>) => enableLoan(lender(), input as any, 'http://localhost:5173');

before(async () => {
  db.open(':memory:');
  seedRoles();
  await seedIfEmpty();
  await runDailyProcessing();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  org = db.get(`SELECT id FROM organizations WHERE name = 'Umoja SACCO'`)!.id;
  assert.equal((await john.post('/api/auth/member/login', { phone: '0712345678', pin: '1234' })).status, 200);
  assert.equal((await faith.post('/api/auth/member/login', { phone: '0744000004', pin: '1234' })).status, 200);
  assert.equal((await mary.post('/api/auth/member/login', { phone: '0722000002', pin: '1234' })).status, 200);
});
after(() => server?.close());

let newProductId = '';
test('enable loan: a product is invisible to members until enabled for their segment; pause hides it again', async () => {
  newProductId = addProduct({
    name: 'Holiday Loan', min_amount: 1000, max_amount: 10000, period_days: 14, fee_type: 'FIXED', fee_value: 100, interest_rate_monthly: 4,
    rollover_enabled: 1, rollover_fee_pct: 3, rollover_max: 2, rollover_mode: 'PAY_TO_EXTEND',
    late_fee_type: 'FIXED', late_fee_value: 150, late_fee_grace_days: 1,
  });
  let el = (await john.get('/api/member/eligibility')).body;
  assert.ok(!el.products.some((p: any) => p.id === newProductId), 'not offered yet');

  const offeringId = await enable({ productId: newProductId, segmentId: segmentId(), availability: 'ONGOING', amountMode: 'LIMIT', channels, notifyNow: true });

  el = (await john.get('/api/member/eligibility')).body;
  const offered = el.products.find((p: any) => p.id === newProductId);
  assert.equal(offered.offeredVia, 'ONGOING');
  assert.equal(offered.lateFeeText, 'KES 150 after 1 day past the due date');
  const notes = (await john.get('/api/member/notifications')).body;
  assert.ok(notes.some((n: any) => n.type === 'OFFER' && n.title.includes('Holiday Loan')), 'member told through the app');

  setOfferingStatus(lender(), offeringId, 'PAUSED');
  el = (await john.get('/api/member/eligibility')).body;
  assert.ok(!el.products.some((p: any) => p.id === newProductId), 'paused loan is hidden');
  setOfferingStatus(lender(), offeringId, 'ACTIVE');
  el = (await john.get('/api/member/eligibility')).body;
  assert.ok(el.products.some((p: any) => p.id === newProductId), 'offered again once resumed');
});

test('enable loan: one-time offer creates personal, expiring offers for eligible members', async () => {
  const productId = addProduct({ name: 'Festive Top-up', min_amount: 1000, max_amount: 5000, period_days: 10, interest_rate_monthly: 5 });
  await enable({ productId, segmentId: segmentId('Quality-checked members'), availability: 'ONE_TIME', amountMode: 'FIXED', fixedAmount: 3000, expiryDays: 7, channels });
  assert.ok(db.get('SELECT COUNT(*) AS n FROM loan_offers WHERE product_id = ?', productId)!.n > 0, 'personal offers created');
  const el = (await john.get('/api/member/eligibility')).body;
  const p = el.products.find((x: any) => x.id === productId);
  assert.equal(p.offeredVia, 'OFFER');
  assert.ok(p.offerToken);
  assert.equal(p.maxAmount, 3000, 'fixed offer amount caps the loan');
});

test('overdue: late fee once per due date → automatic rollover → default after the maximum', async () => {
  const productId = addProduct({
    name: 'Auto Roll Loan', min_amount: 1000, max_amount: 20000, period_days: 7, interest_rate_monthly: 10,
    rollover_enabled: 1, rollover_fee_pct: 10, rollover_max: 1, rollover_mode: 'AUTOMATIC', rollover_after_max: 'DEFAULT',
    late_fee_type: 'FIXED', late_fee_value: 100, late_fee_grace_days: 0,
  });
  await enable({ productId, segmentId: segmentId(), availability: 'ONGOING', amountMode: 'LIMIT', channels: { sms: false, push: false, app: true }, notifyNow: false });
  const app = await faith.post('/api/member/applications', { productId, amount: 5000, acceptTerms: true, crbConsent: true });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  const done = await until(() => faith.get(`/api/member/applications/${app.body.id}`), (r) => r.body.status === 'DISBURSED' && !!r.body.loanId);
  const loanId = done.body.loanId;

  // Due date passes unpaid.
  db.run('UPDATE loans SET due_date = ? WHERE id = ?', addDays(today(), -1), loanId);
  await runDailyProcessing();
  let loan = (await faith.get(`/api/member/loans/${loanId}`)).body;
  assert.equal(loan.lateFees, 100, 'late fee added once');
  assert.equal(loan.status, 'ROLLED_OVER', 'rolled over automatically');
  assert.equal(loan.rolloverCount, 1);
  assert.equal(loan.rolloverFees, 500, '10% of KES 5,000 principal');
  assert.equal(loan.interest, 117, '10% a month for 7 days');
  assert.equal(loan.outstanding, 5000 + 117 + 100 + 500);
  await runDailyProcessing();
  assert.equal((await faith.get(`/api/member/loans/${loanId}`)).body.lateFees, 100, 'idempotent: no second fee for the same due date');
  assert.equal((await faith.post(`/api/member/loans/${loanId}/rollover`)).status, 400, 'member cannot roll over an automatic-rollover loan');

  // Misses the extended due date too → second late fee → maximum reached → default (product setting).
  db.run('UPDATE loans SET due_date = ? WHERE id = ?', addDays(today(), -2), loanId);
  await runDailyProcessing();
  loan = (await faith.get(`/api/member/loans/${loanId}`)).body;
  assert.equal(loan.lateFees, 200);
  assert.equal(loan.status, 'DEFAULTED');
  const events = db.all('SELECT event FROM core_sync_log WHERE loan_id = ? ORDER BY created_at', loanId).map((e: any) => e.event);
  for (const e of ['LOAN_CREATED', 'DISBURSEMENT', 'LATE_FEE', 'ROLLOVER', 'LOAN_DEFAULTED']) assert.ok(events.includes(e), `core sync: ${e}`);
  assert.ok(db.all('SELECT status FROM core_sync_log WHERE loan_id = ?', loanId).every((r: any) => r.status === 'SYNCED'));
});

test('rollover is a product setting: pay-to-extend only once due; rollover reminder sent with the amount', async () => {
  const home = (await mary.get('/api/member/home')).body;
  const loanId = home.currentLoan.id;
  assert.equal((await mary.post(`/api/member/loans/${loanId}/rollover`)).status, 400, 'not before the due date');
  db.run('UPDATE loans SET due_date = ?, status = ? WHERE id = ?', today(), 'ACTIVE', loanId);
  await runDailyProcessing();
  const sent = db.all('SELECT reminder_key FROM reminder_log WHERE loan_id = ?', loanId).map((r: any) => r.reminder_key);
  assert.ok(sent.includes('DUE_TODAY') && sent.includes('ROLLOVER_AVAILABLE'));
  const notes = (await mary.get('/api/member/notifications')).body;
  const ro = notes.find((n: any) => n.title === 'Rollover available');
  assert.match(ro.body, /you can pay KES [\d,]+ to move your Umoja SACCO loan due date/);
  const due = notes.find((n: any) => n.title === 'Your loan is due today');
  assert.match(due.body, /late fee of 5% of the amount due/, 'late fee is stated before it applies');
  const loan = (await mary.get(`/api/member/loans/${loanId}`)).body;
  assert.equal(loan.rolloverTerms.max, 2);
  const r = await mary.post(`/api/member/loans/${loanId}/rollover`);
  assert.equal(r.status, 202, JSON.stringify(r.body));
});

test('member checks their own CRB status and pays the CRB fee; the lender’s settings are respected', async () => {
  let st = (await john.get('/api/member/crb')).body;
  assert.equal(st.enabled, true);
  assert.equal(st.feeKes, 50, 'default fee is configurable');
  assert.equal(st.latest.score, 742);
  assert.equal(st.latest.checkedBy, 'Your lender');
  assert.equal(st.canCheckNow, true, 'a paying member may check any time');
  const checksBefore = db.get('SELECT COUNT(*) AS c FROM crb_checks')!.c;

  // A failed payment runs no check and charges nothing (mock: numbers ending 0000 decline).
  const fail = await john.post('/api/member/crb/check', { phone: '0722110000' });
  assert.equal(fail.status, 202);
  const failed = await until(() => john.get(`/api/member/payments/${fail.body.payment.id}`), (r) => r.body.status !== 'PENDING');
  assert.equal(failed.body.status, 'FAILED');
  assert.match(failed.body.message, /No CRB check was run/);
  await sleep(1500);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM crb_checks')!.c, checksBefore, 'no check without payment');

  // Paying the fee runs the check.
  const start = await john.post('/api/member/crb/check');
  assert.equal(start.status, 202, JSON.stringify(start.body));
  assert.equal(start.body.payment.amount, 50);
  const paid = await until(() => john.get(`/api/member/payments/${start.body.payment.id}`), (r) => r.body.status !== 'PENDING');
  assert.equal(paid.body.status, 'SUCCESS');
  st = (await until(() => john.get('/api/member/crb'), (r) => r.body.latest?.checkedBy === 'You')).body;
  assert.equal(st.latest.checkedBy, 'You');
  assert.equal(st.latest.feePaid, 50);
  assert.equal(st.latest.score, 742);
  assert.equal(st.hasCredit, false);
  assert.ok(db.get(`SELECT 1 AS ok FROM core_sync_log WHERE event = 'CRB_FEE'`), 'fee reported to core banking');

  // The check is recorded against the member, with the fee they paid.
  const paidAudit = db.get(`SELECT actor_name FROM audit_logs WHERE action = 'CRB_FEE_PAID' ORDER BY created_at DESC`)!;
  assert.equal(paidAudit.actor_name, 'John Kamau');

  // Lender settings: a free check respects the interval; switched off blocks self-checks.
  const cfg = { memberSelfCheck: true, selfCheckIntervalDays: 30, selfCheckFeeKes: 0 };
  saveOrgSettings(org, { crb: cfg });
  assert.equal((await john.post('/api/member/crb/check')).status, 429, 'free checks are limited by the interval');
  assert.notEqual((await faith.get('/api/member/crb')).body.latest?.id, st.latest.id, 'members only see their own record');
  saveOrgSettings(org, { crb: { ...cfg, memberSelfCheck: false } });
  assert.equal((await faith.post('/api/member/crb/check')).status, 403);
});

test('loan statements: a member downloads their own as PDF; others cannot', async () => {
  const pdf = async (c: Client, path: string) => {
    const res = await fetch(base + path, { headers: { cookie: c.cookie } });
    return { status: res.status, type: res.headers.get('content-type') ?? '', name: res.headers.get('content-disposition') ?? '', text: Buffer.from(await res.arrayBuffer()).toString('latin1') };
  };
  const peter = new Client();
  await peter.post('/api/auth/member/login', { phone: '0733000003', pin: '1234' });
  const loan = (await peter.get('/api/member/home')).body.currentLoan;

  const one = await pdf(peter, `/api/member/loans/${loan.id}/statement.pdf`);
  assert.equal(one.status, 200);
  assert.match(one.type, /application\/pdf/);
  assert.match(one.name, new RegExp(`loan-statement-${loan.reference}\.pdf`));
  assert.ok(one.text.startsWith('%PDF-1.4') && one.text.trimEnd().endsWith('%%EOF'));
  for (const s of ['Umoja SACCO', 'Peter Otieno', 'LOAN STATEMENT', loan.reference, 'Loan disbursed', 'Late-payment fee', 'Partial payment', 'Outstanding balance', '12,600']) assert.ok(one.text.includes(s), `statement shows "${s}"`);

  const all = await pdf(peter, '/api/member/statement.pdf');
  assert.equal(all.status, 200);
  assert.ok(all.text.includes('STATEMENT OF LOANS') && all.text.includes(loan.reference));

  assert.equal((await pdf(john, `/api/member/loans/${loan.id}/statement.pdf`)).status, 404, 'another member cannot download it');
  assert.equal((await pdf(new Client(), `/api/member/loans/${loan.id}/statement.pdf`)).status, 401);
});
