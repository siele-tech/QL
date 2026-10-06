/**
 * End-to-end acceptance tests over the real HTTP API (in-process server, fresh demo database).
 * Covers the member journey, member isolation, loan calculations, state transitions and
 * behaviour updates.
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

let base = '';
let server: any;

class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-quickloan': '1', cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const json: any = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 12000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) { await sleep(250); v = await fn(); }
  return v;
}

const john = new Client(), mary = new Client(), anon = new Client();

before(async () => {
  db.open(':memory:');
  seedRoles();
  await seedIfEmpty();
  await runDailyProcessing();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await john.post('/api/auth/member/login', { phone: '0712345678', pin: '1234' })).status, 200);
  assert.equal((await mary.post('/api/auth/member/login', { phone: '0722000002', pin: '1234' })).status, 200);
});
after(() => server?.close());

test('authentication: wrong PIN rejected, CSRF header required, anonymous blocked', async () => {
  assert.equal((await anon.post('/api/auth/member/login', { phone: '0712345678', pin: '9999' })).status, 401);
  const noHeader = await fetch(base + '/api/auth/logout', { method: 'POST' });
  assert.equal(noHeader.status, 403);
  assert.equal((await anon.get('/api/member/home')).status, 401);
});

test('member home answers: can I borrow, how much, how am I doing', async () => {
  const { body } = await john.get('/api/member/home');
  assert.equal(body.eligibility.available, 20000);
  assert.equal(body.eligibility.canBorrow, true);
  assert.equal(body.currentLoan, null);
  assert.equal(body.behaviour.score, 86);
  assert.equal(body.behaviour.completedLoans, 4);
  assert.equal(body.behaviour.onTime, 4);
  // Repayment progress: earned by repaying on time, never by borrowing more
  assert.equal(body.behaviour.onTimeRate, 100);
  assert.equal(body.behaviour.streak, 4);
  assert.equal(body.behaviour.level.name, 'Reliable');
  assert.equal(body.behaviour.level.next.name, 'Trusted');
  assert.equal(body.behaviour.level.next.onTimeNeeded, 1);
  assert.ok(!JSON.stringify(body).includes('742'), 'CRB score must not be exposed to the member');
});

test('member isolation: cannot read another member’s loan', async () => {
  const maryHome = await mary.get('/api/member/home');
  const loanId = maryHome.body.currentLoan.id;
  assert.equal(maryHome.body.currentLoan.outstanding, 8000);
  assert.equal(maryHome.body.currentLoan.daysRemaining, 5);
  assert.equal((await john.get(`/api/member/loans/${loanId}`)).status, 404);
});

let johnLoanId = '';
test('member journey: quote → apply → auto-approved → disbursed → partial → full repayment → behaviour/limit update', async () => {
  const home = await john.get('/api/member/home');
  const emergency = home.body.eligibility.products.find((p: any) => p.name === 'Emergency Loan');
  // Cannot exceed limit
  const over = await john.post('/api/member/applications', { productId: emergency.id, amount: 25000, acceptTerms: true, crbConsent: true });
  assert.equal(over.status, 400);
  // Terms required
  assert.equal((await john.post('/api/member/applications', { productId: emergency.id, amount: 10000, acceptTerms: false })).status, 400);

  const q = await john.post('/api/member/quote', { productId: emergency.id, amount: 10000 });
  assert.equal(q.body.quote.interest, 800); // 8% per 30 days
  assert.equal(q.body.quote.totalRepayable, 10800);

  const app = await john.post('/api/member/applications', { productId: emergency.id, amount: 10000, acceptTerms: true, crbConsent: true });
  assert.equal(app.status, 201);
  assert.equal(app.body.status, 'APPLIED');
  // Second application while one is pending is blocked
  assert.equal((await john.post('/api/member/applications', { productId: emergency.id, amount: 2000, acceptTerms: true })).status, 422);

  const done = await until(() => john.get(`/api/member/applications/${app.body.id}`), (r) => r.body.status === 'DISBURSED' && !!r.body.loanId);
  assert.equal(done.body.status, 'DISBURSED');
  const seen = done.body.history.map((h: any) => h.to);
  assert.deepEqual(seen, ['APPLIED', 'UNDER_REVIEW', 'APPROVED', 'DISBURSING', 'DISBURSED']);
  johnLoanId = done.body.loanId;

  let loan = (await john.get(`/api/member/loans/${johnLoanId}`)).body;
  assert.equal(loan.status, 'ACTIVE');
  assert.equal(loan.outstanding, 10800);
  assert.equal(loan.earlyRepayment.saving, 400); // 50% of 800 interest for 30/30 unused days
  assert.equal((await john.get('/api/member/home')).body.eligibility.available, 0);

  // Partial repayment of 3,000 from another M-PESA number (e.g. a relative paying for the member)
  assert.equal((await john.post(`/api/member/loans/${johnLoanId}/repay`, { amount: 3000, phone: '12345' })).status, 400, 'invalid payer number rejected');
  const pay = await john.post(`/api/member/loans/${johnLoanId}/repay`, { amount: 3000, phone: '+254 722 111 222' });
  assert.equal(pay.status, 202);
  assert.equal(pay.body.phone, '0722111222', 'prompt goes to the payer number');
  const paid = await until(() => john.get(`/api/member/payments/${pay.body.id}`), (r) => r.body.status !== 'PENDING');
  assert.equal(paid.body.status, 'SUCCESS');
  loan = (await until(() => john.get(`/api/member/loans/${johnLoanId}`), (r) => r.body.outstanding === 7800)).body;
  assert.equal(loan.amountPaid, 3000);
  assert.equal(loan.outstanding, 7800);
  assert.equal(loan.repayments[0].balanceBefore, 10800);
  assert.equal(loan.repayments[0].balanceAfter, 7800);
  assert.equal(loan.repayments[0].paidFrom, '0722111222', 'payer number recorded on the repayment');
  assert.equal(loan.earlyRepayment.saving, 400, 'early saving survives a partial payment');

  // Overpayment rejected; simulated failure leaves balance unchanged
  assert.equal((await john.post(`/api/member/loans/${johnLoanId}/repay`, { amount: 99999 })).status, 400);
  const fail = await john.post(`/api/member/loans/${johnLoanId}/repay`, { amount: 999 });
  const failed = await until(() => john.get(`/api/member/payments/${fail.body.id}`), (r) => r.body.status !== 'PENDING');
  assert.equal(failed.body.status, 'FAILED');
  assert.equal((await john.get(`/api/member/loans/${johnLoanId}`)).body.outstanding, 7800);

  // Full early repayment with saving
  const payoffAmount = loan.earlyRepayment.payoffAmount;
  assert.equal(payoffAmount, 7400);
  const full = await john.post(`/api/member/loans/${johnLoanId}/repay`, { amount: payoffAmount });
  await until(() => john.get(`/api/member/payments/${full.body.id}`), (r) => r.body.status !== 'PENDING');
  loan = (await until(() => john.get(`/api/member/loans/${johnLoanId}`), (r) => r.body.status === 'REPAID')).body;
  assert.equal(loan.status, 'REPAID');
  assert.equal(loan.outstanding, 0);
  assert.equal(loan.rebate, 400);
  assert.equal(loan.outcome, 'EARLY');

  const b = (await john.get('/api/member/behaviour')).body;
  assert.equal(b.completedLoans, 5);
  assert.equal(b.early, 3);
  assert.equal(b.score, 89);
  assert.equal(b.streak, 5);
  assert.equal(b.level.name, 'Trusted', 'five on-time loans and a score of 80+ reach the top level');
  assert.equal(b.level.next, null);
  // Unread badge count matches the list, and clears when everything is read
  const list = (await john.get('/api/member/notifications')).body;
  const unread = (await john.get('/api/member/notifications/unread-count')).body.unread;
  assert.equal(unread, list.filter((n: any) => !n.read_at).length);
  assert.ok(unread > 0);
  await john.post('/api/member/notifications/read-all', {});
  assert.equal((await john.get('/api/member/notifications/unread-count')).body.unread, 0);
  assert.equal((await mary.get('/api/member/notifications/unread-count')).status, 200);
  assert.equal(b.limit, 22500); // (10,000 + 2,500 × 5 on-time) × 1.0
  const hist = (await john.get('/api/member/loans')).body;
  assert.equal(hist.filter((l: any) => l.status === 'REPAID').length, 5);
  const notes = (await john.get('/api/member/notifications')).body.map((n: any) => n.type);
  for (const t of ['LOAN_DISBURSED', 'PAYMENT_RECEIVED', 'LOAN_REPAID', 'PAYMENT_FAILED']) assert.ok(notes.includes(t), t);
});

test('repayment prompt can be sent again: only after a wait, only by its owner, and never once the money is in', async () => {
  const loan = (await mary.get('/api/member/home')).body.currentLoan;
  const amount = (await mary.get('/api/member/loans/' + loan.id)).body.product.allowPartial ? 100 : loan.outstanding;
  const first = await mary.post('/api/member/loans/' + loan.id + '/repay', { amount });
  assert.equal(first.status, 202);

  // straight away is too soon, and another member cannot touch it
  const soon = await mary.post('/api/member/payments/' + first.body.id + '/resend');
  assert.equal(soon.status, 409);
  assert.equal(soon.body.error.code, 'RESEND_TOO_SOON');
  assert.equal((await john.post('/api/member/payments/' + first.body.id + '/resend')).status, 404);

  // a prompt that never arrived: still pending half a minute later
  db.run('UPDATE payment_transactions SET created_at = ? WHERE id = ?', new Date(Date.now() - 30_000).toISOString(), first.body.id);
  const again = await mary.post('/api/member/payments/' + first.body.id + '/resend');
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.notEqual(again.body.id, first.body.id);
  assert.equal(again.body.amount, amount);
  assert.equal(again.body.phone, first.body.phone);
  // the first request was not cancelled: if it is approved after all, the money still counts
  assert.equal(db.get('SELECT status FROM payment_transactions WHERE id = ?', first.body.id)!.status, 'PENDING');

  const done = await until(() => mary.get('/api/member/payments/' + again.body.id), (r) => r.body.status !== 'PENDING');
  assert.equal(done.body.status, 'SUCCESS');
  const late = await mary.post('/api/member/payments/' + again.body.id + '/resend');
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'PAYMENT_RECEIVED');
});
