/**
 * Transports: one HTTP server for the protocol (REST + the `/v1` WebSocket
 * upgrade) and one for `/__mock/*`. `node:http` and `ws`, nothing else.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { serveControl } from './control';
import type { Conn, MockGateway } from './gateway';
import { serveRest } from './rest';
import { openSession } from './session';
import { onFrame } from './wire';

export interface Listening {
  url: string;
  httpUrl: string;
  controlUrl: string;
  close(): Promise<void>;
}

function attach(gw: MockGateway, ws: WebSocket): void {
  const conn: Conn = {
    closed: false,
    send: (text) => ws.send(text),
    close: (code, reason) => {
      conn.closed = true;
      ws.close(code, reason);
    },
  };
  gw.conns.add(conn);
  ws.on('message', (data: Buffer) => onFrame(gw, conn, data.toString('utf8')));
  ws.on('close', () => {
    conn.closed = true;
    gw.conns.delete(conn);
    if (conn.fillerId && gw.live.get(conn.fillerId) === conn) gw.live.delete(conn.fillerId);
  });
  openSession(gw, conn);
}

const listen = (server: Server, port: number, host: string) =>
  new Promise<number>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok((server.address() as AddressInfo).port));
  });

const shut = (server: Server) => new Promise<void>((ok) => server.close(() => ok()));

export async function serve(gw: MockGateway, opts: { host: string; port: number; controlPort: number }): Promise<Listening> {
  const wss = new WebSocketServer({ noServer: true });
  const api = createServer((req, res) => void serveRest(gw, req, res));
  api.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://mock').pathname !== '/v1') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(gw, ws));
  });
  const control = createServer((req, res) => void serveControl(gw, req, res));
  const port = await listen(api, opts.port, opts.host);
  const controlPort = await listen(control, opts.controlPort, opts.host);
  // A wildcard bind is reached on loopback; print an address a client can dial.
  const host = opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;
  return {
    url: `ws://${host}:${port}/v1`,
    httpUrl: `http://${host}:${port}`,
    controlUrl: `http://${host}:${controlPort}`,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      api.closeAllConnections();
      control.closeAllConnections();
      await Promise.all([shut(api), shut(control)]);
    },
  };
}
