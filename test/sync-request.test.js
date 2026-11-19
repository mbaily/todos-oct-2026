import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSyncPage } from '../src/lib/sync-request.js';

class TestRequest extends EventTarget {
  static HEADERS_RECEIVED = 2;
  upload = new EventTarget();
  aborted = false;

  open() {}
  setRequestHeader() {}
  send() {}

  abort() {
    this.aborted = true;
    this.dispatchEvent(new Event('abort'));
    this.dispatchEvent(new Event('loadend'));
  }

  complete(status, response) {
    this.status = status;
    this.response = response;
    this.dispatchEvent(new Event('load'));
    this.dispatchEvent(new Event('loadend'));
  }
}

function start(t, signal, reportReachability) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const xhr = new TestRequest();
  t.mock.method(globalThis, 'XMLHttpRequest', class { constructor() { return xhr; } });
  const result = requestSyncPage('/api/sync', { cursor: 0, checkpoint: null, mutations: [] }, signal, reportReachability);
  return { xhr, result };
}

// This browser API is absent in Node. Each test replaces the placeholder.
globalThis.XMLHttpRequest = TestRequest;

test('upload and download progress extend the sync deadline', async t => {
  const connection = new AbortController();
  const { xhr, result } = start(t, connection.signal);
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(10000);
    xhr.upload.dispatchEvent(new Event('progress'));
  }
  t.mock.timers.tick(10000);
  xhr.readyState = TestRequest.HEADERS_RECEIVED;
  xhr.dispatchEvent(new Event('readystatechange'));
  t.mock.timers.tick(10000);
  xhr.dispatchEvent(new Event('progress'));
  t.mock.timers.tick(10000);
  const response = { cursor: 1 };
  xhr.complete(200, response);
  assert.deepEqual(await result, response);
  connection.abort();
  t.mock.timers.tick(15000);
  assert.equal(xhr.aborted, false);
});

test('a connection change aborts an outstanding request immediately', async t => {
  const connection = new AbortController();
  const reachability = [];
  const { xhr, result } = start(t, connection.signal, value => reachability.push(value));
  const canceled = assert.rejects(result, { name: 'AbortError' });
  connection.abort();
  assert.equal(xhr.aborted, true);
  await canceled;
  assert.deepEqual(reachability, []);
});

test('a stalled sync request aborts fifteen seconds after the last progress event', async t => {
  const reachability = [];
  const { xhr, result } = start(t, undefined, value => reachability.push(value));
  const failed = assert.rejects(result, /Sync request timed out/);
  t.mock.timers.tick(12000);
  xhr.upload.dispatchEvent(new Event('progress'));
  t.mock.timers.tick(14999);
  assert.equal(xhr.aborted, false);
  t.mock.timers.tick(1);
  await failed;
  assert.equal(xhr.aborted, true);
  assert.deepEqual(reachability, [false]);
});

test('an HTTP error still reports that the server was reached', async t => {
  const reachability = [];
  const { xhr, result } = start(t, undefined, value => reachability.push(value));
  const failed = assert.rejects(result, /Sync failed \(503\)/);
  xhr.complete(503, null);
  await failed;
  assert.deepEqual(reachability, [true]);
});
