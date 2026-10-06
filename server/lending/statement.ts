import { db } from '../db/db.ts';
import { clock, eatDate } from '../lib/clock.ts';
import { notFound } from '../lib/errors.ts';
import { PAGE, PdfDoc } from '../lib/pdf.ts';
import { getOrg } from '../services/orgSettings.ts';
import { registry } from '../services/registry.ts';
import { localPhone } from '../services/sms/provider.ts';
import { lateFeeText, outstanding } from './pricing.ts';

/**
 * LOAN STATEMENTS (PDF) — a member's own record of a loan: terms, every charge and payment with a
 * running balance, and what is still owed. Built from the same loan, repayment and history records
 * the app shows; nothing here is computed differently from the engine.
 */
const TEAL: [number, number, number] = [5, 117, 115];
const kes = (n: number) => Math.round(n).toLocaleString('en-KE');
const day = (d: string | null | undefined) => (d ? new Date((d.length === 10 ? d : eatDate(d)) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '-');
const STATUS: Record<string, string> = { ACTIVE: 'Active', DUE: 'Due today', OVERDUE: 'Overdue', REPAID: 'Repaid', DEFAULTED: 'Defaulted', ROLLED_OVER: 'Rolled over' };
const PAY_TYPE: Record<string, string> = { FULL: 'Full repayment', PARTIAL: 'Partial payment', ROLLOVER_FEE: 'Rollover payment' };
const CHANNEL: Record<string, string> = { MPESA: 'M-PESA', CASH: 'Cash', BANK: 'Bank', MPESA_PAYBILL: 'M-PESA Paybill', CHEQUE: 'Cheque' };

export interface LedgerRow { at: string; description: string; charge: number; payment: number; balance: number }

/** Every charge and payment on a loan, oldest first, with the running balance. */
export function loanLedger(loan: any): LedgerRow[] {
  const rows: { at: string; order: number; description: string; charge: number; payment: number }[] = [];
  rows.push({ at: loan.disbursed_at, order: 0, description: 'Loan disbursed', charge: loan.principal, payment: 0 });
  if (loan.interest_amount) rows.push({ at: loan.disbursed_at, order: 1, description: `Interest (${loan.period_days} days)`, charge: loan.interest_amount, payment: 0 });
  if (loan.fee_amount) rows.push({ at: loan.disbursed_at, order: 2, description: 'Loan fee', charge: loan.fee_amount, payment: 0 });
  for (const h of db.all(`SELECT note, created_at FROM status_history WHERE entity_type = 'LOAN' AND entity_id = ? ORDER BY created_at, rowid`, loan.id)) {
    const late = /^Late fee KES ([\d,]+)/.exec(h.note ?? '');
    if (late) rows.push({ at: h.created_at, order: 3, description: 'Late-payment fee', charge: Number(late[1].replace(/,/g, '')), payment: 0 });
    const roll = /rollover fee KES ([\d,]+)/i.exec(h.note ?? '');
    if (roll && Number(roll[1].replace(/,/g, '')) > 0) rows.push({ at: h.created_at, order: 3, description: 'Rollover fee', charge: Number(roll[1].replace(/,/g, '')), payment: 0 });
  }
  for (const r of db.all('SELECT * FROM repayments WHERE loan_id = ? ORDER BY paid_at, rowid', loan.id)) {
    rows.push({ at: r.paid_at, order: 5, description: `${PAY_TYPE[r.type] ?? 'Payment'} - ${CHANNEL[r.channel] ?? r.channel}${r.reference ? ' ' + r.reference : ''}`, charge: 0, payment: r.amount });
    if (r.rebate) rows.push({ at: r.paid_at, order: 6, description: 'Early repayment saving', charge: 0, payment: r.rebate });
  }
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order));
  let balance = 0;
  return rows.map((r) => { balance += r.charge - r.payment; return { at: r.at, description: r.description, charge: r.charge, payment: r.payment, balance: Math.max(0, balance) }; });
}

function who(memberId: string) {
  const m = db.get('SELECT * FROM members WHERE id = ?', memberId)!;
  const idn = registry.get(m.registry_member_id);
  const org = getOrg(m.organization_id);
  return { name: idn?.fullName ?? 'Member', memberNumber: idn?.memberNumber ?? '-', phone: localPhone(m.phone), orgName: org?.name ?? 'QuickLoan' };
}

function header(doc: PdfDoc, title: string, w: ReturnType<typeof who>) {
  const L = PAGE.margin, R = PAGE.width - PAGE.margin;
  doc.rect(0, 0, PAGE.width, 74, TEAL);
  doc.color(255, 255, 255).text(L, 34, w.orgName, 'bold', 17).text(L, 54, 'QuickLoan', 'regular', 10);
  doc.right(R, 34, title.toUpperCase(), 11, true).right(R, 54, `Issued ${day(clock.nowIso())}`, 8.5);
  doc.color(0, 0, 0);
  doc.y = 100;
  doc.text(L, doc.y, w.name, 'bold', 12);
  doc.text(L, doc.y + 15, `Member number ${w.memberNumber}   |   Phone ${w.phone}`, 'regular', 9.5);
  doc.y += 36;
}

function pairs(doc: PdfDoc, items: [string, string][], cols = 2) {
  const L = PAGE.margin, colW = (PAGE.width - 2 * PAGE.margin) / cols;
  items.forEach(([k, v], i) => {
    const x = L + (i % cols) * colW, y = doc.y + Math.floor(i / cols) * 16;
    doc.color(110, 110, 110).text(x, y, k, 'regular', 8.5).color(0, 0, 0).text(x + 112, y, v, 'bold', 9);
  });
  doc.y += Math.ceil(items.length / cols) * 16 + 8;
}

function sectionTitle(doc: PdfDoc, t: string) {
  doc.ensure(40);
  doc.color(...TEAL).text(PAGE.margin, doc.y, t.toUpperCase(), 'bold', 9).color(0, 0, 0);
  doc.line(PAGE.margin, doc.y + 5, PAGE.width - PAGE.margin, doc.y + 5, 0.8, 0.6);
  doc.y += 20;
}

/** Table with a header row repeated on each page. Numeric columns are right-aligned. */
function table(doc: PdfDoc, cols: { title: string; x: number; right?: boolean; max?: number }[], rows: string[][], boldLast = false) {
  const head = () => {
    cols.forEach((c) => (c.right ? doc.right(c.x, doc.y, c.title, 8, true) : doc.text(c.x, doc.y, c.title, 'bold', 8)));
    doc.line(PAGE.margin, doc.y + 5, PAGE.width - PAGE.margin, doc.y + 5);
    doc.y += 17;
  };
  head();
  rows.forEach((r, i) => {
    if (doc.ensure(16)) head();
    const bold = boldLast && i === rows.length - 1;
    cols.forEach((c, j) => {
      const v = c.max && r[j].length > c.max ? r[j].slice(0, c.max - 1) + '.' : r[j];
      if (c.right) doc.right(c.x, doc.y, v, 8.5, bold); else doc.text(c.x, doc.y, v, bold ? 'bold' : 'regular', 8.5);
    });
    doc.y += 14;
  });
  doc.y += 8;
}

function footnote(doc: PdfDoc, orgName: string) {
  doc.ensure(40);
  doc.y += 6;
  doc.color(110, 110, 110)
    .text(PAGE.margin, doc.y, `This statement was generated by QuickLoan for ${orgName} and reflects the records at the time of issue.`, 'regular', 8)
    .text(PAGE.margin, doc.y + 11, 'Amounts are in Kenya shillings (KES). If anything looks wrong, please contact your lender.', 'regular', 8)
    .color(0, 0, 0);
}

/** One loan: terms, summary, and every charge and payment. `memberId` scopes access for members. */
export function loanStatementPdf(loanId: string, scope: { memberId?: string; organizationId?: string }) {
  const loan = scope.memberId
    ? db.get('SELECT * FROM loans WHERE id = ? AND member_id = ?', loanId, scope.memberId)
    : db.get('SELECT * FROM loans WHERE id = ? AND organization_id = ?', loanId, scope.organizationId ?? '');
  if (!loan) throw notFound('Loan');
  const product = db.get('SELECT * FROM loan_products WHERE id = ?', loan.product_id)!;
  const w = who(loan.member_id);
  const doc = new PdfDoc();
  const R = PAGE.width - PAGE.margin;
  header(doc, 'Loan statement', w);

  sectionTitle(doc, 'Loan');
  pairs(doc, [
    ['Loan reference', loan.reference], ['Product', product.name],
    ['Disbursed', day(loan.disbursed_at)], ['Due date', day(loan.due_date)],
    ['Status', STATUS[loan.status] ?? loan.status], ['Loan period', `${loan.period_days} days`],
    ...(loan.rollover_count ? [['Rollovers', `${loan.rollover_count} (first due ${day(loan.original_due_date)})`] as [string, string]] : []),
    ...(loan.repaid_at ? [['Repaid on', day(loan.repaid_at)] as [string, string]] : []),
  ]);

  sectionTitle(doc, 'Summary');
  const bal = outstanding(loan);
  const sum: [string, number][] = [
    ['Loan amount', loan.principal], ['Interest', loan.interest_amount], ['Fees', loan.fee_amount],
    ...(loan.rollover_fees ? [['Rollover fees', loan.rollover_fees] as [string, number]] : []), ...(loan.late_fee_amount ? [['Late-payment fees', loan.late_fee_amount] as [string, number]] : []),
    ['Total to repay', loan.total_repayable], ['Amount paid', loan.amount_paid],
    ...(loan.rebate_amount ? [['Early repayment saving', loan.rebate_amount] as [string, number]] : []),
  ];
  for (const [k, v] of sum) { doc.text(PAGE.margin, doc.y, k, 'regular', 9.5).right(R, doc.y, `KES ${kes(v)}`, 9.5); doc.y += 15; }
  doc.line(PAGE.margin, doc.y - 4, R, doc.y - 4, 0.8, 0.4);
  doc.y += 6;
  doc.text(PAGE.margin, doc.y, 'Outstanding balance', 'bold', 11).right(R, doc.y, `KES ${kes(bal)}`, 11, true);
  doc.y += 24;

  sectionTitle(doc, 'Transactions');
  const ledger = loanLedger(loan);
  table(doc, [
    { title: 'Date', x: PAGE.margin }, { title: 'Description', x: PAGE.margin + 70, max: 46 },
    { title: 'Charge', x: 380, right: true }, { title: 'Payment', x: 455, right: true }, { title: 'Balance', x: R, right: true },
  ], ledger.map((l) => [day(l.at), l.description, l.charge ? kes(l.charge) : '', l.payment ? kes(l.payment) : '', kes(l.balance)]));

  const late = lateFeeText(product);
  if (bal > 0) {
    doc.ensure(30);
    doc.text(PAGE.margin, doc.y, `Amount due: KES ${kes(bal)} by ${day(loan.due_date)}.${late ? ` Late fee: ${late}.` : ''}`, 'regular', 9);
    doc.y += 16;
  }
  footnote(doc, w.orgName);
  return { pdf: doc.build(), fileName: `loan-statement-${loan.reference}.pdf` };
}

/** All of a member's loans and payments in one statement. */
export function memberStatementPdf(memberId: string) {
  const w = who(memberId);
  const loans = db.all('SELECT l.*, p.name AS product_name FROM loans l JOIN loan_products p ON p.id = l.product_id WHERE l.member_id = ? ORDER BY l.disbursed_at DESC', memberId);
  const doc = new PdfDoc();
  const R = PAGE.width - PAGE.margin;
  header(doc, 'Statement of loans', w);

  const open = loans.filter((l) => l.status !== 'REPAID');
  sectionTitle(doc, 'Summary');
  pairs(doc, [
    ['Loans taken', String(loans.length)], ['Loans repaid', String(loans.length - open.length)],
    ['Total borrowed', `KES ${kes(loans.reduce((s, l) => s + l.principal, 0))}`], ['Total paid', `KES ${kes(loans.reduce((s, l) => s + l.amount_paid, 0))}`],
    ['Open loans', String(open.length)], ['Outstanding now', `KES ${kes(open.reduce((s, l) => s + outstanding(l), 0))}`],
  ]);

  sectionTitle(doc, 'Loans');
  if (!loans.length) { doc.text(PAGE.margin, doc.y, 'No loans yet.', 'regular', 9.5); doc.y += 18; }
  else table(doc, [
    { title: 'Reference', x: PAGE.margin }, { title: 'Product', x: PAGE.margin + 78, max: 20 }, { title: 'Disbursed', x: PAGE.margin + 180 }, { title: 'Status', x: PAGE.margin + 245, max: 12 },
    { title: 'Amount', x: 390, right: true }, { title: 'Paid', x: 460, right: true }, { title: 'Outstanding', x: R, right: true },
  ], loans.map((l) => [l.reference, l.product_name, day(l.disbursed_at), STATUS[l.status] ?? l.status, kes(l.principal), kes(l.amount_paid), kes(outstanding(l))]));

  sectionTitle(doc, 'Payments');
  const pays = db.all('SELECT r.*, l.reference AS loan_ref FROM repayments r JOIN loans l ON l.id = r.loan_id WHERE r.member_id = ? ORDER BY r.paid_at DESC', memberId);
  if (!pays.length) { doc.text(PAGE.margin, doc.y, 'No payments yet.', 'regular', 9.5); doc.y += 18; }
  else table(doc, [
    { title: 'Date', x: PAGE.margin }, { title: 'Loan', x: PAGE.margin + 70 }, { title: 'Payment', x: PAGE.margin + 150, max: 34 },
    { title: 'Amount', x: 455, right: true }, { title: 'Balance after', x: R, right: true },
  ], pays.map((r) => [day(r.paid_at), r.loan_ref, `${PAY_TYPE[r.type] ?? 'Payment'} - ${CHANNEL[r.channel] ?? r.channel}`, kes(r.amount), kes(r.balance_after)]));

  footnote(doc, w.orgName);
  return { pdf: doc.build(), fileName: `loan-statement-${w.memberNumber}-${eatDate(clock.nowIso())}.pdf` };
}
