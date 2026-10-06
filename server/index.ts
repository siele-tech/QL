import { config } from './config.ts';
import { db } from './db/db.ts';
import { clock } from './lib/clock.ts';
import { seedRoles } from './auth/rbac.ts';
import { purgeExpiredSessions } from './auth/session.ts';
import { runDailyProcessing } from './lending/collections.ts';
import { createApp } from './app.ts';
import { seedIfEmpty } from './db/seed.ts';
import { ensureEmbeddedCrb } from './services/crb/crbService.ts';
import { ensureLendingDefaults } from './lending/offerings.ts';

db.open();
seedRoles();
await seedIfEmpty();
ensureEmbeddedCrb();
ensureLendingDefaults();

const offset = db.get(`SELECT value FROM system_settings WHERE key = 'clock_offset_days'`);
if (offset && config.demoMode) clock.setOffsetDays(Number(offset.value));

const app = createApp();
app.listen(config.port, () => {
  console.log(`\n  QuickLoan API listening on http://localhost:${config.port}`);
  if (config.demoMode) console.log('  Demo mode ON — demo accounts are listed on the entry screen.\n');
});

// Scheduled processing: status transitions (DUE/OVERDUE/DEFAULTED), offer expiry, reminders.
const tick = () => runDailyProcessing().catch((e) => console.error('[daily]', e?.message));
tick();
setInterval(tick, 10 * 60_000).unref();
setInterval(purgeExpiredSessions, 60 * 60_000).unref();
