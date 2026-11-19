import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestOrigin } from './sync-events.js';

const publicPath = fileURLToPath(new URL('../dist/', import.meta.url));

export function createApp(store, { frontend } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const websocketOrigin = requestOrigin(req)?.replace(/^http/, 'ws');
    const websocketPolicy = frontend ? ' ws: wss:' : websocketOrigin ? ` ${websocketOrigin}` : '';
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'${websocketPolicy}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Browser mutations must originate from this single-user app.
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request refused.' });
    if (req.get('origin')) {
      try {
        if (new URL(req.get('origin')).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request refused.' });
      } catch {
        return res.status(403).json({ error: 'Invalid origin.' });
      }
    }
    next();
  });
  app.use(express.json({ limit: '12mb' }));
  app.post('/api/sync', (req, res, next) => {
    try {
      const { cursor, checkpoint, mutations, awaiting, operationThrough, trashThrough } = req.body ?? {};
      res.json(store.sync({ cursor, checkpoint, mutations, awaiting, operationThrough, trashThrough }));
    } catch (error) {
      if (!error.code) error.status ??= 400;
      next(error);
    }
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));
  app.use(frontend ?? express.static(path.resolve(publicPath), { etag: true }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status ?? 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'Server error. Retry shortly.' : error.message });
  });
  return app;
}
