import { createServer } from 'node:https';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  HEARTBEAT_INTERVAL_MS,
  PORTS,
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

/**
 * Relay server.
 *
 * It routes; it does not interpret (ARCHITECTURE.md P1). Sensor frames are
 * forwarded byte for byte without ever being decoded here.
 */

function main(): void {
  const lan = resolveLanIp();

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
      res.end(JSON.stringify({ ok: true, host: lan.host, rooms: registry.size }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('PhoneMote relay: WebSocket only\n');
  });

  const wss = new WebSocketServer({ server });

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
    socket.on('pong', () => alive.add(socket));
    const connection: Connection = {
      send: (data) => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(data);
      },
      close: () => socket.close(),
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
        room.toGame(toArrayBuffer(data as Buffer));
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
