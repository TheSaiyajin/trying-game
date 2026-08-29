const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { attachRealtime, authenticateSocket } = require('../backend/realtime');

test('socket authentication accepts valid tokens and attaches only verified claims', () => {
  const socket = { handshake: { auth: { token: 'valid-token' } } };
  let nextError = null;
  authenticateSocket((token) => ({ userId: token === 'valid-token' ? 42 : null }))(socket, (error) => {
    nextError = error || null;
  });

  assert.equal(nextError, null);
  assert.deepEqual(socket.user, { userId: 42 });
});

test('socket authentication rejects missing and invalid tokens', () => {
  for (const socket of [{ handshake: { auth: {} } }, { handshake: { auth: { token: 'bad' } } }]) {
    let nextError = null;
    authenticateSocket(() => { throw new Error('invalid'); })(socket, (error) => {
      nextError = error;
    });
    assert.match(nextError.message, /Authentication|required|Invalid|expired/);
  }
});

test('public state events contain only a revision marker', async () => {
  const server = http.createServer();
  const realtime = attachRealtime(server, { verifyToken: () => ({ userId: 1 }) });
  const emitted = [];
  realtime.io.emit = (event, payload) => emitted.push({ event, payload });

  realtime.notifyStateChanged();

  assert.equal(emitted[0].event, 'state:changed');
  assert.deepEqual(Object.keys(emitted[0].payload), ['revision']);
  await realtime.io.close();
});

test('Info button is beside Logout and modal includes required copy', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="info-btn"[\s\S]*id="logout-btn"/);
  assert.match(html, /About SaiWars/);
  assert.match(html, /Strategic combat, balancing and comeback systems, buildings, faction bonuses, map events, season rewards and UI improvements\./);
  assert.match(html, /Support will never provide gameplay advantages\./);
  assert.match(html, /thesaiyajin/);
});