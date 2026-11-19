import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const projectDir = fileURLToPath(new URL('../', import.meta.url));

function syncRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(`${url}/api/sync`, { method: 'POST', headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ cursor: 0, mutations: [] }));
  });
}

async function startServer(t, extraEnv = {}) {
  const { HOST, TLS_KEY_PATH, TLS_CERT_PATH, ...env } = process.env;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...env, PORT: '0', DB_PATH: ':memory:', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/Todo app listening at (http:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited with ${code}: ${stderr}`)));
  });
}

test('the server defaults to plain HTTP on IPv4 localhost', { timeout: 15000 }, async t => {
  const url = await startServer(t);
  assert.match(url, /^http:\/\/127\.0\.0\.1:/);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="app"/);
});

test('obsolete TLS variables cannot enable HTTPS or require certificate files', { timeout: 15000 }, async t => {
  const url = await startServer(t, {
    TLS_KEY_PATH: '/nonexistent/old-server.key',
    TLS_CERT_PATH: '/nonexistent/old-server.crt',
  });
  assert.equal((await fetch(url)).status, 200);
});

test('HTTP sync accepts the HTTPS host forwarded by Caddy and rejects another origin', { timeout: 15000 }, async t => {
  const url = await startServer(t);
  const headers = {
    'Content-Type': 'application/json', Host: 'example.test:9443',
    Origin: 'https://example.test:9443', 'X-Forwarded-Proto': 'https',
    'X-Forwarded-Prefix': '/todos_oct_2026', 'Sec-Fetch-Site': 'same-origin',
  };
  const response = await syncRequest(url, headers);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.changes, []);
  const refused = await syncRequest(url, { ...headers, Origin: 'https://other.example' });
  assert.equal(refused.status, 403);
});

test('the WebSocket behind Caddy accepts the same origin and notifies after a committed write', { timeout: 15000 }, async t => {
  const url = await startServer(t);
  const endpoint = url.replace(/^http/, 'ws') + '/api/events';
  const headers = { Host: 'example.test:9443', 'X-Forwarded-Proto': 'https' };
  const refused = new WebSocket(endpoint, { headers, origin: 'https://other.example' });
  await assert.rejects(once(refused, 'open'), /403/);

  const options = { headers, origin: 'https://example.test:9443' };
  const socket = new WebSocket(endpoint, 'todos-revisions', options);
  const legacy = new WebSocket(endpoint, options);
  t.after(() => { socket.terminate(); legacy.terminate(); });
  await Promise.all([once(socket, 'open'), once(legacy, 'open')]);
  const notice = once(socket, 'message');
  const legacyNotice = once(legacy, 'message');
  const id = randomUUID();
  const response = await fetch(url + '/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor: 0, mutations: [{
      action: 'create', id, opId: randomUUID(), timestamp: new Date().toISOString(),
      fields: { type: 'notebook', parentId: null, name: 'WebSocket test' },
    }] }),
  });
  assert.equal(response.status, 200);
  const pull = await syncRequest(url, { 'Content-Type': 'application/json' });
  assert.equal(pull.data.changes[0].entity.id, id);
  assert.equal((await notice)[0].toString(), `changed:${pull.data.cursor}`);
  assert.equal((await legacyNotice)[0].toString(), 'changed');
  const [heartbeat] = await once(socket, 'message', { signal: AbortSignal.timeout(8000) });
  assert.equal(heartbeat.toString(), 'heartbeat');
});
