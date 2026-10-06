import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config.ts';
import { db } from './db/db.ts';
import { attachActor, requireCsrfHeader } from './auth/middleware.ts';
import { errorHandler, h } from './lib/http.ts';
import { notFound } from './lib/errors.ts';
import { authRouter } from './routes/auth.ts';
import { memberRouter } from './routes/member.ts';
import { webhooksRouter } from './routes/webhooks.ts';
import { DEMO_ACCOUNTS } from './db/seed.ts';
import { SYSTEM_ACTOR } from './auth/middleware.ts';
import { invitationService } from './services/onboarding/invitations.ts';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    strictTransportSecurity: config.isProd,
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Provider webhooks: no session, no CSRF header.
  app.use('/api/webhooks', webhooksRouter);

  app.use('/api', attachActor, requireCsrfHeader);
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/public/organizations', h(async (_req, res) => {
    res.json(db.all(`SELECT id, name, type FROM organizations WHERE status = 'ACTIVE' ORDER BY name`));
  }));
  app.get('/api/public/demo', (_req, res) => res.json(config.demoMode ? { enabled: true, accounts: DEMO_ACCOUNTS } : { enabled: false }));

  // Demo only: stands in for the SMS a SACCO sends — a fresh personal invitation for someone on the
  // register who has not activated yet. Never available outside demo mode.
  app.post('/api/public/demo/invitation', h(async (_req, res) => {
    if (!config.demoMode) throw notFound('Endpoint');
    const p = db.get(`SELECT r.* FROM registry_members r JOIN organizations o ON o.id = r.organization_id
      WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.registry_member_id = r.id) AND r.phone IS NOT NULL AND length(trim(r.id_number)) >= 5
      ORDER BY (r.member_number = ?) DESC, r.member_number LIMIT 1`, DEMO_ACCOUNTS.onboarding.memberNumber);
    if (!p) throw notFound('Member to invite');
    const inv = invitationService.create({ ...SYSTEM_ACTOR(p.organization_id), name: 'Demo' }, p.id);
    res.json({ link: `/member/activate/${inv.token}`, name: p.full_name, idNumber: p.id_number });
  }));

  app.use('/api/auth', authRouter);
  app.use('/api/member', memberRouter);
  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));

  // Built frontend (npm start). In development Vite serves the UI and proxies /api here.
  const dist = path.resolve('dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
