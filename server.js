import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createStore } from './server/store.js';
import { createApp } from './server/app.js';
import { createSyncEvents } from './server/sync-events.js';

const server = createHttpServer();
const dev = process.argv.includes('--dev');
const events = createSyncEvents(server, { allowOtherUpgrades: dev });
const filename = process.env.DB_PATH ?? path.resolve('data/todos.sqlite');
if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
const store = createStore(filename, { onChange: events.notify });
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
let vite;
if (dev) {
  const { createServer } = await import('vite');
  vite = await createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
}
server.on('request', createApp(store, { frontend: vite?.middlewares }));
server.listen(port, host, () => {
  console.log(`Todo app listening at http://${host}:${server.address().port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    events.close();
    await vite?.close();
    server.close(() => { store.close(); process.exit(0); });
  });
}
