import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authRouter, meRouter, requireAuth, HttpError } from './routes/auth.js';
import { workflowsRouter } from './routes/workflows.js';
import { catalogRouter, credentialsRouter, executionsRouter, toolsRouter, stripeWebhookRouter } from './routes/resources.js';
import { webhookRouter } from './routes/webhooks.js';
import './jobs.js'; // registers the job handler with the queue
import { queueMode } from './queue.js';
import { dialect } from './db.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors());
  app.use((req, res, next) => {
    res.set({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      // The editor is a same-origin SPA; inline styles are needed by the canvas library, inline scripts are not allowed.
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    if (req.secure || req.get('x-forwarded-proto') === 'https') res.set('strict-transport-security', 'max-age=15552000; includeSubDomains');
    next();
  });

  // Stripe needs the raw body for signature verification, so it is mounted before the JSON parser.
  app.use('/api/billing/webhook', stripeWebhookRouter);

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.text({ type: ['text/*'], limit: '1mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, db: dialect, queue: queueMode }));
  app.use('/webhook', webhookRouter);

  app.use('/api/auth', authRouter);
  app.use('/api', meRouter);
  app.use('/api/workflows', requireAuth, workflowsRouter);
  app.use('/api/credentials', requireAuth, credentialsRouter);
  app.use('/api/executions', requireAuth, executionsRouter);
  app.use('/api', requireAuth, catalogRouter);
  app.use('/api', requireAuth, toolsRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built editor (npm run build) from the same origin.
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(dist)) {
    // Vite fingerprints everything under /assets, so browsers can keep it forever instead of re-downloading.
    app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(dist, { maxAge: 0 }));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    const status = err instanceof HttpError || err.status ? err.status : 500;
    if (status >= 500) console.error('[error]', err);
    return res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}
