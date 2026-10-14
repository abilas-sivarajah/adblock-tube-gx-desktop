import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import WebSocket from 'ws';
import { CastServer } from '../src/main/cast-server.js';

function connect(port, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gxtube`, { headers });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.once('open', () => resolve({ ws, inbox }));
    ws.once('error', reject);
  });
}

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, 20));
  }
  throw new Error('Zeitüberschreitung');
};

test('Handy verbindet sich, schickt Befehle, bekommt Zustand', async () => {
  const server = new CastServer({ id: 'pc-1', name: 'Wohnzimmer', version: '1.2.3', port: 0, discoveryPort: 0 });
  await server.start();
  const commands = [];
  const clientLists = [];
  server.on('command', (c, peer) => commands.push([c, peer.name]));
  server.on('clients', (l) => clientLists.push(l));
  try {
    const { ws, inbox } = await connect(server.port);
    ws.send(JSON.stringify({ type: 'pause' }));
    await until(() => inbox.find((m) => m.type === 'error'));
    assert.equal(commands.length, 0, 'ohne hello keine Befehle');

    ws.send(JSON.stringify({ type: 'hello', name: 'Pixel', deviceId: 'abc', protocol: 1 }));
    const welcome = await until(() => inbox.find((m) => m.type === 'welcome'));
    assert.equal(welcome.name, 'Wohnzimmer');
    assert.equal(welcome.protocol, 1);
    assert.equal(server.clients()[0].name, 'Pixel');

    ws.send(JSON.stringify({ type: 'play', video: { id: 'dQw4w9WgXcQ', title: 'Rick' } }));
    ws.send(JSON.stringify({ type: 'volume', value: 30 }));
    ws.send(JSON.stringify({ type: 'ping' }));
    await until(() => commands.length === 2 && inbox.find((m) => m.type === 'pong'));
    assert.equal(commands[0][0].video.id, 'dQw4w9WgXcQ');
    assert.equal(commands[0][1], 'Pixel');

    server.broadcast({ type: 'state', status: 'playing' });
    await until(() => inbox.find((m) => m.type === 'state'));

    ws.send('{kaputt');
    await until(() => inbox.filter((m) => m.type === 'error').length === 2);

    ws.close();
    await until(() => server.clients().length === 0);
    assert.ok(clientLists.length >= 2);
  } finally {
    await server.stop();
  }
});

test('Browser-Webseiten (Origin) und falsche Pfade werden abgelehnt', async () => {
  const server = new CastServer({ id: 'pc', name: 'PC', port: 0, discoveryPort: 0 });
  await server.start();
  try {
    await assert.rejects(connect(server.port, { Origin: 'https://example.com' }));
    await assert.rejects(new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/anders`);
      ws.once('open', resolve);
      ws.once('error', reject);
    }));
  } finally {
    await server.stop();
  }
});

test('Fremde Adressen werden abgelehnt', async () => {
  const server = new CastServer({ id: 'pc', name: 'PC', port: 0, discoveryPort: 0, allowAddress: () => false });
  await server.start();
  try {
    await assert.rejects(connect(server.port));
  } finally {
    await server.stop();
  }
});

test('PC antwortet auf die Suche im WLAN', async () => {
  const server = new CastServer({ id: 'pc-9', name: 'Büro', version: '0.1.7', port: 0, discoveryPort: 0 });
  await server.start();
  try {
    const discoveryPort = server.udp.address().port;
    const reply = await new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const t = setTimeout(() => { sock.close(); reject(new Error('keine Antwort')); }, 2000);
      sock.on('message', (buf) => { clearTimeout(t); sock.close(); resolve(JSON.parse(buf.toString())); });
      sock.bind(0, () => {
        sock.send('quatsch', discoveryPort, '127.0.0.1');
        sock.send(JSON.stringify({ type: 'discover', protocol: 1 }), discoveryPort, '127.0.0.1');
      });
    });
    assert.deepEqual(reply, { type: 'device', protocol: 1, app: 'GX Tube Desktop', id: 'pc-9', name: 'Büro', port: server.port, version: '0.1.7' });
  } finally {
    await server.stop();
  }
});

test('Belegter Port: nächster freier wird genommen', async () => {
  const a = new CastServer({ id: 'a', name: 'A', port: 0, discoveryPort: 0 });
  await a.start();
  const b = new CastServer({ id: 'b', name: 'B', port: a.port, discoveryPort: 0, host: '0.0.0.0' });
  try {
    await b.start();
    assert.notEqual(b.port, a.port);
  } finally {
    await b.stop();
    await a.stop();
  }
});
