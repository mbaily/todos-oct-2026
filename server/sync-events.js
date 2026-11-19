import { WebSocket, WebSocketServer } from 'ws';

const HEARTBEAT_INTERVAL_MS = 4000;

export function requestOrigin(request) {
  const host = request.headers.host;
  if (!host || !/^(?:[\w.-]+|\[[\da-f:.]+\])(?::\d+)?$/i.test(host)) return null;
  const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';
  return URL.parse(`${secure ? 'https' : 'http'}://${host}`)?.origin ?? null;
}

export function createSyncEvents(server, { path = '/api/events', allowOtherUpgrades = false } = {}) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 });
  const awaitingPong = new WeakSet();

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== path) {
      if (!allowOtherUpgrades) socket.destroy();
      return;
    }
    const origin = requestOrigin(request);
    if (!origin || request.headers.origin !== origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, client => {
      client.on('error', () => client.terminate());
      client.on('pong', () => awaitingPong.delete(client));
      client.on('message', () => client.close(1008, 'Updates are sent by the server.'));
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of sockets.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (awaitingPong.has(client)) {
        client.terminate();
      } else {
        awaitingPong.add(client);
        client.ping();
        client.send('heartbeat');
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    notify(revision) {
      for (const client of sockets.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        // Older app builds still listen for the original unversioned notice.
        const message = client.protocol === 'todos-revisions' && revision !== undefined ? `changed:${revision}` : 'changed';
        client.send(message);
      }
    },
    close() {
      clearInterval(heartbeat);
      for (const client of sockets.clients) client.terminate();
      sockets.close();
    },
  };
}
