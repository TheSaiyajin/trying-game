const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assignFactionLeader,
  parseNonNegativeInteger,
  updatePlayerResources,
  updatePlayerRole,
  updatePlayerSoldiers,
  updateTerritory,
  updateCapital,
} = require('../backend/admin-write-operations');

function createAdminClient({ players, territories, factionLeaders, territoryDefenders = new Map() }) {
  const adminActions = [];

  return {
    adminActions,
    territoryDefenders,
    async query(sql, params = []) {
      const text = sql.trim().replace(/\s+/g, ' ');

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

      if (text === 'SELECT * FROM territories WHERE id = $1 FOR UPDATE') {
        const territory = territories.get(params[0]);
        return { rows: territory ? [{ ...territory }] : [], rowCount: territory ? 1 : 0 };
      }

      if (text === 'SELECT id, owner_faction, is_capital FROM territories WHERE id = $1 FOR UPDATE') {
        const territory = territories.get(params[0]);
        return {
          rows: territory ? [{ id: territory.id, owner_faction: territory.owner_faction, is_capital: !!territory.is_capital }] : [],
          rowCount: territory ? 1 : 0,
        };
      }

      if (text === 'SELECT id FROM territories WHERE is_capital = TRUE AND owner_faction = $1 FOR UPDATE') {
        const match = [...territories.values()].find((t) => t.is_capital && t.owner_faction === params[0]);
        return { rows: match ? [{ id: match.id }] : [], rowCount: match ? 1 : 0 };
      }

      if (text === 'UPDATE territories SET is_capital = FALSE WHERE id = $1') {
        const territory = territories.get(params[0]);
        if (territory) territory.is_capital = false;
        return { rows: [], rowCount: territory ? 1 : 0 };
      }

      if (text === 'UPDATE territories SET is_capital = TRUE WHERE id = $1') {
        const territory = territories.get(params[0]);
        if (territory) territory.is_capital = true;
        return { rows: [], rowCount: territory ? 1 : 0 };
      }

      if (text === 'SELECT territory_id, player_id, faction, troops FROM territory_defenders WHERE territory_id = $1 ORDER BY player_id FOR UPDATE') {
        const rows = (territoryDefenders.get(params[0]) || []).map((d) => ({ ...d }));
        return { rows, rowCount: rows.length };
      }

      if (text === 'DELETE FROM territory_defenders WHERE territory_id = $1 AND faction <> $2') {
        const remaining = (territoryDefenders.get(params[0]) || []).filter((d) => d.faction === params[1]);
        territoryDefenders.set(params[0], remaining);
        return { rows: [], rowCount: 1 };
      }

      if (text === 'UPDATE players SET soldiers = soldiers + $1 WHERE id = $2') {
        const player = players.get(params[1]);
        if (player) player.soldiers = Number(player.soldiers || 0) + Number(params[0]);
        return { rows: [], rowCount: player ? 1 : 0 };
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

test('admin cannot change the owner of a capital territory', async () => {
  const territories = new Map([
    ['b1', { id: 'b1', owner_faction: 'blue', is_capital: true, defense_troops: 35 }],
  ]);
  const client = createAdminClient({ players: new Map(), territories, factionLeaders: new Map() });

  const result = await updateTerritory(client, {
    actorId: 1,
    territoryId: 'b1',
    owner: 'red',
    validFactions: ['blue', 'red', 'green'],
  });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: 'Capital ownership cannot be changed.',
  });
  assert.equal(territories.get('b1').owner_faction, 'blue');
  assert.equal(client.adminActions.length, 0);
});

test('admin can still change a capital defense amount without changing its owner', async () => {
  const territories = new Map([
    ['b1', { id: 'b1', owner_faction: 'blue', is_capital: true, defense_troops: 35 }],
  ]);
  const client = createAdminClient({ players: new Map(), territories, factionLeaders: new Map() });

  const result = await updateTerritory(client, {
    actorId: 99,
    territoryId: 'b1',
    owner: 'blue',
    defense: 42,
    validFactions: ['blue', 'red', 'green'],
  });

  assert.equal(result.ok, true);
  assert.equal(territories.get('b1').owner_faction, 'blue');
  assert.equal(territories.get('b1').defense_troops, 42);
  assert.equal(client.adminActions.length, 1);
});

test('admin can move the capital designation to a new territory the faction already owns', async () => {
  const territories = new Map([
    ['b1', { id: 'b1', owner_faction: 'blue', is_capital: true, defense_troops: 35 }],
    ['n1', { id: 'n1', owner_faction: 'blue', is_capital: false, defense_troops: 18 }],
  ]);
  const client = createAdminClient({ players: new Map(), territories, factionLeaders: new Map() });

  const result = await updateCapital(client, {
    actorId: 1,
    territoryId: 'n1',
    faction: 'blue',
    validFactions: ['blue', 'red', 'green'],
  });

  assert.equal(result.ok, true);
  assert.equal(territories.get('b1').is_capital, false);
  assert.equal(territories.get('n1').is_capital, true);
  assert.equal(territories.get('n1').owner_faction, 'blue');
  // Exactly one capital remains for blue: never zero, never two.
  const blueCapitals = [...territories.values()].filter((t) => t.owner_faction === 'blue' && t.is_capital);
  assert.equal(blueCapitals.length, 1);
  assert.equal(client.adminActions.length, 1);
});

test('capital reassignment is a no-op when the territory is already that faction capital', async () => {
  const territories = new Map([
    ['b1', { id: 'b1', owner_faction: 'blue', is_capital: true, defense_troops: 35 }],
  ]);
  const client = createAdminClient({ players: new Map(), territories, factionLeaders: new Map() });

  const result = await updateCapital(client, {
    actorId: 1,
    territoryId: 'b1',
    faction: 'blue',
    validFactions: ['blue', 'red', 'green'],
  });

  assert.equal(result.ok, true);
  assert.equal(territories.get('b1').is_capital, true);
  assert.equal(client.adminActions.length, 0);
});

test('capital reassignment rejects a territory the faction does not own instead of silently changing its owner', async () => {
  const territories = new Map([
    ['b1', { id: 'b1', owner_faction: 'blue', is_capital: true, defense_troops: 35 }],
    ['n1', { id: 'n1', owner_faction: 'neutral', is_capital: false, defense_troops: 18 }],
  ]);
  const client = createAdminClient({ players: new Map(), territories, factionLeaders: new Map() });

  const result = await updateCapital(client, {
    actorId: 1,
    territoryId: 'n1',
    faction: 'blue',
    validFactions: ['blue', 'red', 'green'],
  });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: 'A territory can only become a capital for the faction that already owns it.',
  });
  // Ownership must stay untouched: no silent capture through the capital tool.
  assert.equal(territories.get('n1').owner_faction, 'neutral');
  assert.equal(territories.get('n1').is_capital, false);
  assert.equal(client.adminActions.length, 0);
});

test('capital reassignment cannot steal another faction\'s existing capital', async () => {
  const territories = new Map([
    ['b1', { id: 'b1', owner_faction: 'blue', is_capital: true, defense_troops: 35 }],
    ['r1', { id: 'r1', owner_faction: 'red', is_capital: true, defense_troops: 35 }],
  ]);
  const client = createAdminClient({ players: new Map(), territories, factionLeaders: new Map() });

  const result = await updateCapital(client, {
    actorId: 1,
    territoryId: 'r1',
    faction: 'blue',
    validFactions: ['blue', 'red', 'green'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(territories.get('r1').owner_faction, 'red');
  assert.equal(territories.get('r1').is_capital, true);
  assert.equal(territories.get('b1').is_capital, true);
});

test('capital assignment rejects invalid factions and missing territories', async () => {
  const territories = new Map([
    ['b1', { id: 'b1', owner_faction: 'blue', is_capital: true, defense_troops: 35 }],
  ]);
  const client = createAdminClient({ players: new Map(), territories, factionLeaders: new Map() });

  const invalidFaction = await updateCapital(client, {
    actorId: 1,
    territoryId: 'b1',
    faction: 'purple',
    validFactions: ['blue', 'red', 'green'],
  });
  const missingTerritory = await updateCapital(client, {
    actorId: 1,
    territoryId: 'missing',
    faction: 'blue',
    validFactions: ['blue', 'red', 'green'],
  });

  assert.deepEqual(invalidFaction, { ok: false, status: 400, error: 'Invalid faction.' });
  assert.deepEqual(missingTerritory, { ok: false, status: 404, error: 'Territory not found.' });
  assert.equal(client.adminActions.length, 0);
});

test('admin ownership change refunds and removes stale enemy-faction defenders (blue territory)', async () => {
  const territories = new Map([
    ['n1', { id: 'n1', owner_faction: 'blue', defense_troops: 40 }],
  ]);
  const players = new Map([
    [10, { id: 10, faction: 'blue', soldiers: 5 }],
  ]);
  const territoryDefenders = new Map([
    ['n1', [{ territory_id: 'n1', player_id: 10, faction: 'blue', troops: 15 }]],
  ]);
  const client = createAdminClient({ players, territories, factionLeaders: new Map(), territoryDefenders });

  const result = await updateTerritory(client, {
    actorId: 1,
    territoryId: 'n1',
    owner: 'red',
    validFactions: ['blue', 'red', 'green'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.detail.defendersRefunded, 15);
  assert.equal(players.get(10).soldiers, 20);
  assert.deepEqual(territoryDefenders.get('n1'), []);
  // Total defense drops by exactly the refunded stationed troops (40 - 15 = 25).
  assert.equal(territories.get('n1').defense_troops, 25);
});

test('admin ownership change refunds stale defenders for all three factions', async () => {
  for (const [oldFaction, newFaction] of [['blue', 'red'], ['red', 'green'], ['green', 'blue']]) {
    const territories = new Map([
      ['n1', { id: 'n1', owner_faction: oldFaction, defense_troops: 30 }],
    ]);
    const players = new Map([
      [1, { id: 1, faction: oldFaction, soldiers: 0 }],
    ]);
    const territoryDefenders = new Map([
      ['n1', [{ territory_id: 'n1', player_id: 1, faction: oldFaction, troops: 10 }]],
    ]);
    const client = createAdminClient({ players, territories, factionLeaders: new Map(), territoryDefenders });

    const result = await updateTerritory(client, {
      actorId: 1,
      territoryId: 'n1',
      owner: newFaction,
      validFactions: ['blue', 'red', 'green'],
    });

    assert.equal(result.ok, true, `${oldFaction} -> ${newFaction}`);
    assert.equal(players.get(1).soldiers, 10, `${oldFaction} -> ${newFaction} refund`);
    assert.deepEqual(territoryDefenders.get('n1'), [], `${oldFaction} -> ${newFaction} cleared`);
  }
});

test('admin ownership change keeps valid same-faction defenders untouched', async () => {
  const territories = new Map([
    ['n1', { id: 'n1', owner_faction: 'blue', defense_troops: 30 }],
  ]);
  const players = new Map([
    [10, { id: 10, faction: 'blue', soldiers: 0 }],
  ]);
  const territoryDefenders = new Map([
    ['n1', [{ territory_id: 'n1', player_id: 10, faction: 'blue', troops: 12 }]],
  ]);
  const client = createAdminClient({ players, territories, factionLeaders: new Map(), territoryDefenders });

  // Re-assigning the same owner should not disturb already-valid defenders or refund anyone.
  const result = await updateTerritory(client, {
    actorId: 1,
    territoryId: 'n1',
    owner: 'blue',
    validFactions: ['blue', 'red', 'green'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.detail.defendersRefunded, undefined);
  assert.equal(players.get(10).soldiers, 0);
  assert.deepEqual(territoryDefenders.get('n1'), [{ territory_id: 'n1', player_id: 10, faction: 'blue', troops: 12 }]);
});

