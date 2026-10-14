// Empfänger für die GX Tube Android-App: WebSocket für die Steuerung,
// UDP für "Welche PCs gibt es im WLAN?". Keine Electron-Abhängigkeit (testbar mit Node).

import { EventEmitter } from 'node:events';
import http from 'node:http';
import dgram from 'node:dgram';
import { WebSocketServer } from 'ws';
import {
  DEFAULT_PORT,
  DISCOVERY_PORT,
  PROTOCOL_VERSION,
  WS_PATH,
  ProtocolError,
  discoveryReply,
  isDiscoveryRequest,
  isLocalAddress,
  parseCommand,
} from './protocol.js';

const HEARTBEAT_MS = 15000;

/**
 * Ereignisse:
 *  - 'command' (cmd, client)  → geprüfter Befehl vom Handy
 *  - 'clients' (list)          → verbundene Handys haben sich geändert
 *  - 'connected' (client) / 'disconnected' (client)
 *  - 'error' (err)             → z. B. Port belegt (nur zur Info)
 */
export class CastServer extends EventEmitter {
  constructor({
    id,
    name,
    version = '0.0.0',
    port = DEFAULT_PORT,
    discoveryPort = DISCOVERY_PORT,
    host = '0.0.0.0',
    allowAddress = isLocalAddress,
    portAttempts = 10,
  }) {
    super();
    this.id = id;
    this.name = name;
    this.version = version;
    this.preferredPort = port;
    this.discoveryPort = discoveryPort;
    this.host = host;
    this.allowAddress = allowAddress;
    this.portAttempts = portAttempts;
    this.port = null;
    this.http = null;
    this.wss = null;
    this.udp = null;
    this.heartbeat = null;
    this.peers = new Map(); // ws → { id, name, deviceId, address, connectedAt, alive }
    this.nextPeerId = 1;
  }

  info() {
    return { type: 'welcome', protocol: PROTOCOL_VERSION, id: this.id, name: this.name, version: this.version, app: 'GX Tube Desktop' };
  }

  clients() {
    return [...this.peers.values()].filter((p) => p.hello).map(({ id, name, deviceId, address, connectedAt }) => ({ id, name, deviceId, address, connectedAt }));
  }

  async start() {
    await this.#startHttp();
    await this.#startDiscovery().catch((err) => {
      // Ohne UDP geht die automatische Suche nicht, Verbinden per Adresse aber schon
      this.emit('error', err);
    });
    this.heartbeat = setInterval(() => {
      for (const [ws, peer] of this.peers) {
        if (!peer.alive) {
          ws.terminate();
          continue;
        }
        peer.alive = false;
        try {
          ws.ping();
        } catch {
          // Verbindung schon weg
        }
      }
    }, HEARTBEAT_MS);
    return this.port;
  }

  async stop() {
    clearInterval(this.heartbeat);
    for (const ws of this.peers.keys()) ws.terminate();
    this.peers.clear();
    await new Promise((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    await new Promise((resolve) => {
      if (!this.udp) return resolve();
      try {
        this.udp.close(() => resolve());
      } catch {
        resolve();
      }
    });
    this.http = this.wss = this.udp = null;
  }

  setName(name) {
    this.name = name;
    this.broadcast(this.info());
  }

  send(ws, message) {
    if (ws.readyState !== 1) return;
    ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const [ws, peer] of this.peers) if (peer.hello) this.send(ws, data);
  }

  /** Einen Client trennen (z. B. "Gerät trennen" in den Einstellungen). */
  kick(peerId) {
    for (const [ws, peer] of this.peers) if (peer.id === peerId) ws.close(4001, 'Vom PC getrennt');
  }

  // ---------------------------------------------------------------- HTTP + WebSocket

  async #startHttp() {
    let lastErr;
    for (let i = 0; i < this.portAttempts; i++) {
      const port = this.preferredPort === 0 ? 0 : this.preferredPort + i;
      try {
        await this.#listen(port);
        return;
      } catch (err) {
        lastErr = err;
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') break;
      }
    }
    throw lastErr;
  }

  #listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.#onHttp(req, res));
      const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
      server.on('upgrade', (req, socket, head) => {
        const address = req.socket.remoteAddress;
        const path = (req.url || '').split('?')[0];
        // Webseiten im Browser dürfen den Player nicht fernsteuern: die schicken immer einen Origin mit.
        if (path !== WS_PATH || req.headers.origin || !this.allowAddress(address)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, address));
      });
      const onError = (err) => {
        server.close();
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, this.host, () => {
        server.off('error', onError);
        server.on('error', (err) => this.emit('error', err));
        this.http = server;
        this.wss = wss;
        this.port = server.address().port;
        resolve();
      });
    });
  }

  #onHttp(req, res) {
    if (!this.allowAddress(req.socket.remoteAddress)) {
      res.writeHead(403).end();
      return;
    }
    // Kleine Info-Seite – praktisch zum Prüfen im Browser des Handys (http://<PC>:8765/)
    const body = JSON.stringify({ ...this.info(), type: 'device', port: this.port });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  #onConnection(ws, address) {
    const peer = {
      id: this.nextPeerId++,
      name: 'Handy',
      deviceId: '',
      address: address?.replace(/^::ffff:/, ''),
      connectedAt: Date.now(),
      alive: true,
      hello: false,
    };
    this.peers.set(ws, peer);
    ws.on('pong', () => (peer.alive = true));
    ws.on('message', (data, isBinary) => {
      peer.alive = true;
      if (isBinary) return;
      let cmd;
      try {
        cmd = parseCommand(data.toString('utf8'));
      } catch (err) {
        this.send(ws, { type: 'error', message: err instanceof ProtocolError ? err.message : 'Fehler' });
        return;
      }
      if (cmd.type === 'ping') {
        this.send(ws, { type: 'pong' });
        return;
      }
      if (cmd.type === 'hello') {
        const first = !peer.hello;
        peer.hello = true;
        peer.name = cmd.name;
        peer.deviceId = cmd.deviceId;
        this.send(ws, this.info());
        if (first) this.emit('connected', { ...peer });
        this.emit('clients', this.clients());
        this.emit('hello', ws, { ...peer });
        return;
      }
      if (!peer.hello) {
        this.send(ws, { type: 'error', message: 'Zuerst "hello" senden' });
        return;
      }
      this.emit('command', cmd, { ...peer });
    });
    ws.on('close', () => {
      const had = this.peers.get(ws);
      this.peers.delete(ws);
      if (had?.hello) {
        this.emit('disconnected', { ...had });
        this.emit('clients', this.clients());
      }
    });
    ws.on('error', () => ws.terminate());
  }

  // ---------------------------------------------------------------- UDP-Suche

  #startDiscovery() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.once('error', reject);
      sock.on('message', (buf, rinfo) => {
        if (!this.allowAddress(rinfo.address) || !isDiscoveryRequest(buf) || !this.port) return;
        const reply = Buffer.from(discoveryReply({ id: this.id, name: this.name, port: this.port, version: this.version }));
        sock.send(reply, rinfo.port, rinfo.address, () => {});
      });
      sock.bind(this.discoveryPort, () => {
        sock.off('error', reject);
        sock.on('error', (err) => this.emit('error', err));
        try {
          sock.setBroadcast(true);
        } catch {
          // nicht schlimm
        }
        this.udp = sock;
        resolve();
      });
    });
  }
}
