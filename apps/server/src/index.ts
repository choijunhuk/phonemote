import { createServer } from 'node:https';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  HEARTBEAT_INTERVAL_MS,
  PORTS,
  SENSOR_FRAME_BYTES,
  isClientHello,
  isFeedback,
  isPing,
  isPong,
  parseMessage,
  toArrayBuffer,
  type ErrorCode,
  type ServerMsg,
} from '@phonemote/protocol';
import { loadTlsMaterial, MissingCertificateError } from './https.js';
import { resolveLanIp } from './lanIp.js';
import { RoomRegistry, type Connection } from './room.js';
import { TraceRecorder, listTraces, readTrace } from './recorder.js';
import { MAX_LOG_BYTES, appendLog, listLogs } from './logs.js';

/**
 * Relay server.
 *
 * It routes; it does not interpret (ARCHITECTURE.md P1). Sensor frames are
 * forwarded byte for byte without ever being decoded here.
 */

function main(): void {
  const lan = resolveLanIp();

  // Recording is opt-in: it writes every frame of every player to disk.
  const recordFlag = process.argv.indexOf('--record');
  const recorder =
    recordFlag === -1
      ? null
      : new TraceRecorder(process.argv[recordFlag + 1] ?? 'unlabelled session');
  if (recorder) console.log('[relay] recording traces to traces/');

  if (lan.candidates.length > 1 && lan.source === 'auto') {
    console.warn('[relay] several LAN IP candidates found:');
    for (const candidate of lan.candidates) {
      const mark = candidate.address === lan.host ? '*' : ' ';
      console.warn(`  ${mark} ${candidate.address}  (${candidate.name})`);
    }
    console.warn(`[relay] using ${lan.host}. Pin it with PHONEMOTE_HOST=<ip> if that is wrong.`);
  }

  const tls = loadTlsMaterial();
  const registry = new RoomRegistry();

  const server = createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          host: lan.host,
          rooms: registry.size,
          recording: recorder?.stats ?? null,
        }),
      );
      return;
    }

    // The game writes its measurements here so they can be read afterwards by
    // someone who was not in the room.
    if (req.url === '/log' && req.method === 'POST') {
      let body = '';
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (body.length > MAX_LOG_BYTES) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        const result = tooBig ? { ok: false as const, why: 'too large' } : appendLog(body);
        res.writeHead(result.ok ? 200 : 400, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        });
        res.end(JSON.stringify(result));
        if (result.ok) console.log(`[log] wrote ${result.bytes} bytes`);
      });
      return;
    }
    if (req.url === '/log' && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }
    if (req.url === '/logs') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(listLogs()));
      return;
    }

    // The game runs in a browser and cannot read the traces directory itself.
    if (req.url === '/traces') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(listTraces()));
      return;
    }
    if (req.url?.startsWith('/traces/')) {
      const trace = readTrace(decodeURIComponent(req.url.slice('/traces/'.length)));
      if (trace === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such trace');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/plain',
        'access-control-allow-origin': '*',
      });
      res.end(trace);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('PhoneMote relay: WebSocket only\n');
  });

  const wss = new WebSocketServer({ server, perMessageDeflate: false });

  /**
   * A phone that loses Wi-Fi leaves a socket that looks open from here and
   * never closes. Without this the room fills with players who left.
   */
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (socket: WebSocket) => {
    alive.add(socket);
    // Small frames at 60 Hz are exactly the traffic Nagle punishes, and
    // compressing 68 bytes is pure latency for no gain. The underlying socket
    // is not part of the ws type surface, hence the narrow cast.
    const raw = (socket as unknown as { _socket?: { setNoDelay(on: boolean): void } })._socket;
    raw?.setNoDelay(true);
    socket.on('pong', () => alive.add(socket));
    const connection: Connection = {
      send: (data) => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(data);
      },
      close: () => socket.close(),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
    };

    const fail = (code: ErrorCode, message: string): void => {
      connection.send(JSON.stringify({ type: 'error', code, message } satisfies ServerMsg));
      socket.close();
    };

    socket.on('message', (data: RawData, isBinary: boolean) => {
      // Any traffic counts as proof of life, not just a protocol pong.
      alive.add(socket);

      if (isBinary) {
        // A sensor frame. Hand it to the game socket unread.
        const room = registry.findByController(connection);
        if (!room) return;
        const frame = toArrayBuffer(data as Buffer);
        // Written down before forwarding, and still never interpreted here.
        const player = room.findPlayerByConnection(connection);
        if (recorder && player) recorder.record(room.code, player.id, frame);
        room.toGameLossy(frame, SENSOR_FRAME_BYTES * 3);
        return;
      }

      const message = parseMessage(data.toString());
      if (!message) {
        fail('BAD_MESSAGE', 'Expected JSON with a "type" field.');
        return;
      }

      if (isClientHello(message)) {
        if (message.role === 'game') {
          const room = registry.create(connection);
          connection.send(
            JSON.stringify({
              type: 'room',
              roomCode: room.code,
              wsUrl: `wss://${lan.host}:${PORTS.relay}`,
              controllerUrl: `https://${lan.host}:${PORTS.controller}/?room=${room.code}`,
            } satisfies ServerMsg),
          );
          console.log(`[relay] room ${room.code} opened`);
          return;
        }

        const room = registry.get(message.roomCode);
        if (!room) {
          fail('ROOM_NOT_FOUND', `No room with code ${message.roomCode}.`);
          return;
        }
        const joined = room.addController(connection, message.name, message.clientId);
        if (!joined.ok) {
          fail(joined.code, 'That room already has four controllers.');
          return;
        }
        console.log(`[relay] room ${room.code}: player ${joined.player.id} joined`);
        return;
      }

      if (isPing(message) || isFeedback(message)) {
        // Both travel game -> controller.
        const room = registry.findByGame(connection);
        room?.toPlayer(message.playerId, JSON.stringify(message));
        return;
      }

      if (isPong(message)) {
        const room = registry.findByController(connection);
        room?.toGame(JSON.stringify(message));
        return;
      }
    });

    socket.on('close', () => {
      const gameRoom = registry.findByGame(connection);
      if (gameRoom) {
        gameRoom.closeWithGameGone();
        registry.remove(gameRoom.code);
        console.log(`[relay] room ${gameRoom.code} closed (game left)`);
        return;
      }
      const controllerRoom = registry.findByController(connection);
      const player = controllerRoom?.removeController(connection);
      if (controllerRoom && player) {
        console.log(`[relay] room ${controllerRoom.code}: player ${player.id} left`);
      }
    });

    socket.on('error', (error: Error) => {
      console.warn(`[relay] socket error: ${error.message}`);
    });
  });

  server.listen(PORTS.relay, '0.0.0.0', () => {
    console.log(`[relay]      wss://${lan.host}:${PORTS.relay}  (host source: ${lan.source})`);
    console.log(`[game]      https://${lan.host}:${PORTS.game}`);
    console.log(`[controller] https://${lan.host}:${PORTS.controller}`);
  });
}

try {
  main();
} catch (error) {
  if (error instanceof MissingCertificateError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
