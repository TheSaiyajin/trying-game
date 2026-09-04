const test = require('node:test');
const assert = require('node:assert/strict');
const topology = require('../world-topology');
const crownlands = require('../crownlands-topology');
const { applyActiveMapTerritoryBonusMetadata, applyTopologyMigrationIfNeeded } = require('../backend/db');

function createFakeClient({ initialVersion = 0, initialMapKey = 'three-frontiers', activeMapKey = 'three-frontiers', territoryCount = 33 } = {}) {
  const calls = [];
  let version = initialVersion;
  let mapKey = initialMapKey;

  return {
    calls,
    getVersion: () => version,
    getMapKey: () => mapKey,
    async query(sql, params = []) {
      const text = sql.trim().replace(/\s+/g, ' ');
      calls.push(text);

      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.startsWith("SELECT map_key FROM seasons WHERE status = 'active'")) {
        return { rows: [{ map_key: activeMapKey }], rowCount: 1 };
      }
      if (text === 'SELECT version, map_key FROM topology_version WHERE id = 1 FOR UPDATE') {
        return { rows: [{ version, map_key: mapKey }], rowCount: 1 };
      }
      if (text === 'SELECT COUNT(*) AS cnt FROM territories') {
        return { rows: [{ cnt: String(territoryCount) }] };
      }
      if (text === 'DELETE FROM territory_neighbors') {
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO territory_neighbors')) {
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO topology_version')) {
        version = Number(params[0]);
        mapKey = params[1];
        return { rows: [] };
      }

      throw new Error(`Unexpected query in topology migration test client: ${text}`);
    },
  };
}

test('legacy-topology migration only touches territory_neighbors and topology_version', async () => {
  const client = createFakeClient({ initialVersion: 0 });

  const result = await applyTopologyMigrationIfNeeded(client);

  assert.equal(result.migrated, true);
  assert.equal(result.currentVersion, topology.TOPOLOGY_VERSION);
  assert.equal(result.mapKey, 'three-frontiers');
  assert.ok(client.calls.some((sql) => sql === 'DELETE FROM territory_neighbors'));
  assert.ok(client.calls.some((sql) => sql.startsWith('INSERT INTO territory_neighbors')));
  assert.ok(client.calls.some((sql) => sql.startsWith('INSERT INTO topology_version')));

  // Never touches players, buildings, chat, factions, ownership, defenders, bonuses, or
  // battle history — only the territory_neighbors table (and the version bookkeeping row).
  const forbiddenPatterns = [
    /players/i,
    /buildings/i,
    /faction_chat/i,
    /territory_defenders/i,
    /battle_history/i,
    /UPDATE territories/i,
    /DELETE FROM territories\b/i,
  ];
  for (const sql of client.calls) {
    for (const pattern of forbiddenPatterns) {
      assert.ok(!pattern.test(sql), `migration query touched forbidden table: ${sql}`);
    }
  }
});

test('legacy-topology migration is idempotent: running it twice does not duplicate edges or rerun', async () => {
  const client = createFakeClient({ initialVersion: 0 });

  const first = await applyTopologyMigrationIfNeeded(client);
  const callsAfterFirst = client.calls.length;
  const second = await applyTopologyMigrationIfNeeded(client);

  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.equal(second.currentVersion, topology.TOPOLOGY_VERSION);
  // The second run should only issue the active-map/version checks
  // COMMIT) -- no additional DELETE/INSERT into territory_neighbors.
  const callsAfterSecond = client.calls.slice(callsAfterFirst);
  assert.ok(!callsAfterSecond.some((sql) => sql === 'DELETE FROM territory_neighbors'));
  assert.ok(!callsAfterSecond.some((sql) => sql.startsWith('INSERT INTO territory_neighbors')));
});

test('legacy-topology migration is a no-op on a fresh, empty database (seedWorldIfEmpty owns that path)', async () => {
  const client = createFakeClient({ initialVersion: 0, territoryCount: 0 });

  const result = await applyTopologyMigrationIfNeeded(client);

  assert.equal(result.migrated, false);
  assert.ok(!client.calls.some((sql) => sql === 'DELETE FROM territory_neighbors'));
});

test('legacy-topology migration rolls back and rethrows on failure', async () => {
  const client = createFakeClient({ initialVersion: 0 });
  const originalQuery = client.query.bind(client);
  client.query = async (sql, params) => {
    const text = sql.trim().replace(/\s+/g, ' ');
    if (text.startsWith('INSERT INTO territory_neighbors')) {
      throw new Error('simulated failure');
    }
    return originalQuery(sql, params);
  };

  await assert.rejects(() => applyTopologyMigrationIfNeeded(client), /simulated failure/);
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.equal(client.getVersion(), 0);
});

test('active-map bonus metadata migration is idempotent and preserves game state', async () => {
  const territories = new Map(crownlands.buildTerritories().map((territory) => [territory.id, {
    id: territory.id,
    name: territory.id,
    bonus_type: 'none',
    bonus_value: 0,
    resource_bonus: 0,
    storage_bonus: 0,
    is_fortress: false,
    owner_faction: 'red',
    defense_troops: 777,
    score_value: territory.scoreValue,
    map_x: 123,
    map_y: 456,
  }]));
  const calls = [];
  const client = {
    async query(sql, params) {
      const text = sql.trim().replace(/\s+/g, ' ');
      calls.push(text);
      assert.match(text, /^UPDATE territories SET name = \$1, bonus_type = \$2, bonus_value = \$3,/);
      assert.doesNotMatch(text, /owner_faction|defense_troops|score_value|map_x|map_y/);
      const row = territories.get(params[6]);
      const keys = ['name', 'bonus_type', 'bonus_value', 'resource_bonus', 'storage_bonus', 'is_fortress'];
      const changed = keys.some((key, index) => row[key] !== params[index]);
      keys.forEach((key, index) => { row[key] = params[index]; });
      return { rowCount: changed ? 1 : 0, rows: [] };
    },
  };

  assert.equal(await applyActiveMapTerritoryBonusMetadata(client, crownlands), 64);
  assert.equal(await applyActiveMapTerritoryBonusMetadata(client, crownlands), 0);
  const scout = territories.get('b19');
  assert.deepEqual({
    name: scout.name,
    bonusType: scout.bonus_type,
    bonusValue: scout.bonus_value,
    owner: scout.owner_faction,
    defenders: scout.defense_troops,
    score: scout.score_value,
    x: scout.map_x,
    y: scout.map_y,
  }, {
    name: 'Blue Scout Post',
    bonusType: 'attack',
    bonusValue: 0.02,
    owner: 'red',
    defenders: 777,
    score: 1,
    x: 123,
    y: 456,
  });
  assert.equal(calls.length, 128);
});
