import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Minimal .env loader (no dependency). Real environment variables win over the file. */
function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = (k: string, d = '') => process.env[k] || d;
const isProd = env('NODE_ENV') === 'production';

let sessionSecret = env('SESSION_SECRET');
if (!sessionSecret || sessionSecret === 'change-me-to-a-long-random-string') {
  if (isProd) throw new Error('SESSION_SECRET must be set to a strong random value in production');
  sessionSecret = 'dev-only-' + crypto.createHash('sha256').update(process.cwd()).digest('hex');
}

export const config = {
  isProd,
  port: Number(env('PORT', '4000')),
  appUrl: env('APP_URL', 'http://localhost:5173'),
  databasePath: env('DATABASE_PATH', './data/quickloan.db'),
  sessionSecret,
  sessionTtlHours: Number(env('SESSION_TTL_HOURS', '12')),
  demoMode: env('DEMO_MODE', 'true') === 'true' && !isProd,
  maxLoanPeriodDays: Number(env('MAX_LOAN_PERIOD_DAYS', '30')),
  // The company's embedded CRB. Blank URL/key => simulated responses in demo mode.
  crb: { name: env('CRB_NAME', 'Wakandi CRB'), baseUrl: env('CRB_API_URL'), apiKey: env('CRB_API_KEY') },
  mpesa: {
    env: env('MPESA_ENV', 'sandbox'), consumerKey: env('MPESA_CONSUMER_KEY'), consumerSecret: env('MPESA_CONSUMER_SECRET'),
    shortcode: env('MPESA_SHORTCODE'), passkey: env('MPESA_PASSKEY'), b2cInitiator: env('MPESA_B2C_INITIATOR'),
    b2cSecurityCredential: env('MPESA_B2C_SECURITY_CREDENTIAL'), callbackBaseUrl: env('MPESA_CALLBACK_BASE_URL'),
  },
  jami: {
    apiUrl: env('JAMI_API_URL'), apiKey: env('JAMI_API_KEY'), senderId: env('JAMI_SENDER_ID', 'QUICKLOAN'),
    costPerSegmentCents: Number(env('SMS_COST_PER_SEGMENT_CENTS', '80')),
  },
  // Wakandi message service (SSO client_credentials + send-external-message), as used by Wakandi Jamii.
  messageService: {
    url: env('MESSAGE_SERVICE_URL'), ssoUrl: env('MESSAGE_SERVICE_SSO_URL'), clientId: env('MESSAGE_SERVICE_CLIENT_ID'),
    clientSecret: env('MESSAGE_SERVICE_CLIENT_SECRET'), appName: env('MESSAGE_SERVICE_APP_NAME', 'quickloan'),
  },
  // Integrations awaiting API documentation. Blank => mock implementations (demo) / not configured.
  identity: { apiUrl: env('IDENTITY_API_URL'), apiKey: env('IDENTITY_API_KEY') },
  coms: { apiUrl: env('COMS_API_URL'), apiKey: env('COMS_API_KEY') },
  wakandiPay: { apiUrl: env('WAKANDI_PAY_API_URL'), apiKey: env('WAKANDI_PAY_API_KEY') },
  push: { apiUrl: env('PUSH_API_URL'), apiKey: env('PUSH_API_KEY') },
  /** mock | mpesa | wakandipay. Blank => mpesa when its credentials are set, otherwise mock. */
  paymentProvider: env('PAYMENT_PROVIDER'),
};
