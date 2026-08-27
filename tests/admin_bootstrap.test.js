const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapAdmin } = require('../backend/admin-bootstrap');
const { getRegistrationRole } = require('../backend/admin-policy');

function createPlayersClient(players) {
  return {
    async query(sql, params = []) {
      const text = sql.trim();

      if (text === 'SELECT id, role FROM players WHERE username = $1 FOR UPDATE') {
        const player = [...players.values()].find((p) => p.username === params[0]);
        return { rows: player ? [{ id: player.id, role: player.role }] : [], rowCount: player ? 1 : 0 };
      }

      if (text === 'UPDATE players SET role = $1 WHERE id = $2') {
        const player = players.get(params[1]);
        if (player) player.role = params[0];
        return { rows: [], rowCount: player ? 1 : 0 };
      }

      throw new Error(`Unexpected query in bootstrap test client: ${text}`);
    },
  };
}

test('registering the exact username Sai never receives admin without bootstrap authorization', () => {
  // This is what /api/register actually assigns as the new player's role, regardless of
  // the requested username. It never depends on ADMIN_BOOTSTRAP_TOKEN or any other secret.
  const role = getRegistrationRole('Sai');
  assert.equal(role, 'member');
});

test('bootstrap requires ADMIN_BOOTSTRAP_TOKEN to be configured on the server', async () => {
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
  const client = createPlayersClient(new Map([[1, { id: 1, username: 'Sai', role: 'member' }]]));

  const result = await bootstrapAdmin(client, { token: 'anything' });

  assert.deepEqual(result, { ok: false, status: 500, error: 'ADMIN_BOOTSTRAP_TOKEN is not configured on the server.' });
});

test('bootstrap rejects a missing or incorrect token', async () => {
  process.env.ADMIN_BOOTSTRAP_TOKEN = 'correct-token';
  const client = createPlayersClient(new Map([[1, { id: 1, username: 'Sai', role: 'member' }]]));

  const missing = await bootstrapAdmin(client, { token: undefined });
  const wrong = await bootstrapAdmin(client, { token: 'wrong-token' });

  assert.deepEqual(missing, { ok: false, status: 403, error: 'Invalid bootstrap token.' });
  assert.deepEqual(wrong, { ok: false, status: 403, error: 'Invalid bootstrap token.' });
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
});

test('bootstrap rejects when the Sai account does not exist yet', async () => {
  process.env.ADMIN_BOOTSTRAP_TOKEN = 'correct-token';
  const client = createPlayersClient(new Map());

  const result = await bootstrapAdmin(client, { token: 'correct-token' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
});

test('bootstrap promotes Sai to admin with a correct token', async () => {
  process.env.ADMIN_BOOTSTRAP_TOKEN = 'correct-token';
  const players = new Map([[1, { id: 1, username: 'Sai', role: 'member' }]]);
  const client = createPlayersClient(players);

  const result = await bootstrapAdmin(client, { token: 'correct-token' });

  assert.deepEqual(result, { ok: true, username: 'Sai' });
  assert.equal(players.get(1).role, 'admin');
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
});
