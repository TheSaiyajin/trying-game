const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  RALLY_DURATION_MS,
  getActiveRallies,
  startOrJoinRally,
} = require('../backend/rally-battles');
const { BATTLE_DURATION_MS, BATTLE_ROUND_MS } = require('../backend/battle-rules');

function createRallyClient() {
  const players = new Map([
    [1, { id: 1, faction: 'blue', soldiers: 100 }],
    [2, { id: 2, faction: 'blue', soldiers: 80 }],
    [3, { id: 3, faction: 'green', soldiers: 80 }],
  ]);
  const territory = { id: 'r2', owner_faction: 'red', is_capital: false };
  let rally = null;
  const contributions = new Map();

  return {
    players,
    contributions,
    get rally() { return rally; },
    async query(sql, params = []) {
      const text = sql.trim();
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (text === 'SELECT * FROM players WHERE id = $1 FOR UPDATE') {
        const player = players.get(params[0]);
        return { rows: player ? [player] : [] };
      }
      if (text === 'SELECT * FROM territories WHERE id = $1 FOR UPDATE') return { rows: [territory] };
      if (text.includes('FROM territory_neighbors')) return { rowCount: 1, rows: [{ ok: 1 }] };
      if (text === 'SELECT * FROM attack_targets WHERE territory_id = $1 FOR UPDATE') {
        return { rows: rally ? [rally] : [] };
      }
      if (text.startsWith('INSERT INTO attack_targets')) {
        rally = {
          id: 1,
          faction: params[0],
          territory_id: params[1],
          started_by: params[2],
          defender_faction: params[3],
          season_id: params[4],
          created_at: params[5],
          resolves_at: params[6],
          phase: params[7],
          battle_started_at: params[8],
          next_tick_at: params[9],
        };
        return { rows: [rally] };
      }
      if (text.startsWith('DELETE FROM battle_defender_contributions')) return { rows: [] };
      if (text.startsWith('INSERT INTO battle_defender_contributions')) return { rows: [] };
      if (text.startsWith('SELECT t.*')) return { rows: [territory] };
      if (text.startsWith('UPDATE attack_targets SET attack_bonus')) {
        rally.attack_bonus = params[1];
        rally.defense_bonus = params[2];
        return { rows: [rally] };
      }
      if (text.startsWith('UPDATE players')) {
        players.get(params[1]).soldiers -= params[0];
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO attack_contributions')) {
        const key = `${params[0]}:${params[1]}`;
        contributions.set(key, (contributions.get(key) || 0) + params[2]);
        return { rows: [] };
      }
      if (text.includes('COALESCE(SUM(contribution)')) {
        const total = [...contributions.entries()]
          .filter(([key]) => key.startsWith(`${params[0]}:`))
          .reduce((sum, [, value]) => sum + value, 0);
        return { rows: [{ total_attackers: total }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

test('enemy attack can start a hidden 10-minute rally and reserve troops', async () => {
  const client = createRallyClient();
  const now = new Date('2026-09-02T12:00:00.000Z');

  const result = await startOrJoinRally(client, {
    playerId: 1,
    territoryId: 'r2',
    soldiers: 30,
    seasonId: 7,
    now,
  });

  assert.equal(result.created, true);
  assert.equal(result.rally.totalAttackers, 30);
  assert.equal(result.rally.myContribution, 30);
  assert.equal(result.rally.phase, 'rally');
  assert.equal(new Date(result.rally.resolvesAt).getTime() - now.getTime(), RALLY_DURATION_MS);
  assert.equal(client.players.get(1).soldiers, 70);
});

test('solo attack skips preparation and starts a 20-minute live battle', async () => {
  const client = createRallyClient();
  const now = new Date('2026-09-02T12:00:00.000Z');
  const result = await startOrJoinRally(client, {
    playerId: 1,
    territoryId: 'r2',
    soldiers: 30,
    seasonId: 7,
    mode: 'solo',
    now,
  });
  assert.equal(result.rally.phase, 'active');
  assert.equal(new Date(result.rally.resolvesAt).getTime() - now.getTime(), BATTLE_DURATION_MS);
  assert.equal(new Date(result.rally.nextTickAt).getTime() - now.getTime(), BATTLE_ROUND_MS);
});

test('faction allies join the same rally without extending its deadline', async () => {
  const client = createRallyClient();
  const startedAt = new Date('2026-09-02T12:00:00.000Z');
  const first = await startOrJoinRally(client, {
    playerId: 1, territoryId: 'r2', soldiers: 30, seasonId: 7, now: startedAt,
  });
  const joined = await startOrJoinRally(client, {
    playerId: 2,
    territoryId: 'r2',
    soldiers: 20,
    seasonId: 7,
    now: new Date('2026-09-02T12:04:00.000Z'),
  });

  assert.equal(joined.created, false);
  assert.equal(joined.rally.totalAttackers, 50);
  assert.equal(new Date(joined.rally.resolvesAt).getTime(), new Date(first.rally.resolvesAt).getTime());
  assert.equal(client.players.get(2).soldiers, 60);
});

test('a third faction cannot take over an active rally', async () => {
  const client = createRallyClient();
  const now = new Date('2026-09-02T12:00:00.000Z');
  await startOrJoinRally(client, {
    playerId: 1, territoryId: 'r2', soldiers: 30, seasonId: 7, now,
  });

  await assert.rejects(
    () => startOrJoinRally(client, {
      playerId: 3,
      territoryId: 'r2',
      soldiers: 20,
      seasonId: 7,
      now: new Date('2026-09-02T12:01:00.000Z'),
    }),
    (error) => error.status === 409 && /cannot be attacked/.test(error.message)
  );
  assert.equal(client.players.get(3).soldiers, 80);
});

test('active rally snapshots expose totals and only the requesting player contribution', async () => {
  const fakeClient = {
    async query() {
      return { rows: [{
        territory_id: 'r2',
        faction: 'blue',
        defender_faction: 'red',
        started_by: 1,
        phase: 'active',
        resolves_at: '2026-09-02T12:10:00.000Z',
        next_tick_at: '2026-09-02T11:51:00.000Z',
        round_number: '3',
        total_attackers: '50',
        my_contribution: '20',
      }] };
    },
  };
  const rallies = await getActiveRallies(fakeClient, { seasonId: 7, playerId: 2, playerFaction: 'blue' });
  assert.deepEqual(rallies[0], {
    territoryId: 'r2',
    attackerFaction: 'blue',
    defenderFaction: 'red',
    startedBy: 1,
    phase: 'active',
    resolvesAt: '2026-09-02T12:10:00.000Z',
    nextTickAt: '2026-09-02T11:51:00.000Z',
    roundNumber: 3,
    totalAttackers: 50,
    myContribution: 20,
    attackersLost: 0,
    defendersLost: 0,
    attackBonus: 0,
    defenseBonus: 0,
  });
});

test('existing databases add rally columns before creating indexes that use them', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'backend', 'schema.sql'), 'utf8');
  const migrations = fs.readFileSync(path.join(__dirname, '..', 'backend', 'db.js'), 'utf8');
  assert.doesNotMatch(schema, /INDEX[^\n]+attack_targets[^\n]+resolves_at/i);
  assert.ok(
    migrations.indexOf('ADD COLUMN IF NOT EXISTS resolves_at')
      < migrations.indexOf('idx_attack_targets_due'),
    'resolves_at must be migrated before its index is created'
  );
  assert.ok(
    migrations.indexOf('ADD COLUMN IF NOT EXISTS next_tick_at')
      < migrations.indexOf('idx_attack_targets_tick_due'),
    'next_tick_at must be migrated before its index is created'
  );
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'backend', 'rally-battles.js'), 'utf8'),
    /at\.phase = 'active' OR at\.faction = \$3/);
});
