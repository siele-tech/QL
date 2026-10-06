/**
 * QuickLoan relational schema (SQLite dialect; portable to Postgres).
 * Monetary amounts are whole Kenyan shillings (INTEGER). SMS/CRB costs are cents.
 * Dates: *_at columns are ISO-8601 UTC instants; *_date columns are EAT business dates (YYYY-MM-DD).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('SACCO','MFI','CREDIT_GROUP','OTHER')),
  country TEXT NOT NULL DEFAULT 'KE',
  currency TEXT NOT NULL DEFAULT 'KES',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('MEMBER')),
  permissions TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 1
);

-- Simulates Wakandi's Member Registry (external source of identity). Only ID, name and ID number.
CREATE TABLE IF NOT EXISTS registry_members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  member_number TEXT NOT NULL,
  full_name TEXT NOT NULL,
  id_number TEXT NOT NULL,
  UNIQUE (organization_id, member_number)
);

-- QuickLoan lending profile, referencing (not duplicating) the registry identity.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  registry_member_id TEXT NOT NULL UNIQUE REFERENCES registry_members(id),
  phone TEXT NOT NULL,
  email TEXT,
  pin_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','INACTIVE')),
  membership_since TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  onboarded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);

CREATE TABLE IF NOT EXISTS member_profiles (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  disbursement_method TEXT NOT NULL DEFAULT 'MPESA',
  disbursement_phone TEXT,
  limit_override INTEGER,
  attributes TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_consents (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  type TEXT NOT NULL CHECK (type IN ('TERMS','DATA_PROCESSING','CRB_CHECK','LOAN_TERMS')),
  reference TEXT NOT NULL UNIQUE,
  context TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS loan_products (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  min_amount INTEGER NOT NULL,
  max_amount INTEGER NOT NULL,
  period_days INTEGER NOT NULL,
  fee_type TEXT NOT NULL CHECK (fee_type IN ('NONE','PERCENTAGE','FIXED')),
  fee_value REAL NOT NULL DEFAULT 0,
  interest_rate_monthly REAL NOT NULL DEFAULT 0,
  allow_partial INTEGER NOT NULL DEFAULT 1,
  early_repayment_enabled INTEGER NOT NULL DEFAULT 0,
  early_repayment_rebate_pct REAL NOT NULL DEFAULT 0,
  rollover_enabled INTEGER NOT NULL DEFAULT 0,
  rollover_fee_pct REAL NOT NULL DEFAULT 0,
  rollover_max INTEGER NOT NULL DEFAULT 0,
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('AUTO','MANUAL')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eligibility_rules (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES loan_products(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  operator TEXT NOT NULL,
  value TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crb_provider_configs (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  cost_per_check_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, provider)
);

-- CRB results are kept apart from the member record.
CREATE TABLE IF NOT EXISTS crb_checks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  member_id TEXT REFERENCES members(id),
  subject_id_number TEXT NOT NULL,
  subject_name TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  score INTEGER,
  grade TEXT,
  summary TEXT,
  report_reference TEXT,
  consent_reference TEXT NOT NULL,
  raw_response_ref TEXT,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  source TEXT NOT NULL DEFAULT 'QUICKLOAN',
  requested_by_type TEXT NOT NULL,
  requested_by_id TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crb_member ON crb_checks(member_id, checked_at);

CREATE TABLE IF NOT EXISTS crb_raw_responses (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES loan_products(id),
  channel TEXT NOT NULL DEFAULT 'SMS',
  message_template TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','SENDING','SENT')),
  recipients_count INTEGER NOT NULL DEFAULT 0,
  estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_offers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  campaign_id TEXT REFERENCES campaigns(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  product_id TEXT NOT NULL REFERENCES loan_products(id),
  amount INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('INVITED','OPENED','APPLIED','EXPIRED')),
  sms_message_id TEXT,
  opened_at TEXT,
  applied_at TEXT,
  application_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_member ON loan_offers(member_id, status);

CREATE TABLE IF NOT EXISTS loan_applications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  product_id TEXT NOT NULL REFERENCES loan_products(id),
  offer_id TEXT REFERENCES loan_offers(id),
  reference TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  period_days INTEGER NOT NULL,
  fee_amount INTEGER NOT NULL,
  interest_amount INTEGER NOT NULL,
  total_repayable INTEGER NOT NULL,
  status TEXT NOT NULL,
  consent_reference TEXT,
  eligibility_snapshot TEXT,
  crb_check_id TEXT,
  auto_decision INTEGER NOT NULL DEFAULT 0,
  decision_by TEXT,
  decision_by_name TEXT,
  decision_at TEXT,
  decision_reason TEXT,
  disbursement_error TEXT,
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps_org_status ON loan_applications(organization_id, status);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  product_id TEXT NOT NULL REFERENCES loan_products(id),
  application_id TEXT NOT NULL UNIQUE REFERENCES loan_applications(id),
  reference TEXT NOT NULL UNIQUE,
  principal INTEGER NOT NULL,
  fee_amount INTEGER NOT NULL,
  interest_amount INTEGER NOT NULL,
  rollover_fees INTEGER NOT NULL DEFAULT 0,
  total_repayable INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  principal_paid INTEGER NOT NULL DEFAULT 0,
  fee_paid INTEGER NOT NULL DEFAULT 0,
  interest_paid INTEGER NOT NULL DEFAULT 0,
  rebate_amount INTEGER NOT NULL DEFAULT 0,
  rollover_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  period_days INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  original_due_date TEXT NOT NULL,
  disbursed_at TEXT NOT NULL,
  disbursement_tx_id TEXT,
  approved_by_name TEXT,
  repaid_at TEXT,
  repayment_outcome TEXT CHECK (repayment_outcome IN ('EARLY','ON_TIME','LATE')),
  max_days_overdue INTEGER NOT NULL DEFAULT 0,
  defaulted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loans_org_status ON loans(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_loans_member ON loans(member_id);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  direction TEXT NOT NULL CHECK (direction IN ('DISBURSEMENT','COLLECTION')),
  purpose TEXT NOT NULL DEFAULT 'REPAYMENT' CHECK (purpose IN ('DISBURSEMENT','REPAYMENT','ROLLOVER')),
  provider TEXT NOT NULL,
  member_id TEXT NOT NULL,
  loan_id TEXT,
  application_id TEXT,
  phone TEXT,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SUCCESS','FAILED')),
  provider_reference TEXT,
  receipt_number TEXT,
  failure_reason TEXT,
  initiated_by_type TEXT NOT NULL,
  initiated_by_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS repayments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  loan_id TEXT NOT NULL REFERENCES loans(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL,
  principal_component INTEGER NOT NULL,
  fee_component INTEGER NOT NULL,
  interest_component INTEGER NOT NULL,
  rebate INTEGER NOT NULL DEFAULT 0,
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('FULL','PARTIAL','ROLLOVER_FEE')),
  channel TEXT NOT NULL,
  reference TEXT,
  payment_transaction_id TEXT,
  recorded_by_type TEXT NOT NULL,
  recorded_by_id TEXT,
  recorded_by_name TEXT,
  paid_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repayments_loan ON repayments(loan_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_repayments_org ON repayments(organization_id, paid_at);

CREATE TABLE IF NOT EXISTS status_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_entity ON status_history(entity_id, created_at);

CREATE TABLE IF NOT EXISTS behaviour_scores (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  organization_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  completed_loans INTEGER NOT NULL,
  on_time_payments INTEGER NOT NULL,
  early_payments INTEGER NOT NULL,
  late_payments INTEGER NOT NULL,
  overdue_loans INTEGER NOT NULL,
  defaulted_loans INTEGER NOT NULL,
  formula_version TEXT NOT NULL,
  last_updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS behaviour_history (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  member_id TEXT,
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  segments INTEGER NOT NULL,
  type TEXT NOT NULL,
  campaign_id TEXT,
  loan_id TEXT,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','SENT','DELIVERED','FAILED')),
  cost_cents INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sent_by_type TEXT NOT NULL,
  sent_by_id TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_campaign ON sms_messages(campaign_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  sms_message_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications(member_id, created_at);

CREATE TABLE IF NOT EXISTS reminder_log (
  loan_id TEXT NOT NULL,
  reminder_key TEXT NOT NULL,
  due_date TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (loan_id, reminder_key, due_date)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('MEMBER')),
  principal_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
-- Dynamic, reusable groups of members (rules are evaluated live).
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT 'teal',
  rules TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- An enabled loan: product × segment × terms × availability. SMS/push are channels of it.
CREATE TABLE IF NOT EXISTS loan_offerings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES loan_products(id),
  segment_id TEXT NOT NULL REFERENCES segments(id),
  availability TEXT NOT NULL CHECK (availability IN ('ONE_TIME','ONGOING')),
  amount_mode TEXT NOT NULL CHECK (amount_mode IN ('LIMIT','FIXED')),
  fixed_amount INTEGER,
  channels TEXT NOT NULL DEFAULT '["SMS","APP"]',
  message_template TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','ENDED')),
  expires_at TEXT,
  campaign_id TEXT,
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SENT','FAILED')),
  created_at TEXT NOT NULL
);

-- Outbox of events synchronised to the core banking system (COMS). Never shown to members.
CREATE TABLE IF NOT EXISTS core_sync_log (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  event TEXT NOT NULL,
  loan_id TEXT,
  payload TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SYNCED','FAILED','PENDING')),
  external_ref TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

-- Member onboarding: a personal, expiring, single-use invitation per SACCO member.
-- Only a hash of the link token is stored.
CREATE TABLE IF NOT EXISTS member_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  registry_member_id TEXT NOT NULL REFERENCES registry_members(id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVATED','REVOKED')),
  expires_at TEXT NOT NULL,
  id_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  identity_verified_at TEXT,
  opened_at TEXT,
  member_id TEXT,
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_registry ON member_invitations(registry_member_id);

-- One-time codes sent by SMS. A verified code proves access to the phone, nothing more.
CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('ACTIVATION','PIN_RESET')),
  subject_id TEXT NOT NULL,
  organization_id TEXT,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  send_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT NOT NULL,
  verified_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_subject ON otp_challenges(purpose, subject_id);

-- A member activated with a number other than the one on the SACCO record. The SACCO record is
-- left unchanged until the SACCO approves the update.
CREATE TABLE IF NOT EXISTS phone_change_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  registry_member_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  recorded_phone TEXT,
  new_phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED')),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** Columns added after the first release. Applied on startup when missing (SQLite has no IF NOT EXISTS for columns). */
export const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ['registry_members', 'phone', 'TEXT'],
  ['registry_members', 'date_of_birth', 'TEXT'],
  ['registry_members', 'gender', 'TEXT'],
  ['registry_members', 'source', "TEXT NOT NULL DEFAULT 'REGISTRY'"],
  ['registry_members', 'import_batch_id', 'TEXT'],
  ['registry_members', 'imported_at', 'TEXT'],
  ['registry_members', 'quality_status', "TEXT NOT NULL DEFAULT 'NOT_CHECKED'"],
  ['registry_members', 'quality_checked_at', 'TEXT'],
  ['loan_products', 'late_fee_type', "TEXT NOT NULL DEFAULT 'NONE'"],
  ['loan_products', 'late_fee_value', 'REAL NOT NULL DEFAULT 0'],
  ['loan_products', 'late_fee_grace_days', 'INTEGER NOT NULL DEFAULT 0'],
  ['loan_products', 'rollover_period_days', 'INTEGER'],
  ['loan_products', 'rollover_mode', "TEXT NOT NULL DEFAULT 'PAY_TO_EXTEND'"],
  ['loan_products', 'rollover_after_max', "TEXT NOT NULL DEFAULT 'COLLECTIONS'"],
  ['loans', 'late_fee_amount', 'INTEGER NOT NULL DEFAULT 0'],
  ['loans', 'late_fee_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['loans', 'last_late_fee_due_date', 'TEXT'],
  ['loan_offers', 'offering_id', 'TEXT'],
  ['loan_applications', 'offering_id', 'TEXT'],
  ['campaigns', 'offering_id', 'TEXT'],
  ['payment_transactions', 'reference_type', 'TEXT'],
  ['crb_checks', 'payment_transaction_id', 'TEXT'],
  ['crb_checks', 'member_fee', 'INTEGER NOT NULL DEFAULT 0'],
];
