# QuickLoan refinement — audit and journey map (member app)

Product principle: QuickLoan is a simple lending product on top of Wakandi infrastructure, not another CAMS.

## 1. Audit of the existing application

### Reused as is
| Area | What exists |
|---|---|
| Authentication | Member phone + PIN |
| Organization isolation | Every query scoped to the signed-in organization |
| Lending engine | Applications, automatic/manual approval, disbursement, repayments (fees → interest → principal), early-repayment saving, state machine, daily status processing |
| Behaviour score & milestones | Configurable formula, member milestones |
| CRB | Single embedded company CRB behind a provider interface, consent, encrypted raw responses |
| Payments | Provider interface with mock M-PESA and Daraja adapters, async confirmation, webhooks |
| SMS | Provider interface with mock Jami and Jami adapters, delivery reports, cost tracking |
| Notifications, reminders | In-app + SMS, five configurable reminder rules |
| Audit trail, collections processing | In place |
| UI kit | Card, Button, Badge, Tabs, Modal, Field, Toggle, KeyValue, Loadable, charts, Wakandi tokens |

### Missing (built in this refinement)
- Late-payment fee
- Rollover as a full product setting (period, how it happens, after the maximum)
- Loan availability: one-time offer vs ongoing loan, tied to a segment
- Push channel
- Core banking (COMS) and Wakandi Pay integration interfaces

### Reframed / simplified
- "Campaigns" → **Loan offers**: the lender enables a loan; SMS is one communication channel.
- Member-initiated "Extend due date" removed: rollover follows the product setting.

### Not available on this machine
- No COMS, Wakandi Pay or CAMS API documentation → mock implementations behind interfaces, no invented endpoints.

## 2. Journeys

**Member:** Receive offer → view loan details (cost, due date, late fee, rollover terms) → apply → confirm terms → confirmation → disbursed → active loan → reminders → pay → payment confirmation → loan completed.

**Overdue:** Due date → reminder → overdue → late fee → rollover if the product allows (automatic or pay-to-extend) → after the maximum rollovers: collections or default.

## 3. Concepts kept separate
- **Quality** = is this member's identity data accurate? (National ID, name, phone)
- **Eligibility** = should this member get a loan, and how much? (CRB, limit, age, gender, history)
