const test = require('node:test');
const assert = require('node:assert/strict');
const { STARTING_PLAYER_RESOURCES } = require('../backend/admin-resets');
const { applyOfflineResourceEarnings, runGlobalResourceTick } = require('../backend/server');

function createResourceClient(playerRows, territories = []) {
  const players = new Map(playerRows.map((player) => [player.id, { ...player }]));
  const stats = { buildingQueries: 0 };

  return {
    players,
    stats,
    async query(sql, params = []) {
      const text = String(sql).trim().replace(/\s+/g, ' ');

      if (text === 'SELECT * FROM players WHERE id = $1') {
        const player = players.get(params[0]);
        return { rows: player ? [{ ...player }] : [], rowCount: player ? 1 : 0 };
      }
      if (text.startsWith('SELECT id, faction, resource_food')) {
        return { rows: [...players.values()].map((player) => ({ ...player })), rowCount: players.size };
      }
      if (text === 'SELECT * FROM buildings WHERE player_id = $1') {
        stats.buildingQueries += 1;
        return { rows: [{ farm: 1, lumbermill: 1, ironmine: 1, barracks: 1 }], rowCount: 1 };
      }
      if (text.startsWith('SELECT t.*,')) {
        return { rows: territories, rowCount: territories.length };
      }
      if (text.startsWith('UPDATE players SET resource_food = resource_food + $1')) {
        const playerId = params.at(-1);
        const player = players.get(playerId);
        player.resource_food += params[0];
        player.resource_wood += params[1];
        player.resource_iron += params[2];
        player.resource_manpower += params[3];
        player.soldiers += params[4];
        player.resource_last_updated = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('UPDATE players SET resource_food = $1')) {
        const player = players.get(params[5]);
        player.resource_food = params[0];
        player.resource_wood = params[1];
        player.resource_iron = params[2];
        player.resource_manpower = params[3];
        player.soldiers = params[4];
        player.resource_last_updated = new Date();
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected resource query: ${text}`);
    },
  };
}

function defaultPlayer(overrides = {}) {
  return {
    id: 1,
    faction: null,
    resource_food: STARTING_PLAYER_RESOURCES.food,
    resource_wood: STARTING_PLAYER_RESOURCES.wood,
    resource_iron: STARTING_PLAYER_RESOURCES.iron,
    resource_manpower: STARTING_PLAYER_RESOURCES.manpower,
    soldiers: STARTING_PLAYER_RESOURCES.soldiers,
    resource_last_updated: new Date(Date.now() - 60 * 60 * 1000),
    ...overrides,
  };
}

test('resource ticks skip factionless players while valid factions continue earning', async () => {
  const client = createResourceClient([
    defaultPlayer({ id: 1, faction: null }),
    defaultPlayer({ id: 2, faction: 'blue' }),
  ]);

  await runGlobalResourceTick(client, { suppressErrors: false });

  assert.equal(client.players.get(1).resource_food, STARTING_PLAYER_RESOURCES.food);
  assert.ok(client.players.get(2).resource_food > STARTING_PLAYER_RESOURCES.food);
  assert.equal(client.stats.buildingQueries, 1);
});

test('factionless players receive no offline earnings', async () => {
  const client = createResourceClient([defaultPlayer()]);

  const result = await applyOfflineResourceEarnings(1, client);

  assert.equal(result.resource_food, STARTING_PLAYER_RESOURCES.food);
  assert.equal(result.soldiers, STARTING_PLAYER_RESOURCES.soldiers);
  assert.equal(client.stats.buildingQueries, 0);
});

test('valid-faction players continue receiving offline earnings', async () => {
  const client = createResourceClient([defaultPlayer({ faction: 'green' })]);

  const result = await applyOfflineResourceEarnings(1, client);

  assert.ok(result.resource_food > STARTING_PLAYER_RESOURCES.food);
  assert.equal(client.stats.buildingQueries, 1);
});

test('global fortress gain ignores stationed defenders and fills the city reserve cap', async () => {
  const client = createResourceClient([
    defaultPlayer({ faction: 'blue', soldiers: 248, stationed_defenders: 500 }),
  ], [
    { id: 'f1', owner_faction: 'blue', is_fortress: true },
    { id: 'f2', owner_faction: 'blue', is_fortress: true },
  ]);

  await runGlobalResourceTick(client, { suppressErrors: false });

  assert.equal(client.players.get(1).soldiers, 250);
});

test('offline fortress gain ignores stationed defenders and fills only the city reserve', async () => {
  const client = createResourceClient([
    defaultPlayer({ faction: 'blue', soldiers: 245, stationed_defenders: 500 }),
  ], [
    { id: 'f1', owner_faction: 'blue', is_fortress: true },
  ]);

  const result = await applyOfflineResourceEarnings(1, client);

  assert.equal(result.soldiers, 250);
  assert.equal(client.players.get(1).soldiers, 250);
});

test('invalid-faction players are normalized back to shared resource defaults', async () => {
  const client = createResourceClient([defaultPlayer({
    faction: 'yellow',
    resource_food: 9999,
    resource_wood: 1,
    resource_iron: 2,
    resource_manpower: 3,
    soldiers: 4,
  })]);

  await runGlobalResourceTick(client, { suppressErrors: false });

  const player = client.players.get(1);
  assert.deepEqual({
    food: player.resource_food,
    wood: player.resource_wood,
    iron: player.resource_iron,
    manpower: player.resource_manpower,
    soldiers: player.soldiers,
  }, STARTING_PLAYER_RESOURCES);
  assert.equal(client.stats.buildingQueries, 0);
});