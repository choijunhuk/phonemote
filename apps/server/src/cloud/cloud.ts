import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { RelayHub, SignalHub, type Peer } from './hub.js';

/**
 * The PhoneMote server (ARCHITECTURE.md D63): the web build's files, signaling
 * at /signal and the relay at /relay, behind a reverse proxy that terminates
 * TLS and strips its public prefix (coms.kw.ac.kr/phonemote/ → here).
 *
 * Plain HTTP on the loopback interface only. It never decodes a sensor frame:
 * it routes, as the LAN relay does (ARCHITECTURE.md P1).
 */

const HOST = process.env['PHONEMOTE_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['PORT'] ?? 4190);
const WEB_DIR = resolve(process.env['PHONEMOTE_WEB_DIR'] ?? 'web');
/** Signaling messages are an SDP at most; sensor frames are 68 bytes. */
const MAX_PAYLOAD = 64 * 1024;
const MAX_SOCKETS = 2000;
const HEARTBEAT_MS = 25_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pmtrace': 'text/plain; charset=utf-8',
};

function serveFile(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sockets: sockets.size }));
    return;
  }
  // Resolved inside WEB_DIR or not at all: no "../" out of it.
  let path = normalize(join(WEB_DIR, decodeURIComponent(url.pathname)));
  if (path !== WEB_DIR && !path.startsWith(WEB_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(path).isDirectory()) path = join(path, 'index.html');
    statSync(path);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    // Vite fingerprints everything under assets/; the pages must stay fresh.
    'cache-control': path.includes(`${sep}assets${sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  createReadStream(path).pipe(res);
}

const signals = new SignalHub();
const relay = new RelayHub(signals);
const sockets = new Set<WebSocket>();
const alive = new WeakSet<WebSocket>();

function peerFor(socket: WebSocket): Peer {
  return {
    sendText: (text) => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    },
    sendBinary: (data) => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
    close: (code, reason) => socket.close(code, reason),
  };
}

function bytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
  sockets.add(socket);
  alive.add(socket);
  socket.on('pong', () => alive.add(socket));
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => socket.terminate());

  const url = new URL(req.url ?? '/', 'http://local');
  const peer = peerFor(socket);
  const params = url.searchParams;

  if (url.pathname === '/signal') {
    if (!signals.register(peer, params.get('id'), params.get('token'))) {
      peer.sendText(JSON.stringify({ type: 'taken' }));
      socket.close(4001, 'address taken');
      return;
    }
    peer.sendText(JSON.stringify({ type: 'open' }));
    socket.on('message', (data: RawData, binary: boolean) => {
      alive.add(socket);
      if (!binary) signals.receive(peer, Buffer.from(bytes(data)).toString());
    });
    socket.on('close', () => signals.unregister(peer));
    return;
  }

  // /relay
  const role = params.get('role');
  const attached =
    role === 'host'
      ? relay.attachHost(peer, params.get('id'), params.get('token'))
      : relay.attachPhone(peer, params.get('id'));
  if (!attached) {
    peer.sendText(
      JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'No room is relaying at that code.' }),
    );
    socket.close(4004, 'no such room');
    return;
  }
  socket.on('message', (data: RawData, binary: boolean) => {
    alive.add(socket);
    if (binary) relay.receiveBinary(peer, bytes(data));
    else relay.receiveText(peer, Buffer.from(bytes(data)).toString());
  });
  socket.on('close', () => relay.detach(peer));
});

const server = createServer(serveFile);
server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://local').pathname;
  if ((path !== '/signal' && path !== '/relay') || sockets.size >= MAX_SOCKETS) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// A phone that walks out of Wi-Fi leaves a socket that looks open from here.
setInterval(() => {
  for (const socket of sockets) {
    if (!alive.has(socket)) {
      socket.terminate();
      continue;
    }
    alive.delete(socket);
    socket.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, HOST, () => {
  console.log(`[phonemote] http://${HOST}:${PORT}  web: ${WEB_DIR}`);
});
