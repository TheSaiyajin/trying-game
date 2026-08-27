const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assignFactionLeader,
  parseNonNegativeInteger,
  updatePlayerResources,
  updatePlayerRole,
  updatePlayerSoldiers,
  updateTerritory,
} = require('../backend/admin-write-operations');

function createAdminClient({ players, territories, factionLeaders }) {
  const adminActions = [];

  return {
    adminActions,
    async query(sql, params = []) {
      const text = sql.trim();

      if (text === 'SELECT id FROM players WHERE id = $1 FOR UPDATE') {
        const player = players.get(params[0]);
        return { rows: player ? [{ id: player.id }] : [], rowCount: player ? 1 : 0 };
      }

      if (text === 'SELECT id, username, role FROM players WHERE id = $1 FOR UPDATE') {
        const player = players.get(params[0]);
        return { rows: player ? [{ id: player.id, username: player.username, role: player.role }] : [], rowCount: player ? 1 : 0 };
      }

      if (text === 'SELECT id, username, faction, role FROM players WHERE id = $1 FOR UPDATE') {
        const player = players.get(params[0]);
        return { rows: player ? [{ id: player.id, username: player.username, faction: player.faction, role: player.role }] : [], rowCount: player ? 1 : 0 };
      }

      if (text === 'SELECT id FROM territories WHERE id = $1 FOR UPDATE') {
        const territory = territories.get(params[0]);
        return { rows: territory ? [{ id: territory.id }] : [], rowCount: territory ? 1 : 0 };
      }

      if (text.startsWith('UPDATE players SET resource_')) {
        const player = players.get(params.at(-1));
        if (player) {
          const assignments = text.match(/resource_[a-z]+ = \$\d+/g) || [];
          assignments.forEach((assignment, index) => {
            const column = assignment.split(' = ')[0];
            player[column] = params[index];
          });
        }
        return { rows: [], rowCount: player ? 1 : 0 };
      }

      if (text === 'UPDATE players SET soldiers = $1 WHERE id = $2') {
        const player = players.get(params[1]);
        if (player) player.soldiers = params[0];
        return { rows: [], rowCount: player ? 1 : 0 };
      }

      if (text === 'UPDATE players SET role = $1 WHERE id = $2') {
        const player = players.get(params[1]);
        if (player) player.role = params[0];
        return { rows: [], rowCount: player ? 1 : 0 };
      }

      if (text.startsWith('UPDATE territories SET ')) {
        const territory = territories.get(params.at(-1));
        if (territory) {
          const assignments = text.match(/(owner_faction|defense_troops) = \$\d+/g) || [];
          assignments.forEach((assignment, index) => {
            const column = assignment.split(' = ')[0];
            territory[column] = params[index];
          });
        }
        return { rows: [], rowCount: territory ? 1 : 0 };
      }

      if (text.startsWith('INSERT INTO faction_leaders')) {
        factionLeaders.set(params[0], params[1]);
        return { rows: [], rowCount: 1 };
      }

      if (text.startsWith('INSERT INTO admin_actions')) {
        adminActions.push({
          actorId: params[0],
          actionName: params[1],
          detail: JSON.parse(params[2]),
        });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query in admin operations test client: ${text}`);
    },
  };
}

test('resource updates floor decimals before writing integer columns and log the sanitized values', async () => {
  const players = new Map([
    [2, { id: 2, resource_food: 0, resource_wood: 0, resource_iron: 0, resource_manpower: 0 }],
  ]);
  const client = createAdminClient({ players, territories: new Map(), factionLeaders: new Map() });

  const result = await updatePlayerResources(client, {
    actorId: 1,
    playerId: 2,
    input: { food: 12.9, wood: '8.4', iron: 0, manpower: 3.99 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    {
      food: players.get(2).resource_food,
      wood: players.get(2).resource_wood,
      iron: players.get(2).resource_iron,
      manpower: players.get(2).resource_manpower,
    },
    { food: 12, wood: 8, iron: 0, manpower: 3 }
  );
  assert.deepEqual(client.adminActions[0].detail, { playerId: 2, food: 12, wood: 8, iron: 0, manpower: 3 });
});

test('resource updates reject invalid numeric input with 400 instead of writing bad values', async () => {
  const client = createAdminClient({ players: new Map([[2, { id: 2 }]]), territories: new Map(), factionLeaders: new Map() });

  const result = await updatePlayerResources(client, {
    actorId: 1,
    playerId: 2,
    input: { food: 'abc' },
  });

  assert.deepEqual(result, { ok: false, status: 400, error: 'food must be a valid number.' });
  assert.equal(client.adminActions.length, 0);
});

test('soldier updates floor decimals and log sanitized integers', async () => {
  const players = new Map([[2, { id: 2, soldiers: 5 }]]);
  const client = createAdminClient({ players, territories: new Map(), factionLeaders: new Map() });

  const result = await updatePlayerSoldiers(client, { actorId: 1, playerId: 2, soldiers: 19.75 });

  assert.equal(result.ok, true);
  assert.equal(players.get(2).soldiers, 19);
  assert.deepEqual(client.adminActions[0].detail, { playerId: 2, soldiers: 19 });
});

test('role updates validate against Sai-only admin rules', async () => {
  const players = new Map([
    [1, { id: 1, username: 'Sai', role: 'admin' }],
    [2, { id: 2, username: 'Rook', role: 'member' }],
  ]);
  const client = createAdminClient({ players, territories: new Map(), factionLeaders: new Map() });

  const okResult = await updatePlayerRole(client, { actorId: 1, playerId: 2, role: 'leader' });
  const blockedResult = await updatePlayerRole(client, { actorId: 1, playerId: 1, role: 'member' });

  assert.equal(okResult.ok, true);
  assert.equal(players.get(2).role, 'leader');
  assert.deepEqual(blockedResult, { ok: false, status: 400, error: 'Sai must remain admin.' });
});

test('territory admin updates validate owner and floor defense values', async () => {
  const territories = new Map([
    ['n1', { id: 'n1', owner_faction: 'neutral', defense_troops: 5 }],
  ]);
  const client = createAdminClient({ players: new Map(), territories, factionLeaders: new Map() });

  const result = await updateTerritory(client, {
    actorId: 1,
    territoryId: 'n1',
    owner: 'green',
    defense: 14.8,
    validFactions: ['blue', 'red', 'green'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(territories.get('n1'), { id: 'n1', owner_faction: 'green', defense_troops: 14 });
  assert.deepEqual(client.adminActions[0].detail, { territoryId: 'n1', owner: 'green', defense: 14 });
});

test('invalid leader assignment returns 400 or 404 before database constraints can fail', async () => {
  const players = new Map([
    [1, { id: 1, username: 'Sai', faction: 'blue', role: 'admin' }],
    [2, { id: 2, username: 'Rook', faction: 'red', role: 'member' }],
  ]);
  const client = createAdminClient({ players, territories: new Map(), factionLeaders: new Map() });

  const wrongFaction = await assignFactionLeader(client, {
    actorId: 1,
    playerId: 2,
    faction: 'blue',
    validFactions: ['blue', 'red', 'green'],
  });
  const missingPlayer = await assignFactionLeader(client, {
    actorId: 1,
    playerId: 999,
    faction: 'red',
    validFactions: ['blue', 'red', 'green'],
  });
  const blockedSai = await assignFactionLeader(client, {
    actorId: 1,
    playerId: 1,
    faction: 'blue',
    validFactions: ['blue', 'red', 'green'],
  });

  assert.deepEqual(wrongFaction, { ok: false, status: 400, error: 'Player must belong to the selected faction.' });
  assert.deepEqual(missingPlayer, { ok: false, status: 404, error: 'Player not found.' });
  assert.deepEqual(blockedSai, { ok: false, status: 400, error: 'Sai must remain admin.' });
  assert.equal(client.adminActions.length, 0);
});

test('integer parser rejects blank and boolean admin values', () => {
  assert.deepEqual(parseNonNegativeInteger('', 'food'), { ok: false, status: 400, error: 'food must be a valid number.' });
  assert.deepEqual(parseNonNegativeInteger(true, 'food'), { ok: false, status: 400, error: 'food must be a valid number.' });
});
