const test = require('node:test');
const assert = require('node:assert/strict');
const { AttackError, performAttack } = require('../backend/attack-logic');

function cloneTerritory(territory) {
  return { ...territory };
}

function createFakeClient({ players, territories, neighbors, lockedTerritoryIds = new Set(), initialDefenders = [] }) {
  const battleHistory = [];
  const defenders = new Map();
  const playerSeasonStats = new Map();
  const ownershipHistory = new Set();
  initialDefenders.forEach((defender) => {
    defenders.set(`${defender.territory_id}:${defender.player_id}`, {
      faction: defender.faction,
      troops: defender.troops,
    });
  });

  return {
    battleHistory,
    defenders,
    playerSeasonStats,
    players,
    territories,
    async query(sql, params = []) {
      const text = sql.trim();

      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }

      if (text === 'SELECT soldiers FROM players WHERE id = $1 FOR UPDATE') {
        const player = players.get(params[0]);
        return { rows: player ? [{ soldiers: player.soldiers }] : [] };
      }

      if (text.startsWith('SELECT * FROM players WHERE id = $1')) {
        const player = players.get(params[0]);
        return { rows: player ? [player] : [] };
      }

      if (text.startsWith('SELECT * FROM territories WHERE id = $1')) {
        const territory = territories.get(params[0]);
        return { rows: territory ? [territory] : [] };
      }

      if (text.includes('FROM territory_neighbors')) {
        const [targetId, faction] = params;
        const neighborIds = neighbors.get(targetId) || new Set();
        for (const neighborId of neighborIds) {
          const neighborTerritory = territories.get(neighborId);
          if (neighborTerritory && neighborTerritory.owner_faction === faction) {
            return { rowCount: 1, rows: [{ ok: 1 }] };
          }
        }
        return { rowCount: 0, rows: [] };
      }

      if (text.includes('pg_try_advisory_xact_lock')) {
        const territoryId = params[0];
        return { rows: [{ locked: !lockedTerritoryIds.has(territoryId) }] };
      }

      if (text.startsWith('UPDATE players SET soldiers = soldiers - $1')) {
        const [amount, playerId] = params;
        const player = players.get(playerId);
        if (player) player.soldiers -= amount;
        return { rows: [] };
      }

      if (text.startsWith('UPDATE territories SET owner_faction = $1')) {
        const [ownerFaction, defenseTroops, territoryId] = params;
        const territory = territories.get(territoryId);
        if (territory) {
          territory.owner_faction = ownerFaction;
          territory.defense_troops = defenseTroops;
        }
        return { rows: [] };
      }

      if (text.startsWith('UPDATE territories SET defense_troops = $1')) {
        const [defenseTroops, territoryId] = params;
        const territory = territories.get(territoryId);
        if (territory) territory.defense_troops = defenseTroops;
        return { rows: [] };
      }

      if (text.startsWith('DELETE FROM territory_defenders')) {
        const territoryId = params[0];
        for (const key of [...defenders.keys()]) {
          if (key.startsWith(`${territoryId}:`)) defenders.delete(key);
        }
        return { rows: [] };
      }

      if (text.includes('FROM territory_defenders') && text.includes('WHERE territory_id = $1')) {
        const territoryId = params[0];
        const rows = [...defenders.entries()]
          .filter(([key]) => key.startsWith(`${territoryId}:`))
          .map(([key, value]) => {
            const [, playerId] = key.split(':');
            return { territory_id: territoryId, player_id: Number(playerId), faction: value.faction, troops: value.troops };
          })
          .sort((left, right) => left.player_id - right.player_id);
        return { rows, rowCount: rows.length };
      }

      if (text.startsWith('INSERT INTO territory_defenders')) {
        const [territoryId, playerId, faction, troops] = params;
        defenders.set(`${territoryId}:${playerId}`, { faction, troops });
        return { rows: [] };
      }

      if (text.startsWith('UPDATE players SET resource_food = resource_food + 25')) {
        const player = players.get(params[0]);
        if (player) {
          player.resource_food = (player.resource_food || 0) + 25;
          player.resource_wood = (player.resource_wood || 0) + 25;
          player.resource_iron = (player.resource_iron || 0) + 25;
        }
        return { rows: [] };
      }

      if (text.startsWith('INSERT INTO battle_history')) {
        battleHistory.push(params);
        return { rows: [] };
      }

      if (text.startsWith('SELECT 1 FROM season_territory_faction_ownership')) {
        return { rows: ownershipHistory.has(params.join(':')) ? [{ exists: 1 }] : [], rowCount: ownershipHistory.has(params.join(':')) ? 1 : 0 };
      }

      if (text.startsWith('INSERT INTO season_territory_faction_ownership')) {
        ownershipHistory.add(params.join(':'));
        return { rows: [], rowCount: 1 };
      }

      if (text.startsWith('INSERT INTO player_season_stats')) {
        const key = `${params[0]}:${params[1]}`;
        const current = playerSeasonStats.get(key) || Array(8).fill(0);
        playerSeasonStats.set(key, current.map((value, index) => value + params[index + 2]));
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query in fake client: ${text}`);
    },
  };
}

function buildWorld() {
  const players = new Map([
    [1, { id: 1, faction: 'blue', soldiers: 50, resource_food: 0, resource_wood: 0, resource_iron: 0 }],
    [2, { id: 2, faction: 'red', soldiers: 50, resource_food: 0, resource_wood: 0, resource_iron: 0 }],
    [3, { id: 3, faction: null, soldiers: 20 }],
  ]);

  const territories = new Map([
    ['b1', cloneTerritory({ id: 'b1', owner_faction: 'blue', defense_troops: 30, is_fortress: false })],
    ['r1', cloneTerritory({ id: 'r1', owner_faction: 'red', defense_troops: 30, is_fortress: false })],
    ['n1', cloneTerritory({ id: 'n1', owner_faction: 'neutral', defense_troops: 10, is_fortress: false })],
    ['n2', cloneTerritory({ id: 'n2', owner_faction: 'neutral', defense_troops: 100, is_fortress: false })],
    ['n3', cloneTerritory({ id: 'n3', owner_faction: 'red', defense_troops: 5, is_fortress: false })],
    ['x1', cloneTerritory({ id: 'x1', owner_faction: 'neutral', defense_troops: 5, is_fortress: false })],
  ]);

  const neighbors = new Map([
    ['b1', new Set(['n1', 'n2', 'n3'])],
    ['n1', new Set(['b1'])],
    ['n2', new Set(['b1'])],
    ['n3', new Set(['b1', 'r1'])],
    ['r1', new Set(['n3'])],
    ['x1', new Set()],
  ]);

  return { players, territories, neighbors };
}

test('attacking a neutral territory with more troops than defenders captures it and garrisons the leftovers', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors });

  const result = await performAttack(client, { playerId: 1, territoryId: 'n1', soldiers: 40 });

  assert.equal(result.outcome.victory, true);
  assert.equal(territories.get('n1').owner_faction, 'blue');
  assert.equal(territories.get('n1').defense_troops, 30);
  assert.equal(players.get(1).soldiers, 10);
  assert.deepEqual(client.defenders.get('n1:1'), { faction: 'blue', troops: 30 });
});

test('attacking an enemy territory with enough troops captures it from the other faction', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors });

  const result = await performAttack(client, { playerId: 1, territoryId: 'n3', soldiers: 20 });

  assert.equal(result.outcome.victory, true);
  assert.equal(territories.get('n3').owner_faction, 'blue');
  assert.equal(territories.get('n3').defense_troops, 15);
});

test('attacking with fewer troops than defenders fails and only kills that many defenders', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors });

  const result = await performAttack(client, { playerId: 1, territoryId: 'n2', soldiers: 10 });

  assert.equal(result.outcome.victory, false);
  assert.equal(territories.get('n2').owner_faction, 'neutral');
  assert.equal(territories.get('n2').defense_troops, 90);
  assert.equal(players.get(1).soldiers, 40);
});

test('failed attacks reduce stationed defender rows so dead troops cannot be recalled', async () => {
  const { players, territories, neighbors } = buildWorld();
  territories.set('n3', cloneTerritory({ id: 'n3', owner_faction: 'red', defense_troops: 12, is_fortress: false }));
  const client = createFakeClient({
    players,
    territories,
    neighbors,
    initialDefenders: [
      { territory_id: 'n3', player_id: 2, faction: 'red', troops: 7 },
      { territory_id: 'n3', player_id: 4, faction: 'red', troops: 5 },
    ],
  });

  const result = await performAttack(client, { playerId: 1, territoryId: 'n3', soldiers: 5 });

  assert.equal(result.outcome.victory, false);
  assert.equal(territories.get('n3').defense_troops, 7);
  assert.deepEqual(client.defenders.get('n3:2'), { faction: 'red', troops: 4 });
  assert.deepEqual(client.defenders.get('n3:4'), { faction: 'red', troops: 3 });
});

test('failed attacks against base defenders only reduce total defense without creating stationed rows', async () => {
  const { players, territories, neighbors } = buildWorld();
  territories.set('n3', cloneTerritory({ id: 'n3', owner_faction: 'red', defense_troops: 35, is_fortress: false }));
  const client = createFakeClient({ players, territories, neighbors });

  const result = await performAttack(client, { playerId: 1, territoryId: 'n3', soldiers: 5 });

  assert.equal(result.outcome.victory, false);
  assert.equal(territories.get('n3').defense_troops, 30);
  assert.equal(client.defenders.size, 0);
});

test('failed attacks preserve base defenders while reducing a single stationed garrison', async () => {
  const { players, territories, neighbors } = buildWorld();
  territories.set('n3', cloneTerritory({ id: 'n3', owner_faction: 'red', defense_troops: 45, is_fortress: false }));
  const client = createFakeClient({
    players,
    territories,
    neighbors,
    initialDefenders: [
      { territory_id: 'n3', player_id: 2, faction: 'red', troops: 10 },
    ],
  });

  const result = await performAttack(client, { playerId: 1, territoryId: 'n3', soldiers: 5 });

  assert.equal(result.outcome.victory, false);
  assert.equal(territories.get('n3').defense_troops, 40);
  assert.deepEqual(client.defenders.get('n3:2'), { faction: 'red', troops: 5 });
});

test('failed attacks preserve base defenders when multiple stationed garrisons take casualties', async () => {
  const { players, territories, neighbors } = buildWorld();
  territories.set('n3', cloneTerritory({ id: 'n3', owner_faction: 'red', defense_troops: 45, is_fortress: false }));
  const client = createFakeClient({
    players,
    territories,
    neighbors,
    initialDefenders: [
      { territory_id: 'n3', player_id: 2, faction: 'red', troops: 6 },
      { territory_id: 'n3', player_id: 4, faction: 'red', troops: 4 },
    ],
  });

  const result = await performAttack(client, { playerId: 1, territoryId: 'n3', soldiers: 12 });

  assert.equal(result.outcome.victory, false);
  assert.equal(territories.get('n3').defense_troops, 33);
  assert.equal(client.defenders.has('n3:2'), false);
  assert.equal(client.defenders.has('n3:4'), false);
});

test('capturing a territory with only player-garrison defenders replaces them with the attacking survivors', async () => {
  const { players, territories, neighbors } = buildWorld();
  territories.set('n3', cloneTerritory({ id: 'n3', owner_faction: 'red', defense_troops: 5, is_fortress: false }));
  const client = createFakeClient({
    players,
    territories,
    neighbors,
    initialDefenders: [
      { territory_id: 'n3', player_id: 2, faction: 'red', troops: 5 },
    ],
  });

  const result = await performAttack(client, { playerId: 1, territoryId: 'n3', soldiers: 20 });

  assert.equal(result.outcome.victory, true);
  assert.equal(territories.get('n3').owner_faction, 'blue');
  assert.equal(territories.get('n3').defense_troops, 15);
  assert.deepEqual(client.defenders.get('n3:1'), { faction: 'blue', troops: 15 });
  assert.equal(client.defenders.has('n3:2'), false);
});

test('capital attacks return 403 and do not modify troops, defenders, rewards, or ownership', async () => {
  const { players, territories, neighbors } = buildWorld();
  territories.set('r1', cloneTerritory({ id: 'r1', owner_faction: 'red', defense_troops: 30, is_fortress: false, is_capital: true }));
  const client = createFakeClient({
    players,
    territories,
    neighbors,
    initialDefenders: [
      { territory_id: 'r1', player_id: 2, faction: 'red', troops: 30 },
    ],
  });

  await assert.rejects(
    () => performAttack(client, { playerId: 1, territoryId: 'r1', soldiers: 10 }),
    (error) => error instanceof AttackError
      && error.status === 403
      && error.message === 'Capital territories cannot be attacked or occupied.'
  );

  assert.equal(players.get(1).soldiers, 50);
  assert.equal(territories.get('r1').owner_faction, 'red');
  assert.equal(territories.get('r1').defense_troops, 30);
  assert.deepEqual(client.defenders.get('r1:2'), { faction: 'red', troops: 30 });
  assert.equal(client.battleHistory.length, 0);
  assert.equal(players.get(1).resource_food, 0);
  assert.equal(players.get(1).resource_wood, 0);
  assert.equal(players.get(1).resource_iron, 0);
});

test('rejects invalid troop counts with 400', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors });

  await assert.rejects(
    () => performAttack(client, { playerId: 1, territoryId: 'n1', soldiers: 0 }),
    (error) => error instanceof AttackError && error.status === 400
  );
  await assert.rejects(
    () => performAttack(client, { playerId: 1, territoryId: 'n1', soldiers: -5 }),
    (error) => error instanceof AttackError && error.status === 400
  );
  await assert.rejects(
    () => performAttack(client, { playerId: 1, territoryId: 'n1', soldiers: 'abc' }),
    (error) => error instanceof AttackError && error.status === 400
  );
  await assert.rejects(
    () => performAttack(client, { playerId: 1, territoryId: 'n1', soldiers: 5000 }),
    (error) => error instanceof AttackError && error.status === 400
  );
});

test('rejects attacking your own territory with 403', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors });

  await assert.rejects(
    () => performAttack(client, { playerId: 1, territoryId: 'b1', soldiers: 10 }),
    (error) => error instanceof AttackError && error.status === 403
  );
});

test('rejects attacking a non-adjacent territory with 403', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors });

  await assert.rejects(
    () => performAttack(client, { playerId: 1, territoryId: 'x1', soldiers: 10 }),
    (error) => error instanceof AttackError && error.status === 403
  );
});

test('rejects attacking without a faction chosen with 403', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors });

  await assert.rejects(
    () => performAttack(client, { playerId: 3, territoryId: 'n1', soldiers: 10 }),
    (error) => error instanceof AttackError && error.status === 403
  );
});

test('returns 404 for a missing territory or missing player', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors });

  await assert.rejects(
    () => performAttack(client, { playerId: 1, territoryId: 'does-not-exist', soldiers: 10 }),
    (error) => error instanceof AttackError && error.status === 404
  );
  await assert.rejects(
    () => performAttack(client, { playerId: 999, territoryId: 'n1', soldiers: 10 }),
    (error) => error instanceof AttackError && error.status === 404
  );
});

test('returns 409 when an attack on the same territory is already in progress', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors, lockedTerritoryIds: new Set(['n1']) });

  await assert.rejects(
    () => performAttack(client, { playerId: 1, territoryId: 'n1', soldiers: 10 }),
    (error) => error instanceof AttackError && error.status === 409
  );
});

test('neutral-only attacks cannot resolve instantly if the territory became faction-owned', async () => {
  const { players, territories, neighbors } = buildWorld();
  const client = createFakeClient({ players, territories, neighbors });

  await assert.rejects(
    () => performAttack(client, {
      playerId: 1,
      territoryId: 'n3',
      soldiers: 10,
      neutralOnly: true,
    }),
    (error) => error instanceof AttackError && error.status === 409 && /Start a rally/.test(error.message)
  );
  assert.equal(players.get(1).soldiers, 50);
  assert.equal(territories.get('n3').owner_faction, 'red');
});
