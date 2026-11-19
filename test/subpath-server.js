// Exercise the same prefix stripping as Caddy with an isolated in-memory store.
import { createServer } from 'node:http';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createSyncEvents } from '../server/sync-events.js';

const prefix = process.env.TEST_BASE_PATH;
if (!prefix?.startsWith('/') || !prefix.endsWith('/')) throw new Error('TEST_BASE_PATH needs leading and trailing slashes.');
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === prefix.slice(0, -1)) {
    res.writeHead(308, { Location: prefix + url.search }).end();
    return;
  }
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404).end('Other app');
    return;
  }
  req.url = req.url.slice(prefix.length - 1);
  app(req, res);
});
const events = createSyncEvents(server, { path: prefix + 'api/events' });
const store = createStore(':memory:', { onChange: events.notify });
const app = createApp(store);
server.listen(Number(process.env.PORT), '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    events.close();
    server.close(() => { store.close(); process.exit(0); });
  });
}
