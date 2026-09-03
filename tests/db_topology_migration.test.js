const test = require('node:test');
const assert = require('node:assert/strict');
const topology = require('../world-topology');
const { applyTopologyMigrationIfNeeded } = require('../backend/db');

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
