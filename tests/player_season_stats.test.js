const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  STAT_COLUMNS,
  addPlayerSeasonStats,
  buildBattleStatDeltas,
  getSeasonStats,
  recordBattleStats,
} = require('../backend/player-season-stats');

function createStatsClient() {
  const stats = new Map();
  const ownership = new Set();
  return {
    stats,
    ownership,
    async query(sql, params = []) {
      const text = String(sql).trim().replace(/\s+/g, ' ');
      if (text.startsWith('SELECT 1 FROM season_territory_faction_ownership')) {
        const key = params.join(':');
        return { rows: ownership.has(key) ? [{ exists: 1 }] : [], rowCount: ownership.has(key) ? 1 : 0 };
      }
      if (text.startsWith('INSERT INTO season_territory_faction_ownership')) {
        ownership.add(params.join(':'));
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO player_season_stats')) {
        const key = `${params[0]}:${params[1]}`;
        const current = stats.get(key) || Object.fromEntries(STAT_COLUMNS.map((column) => [column, 0]));
        STAT_COLUMNS.forEach((column, index) => { current[column] += params[index + 2]; });
        stats.set(key, current);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected stats query: ${text}`);
    },
  };
}

test('battle stats attribute attacker and proportional player-garrison casualties', () => {
  const deltas = buildBattleStatDeltas({
    attackerPlayerId: 1,
    defenderFaction: 'red',
    lockedDefenders: [
      { player_id: 2, faction: 'red', troops: 6 },
      { player_id: 3, faction: 'red', troops: 4 },
    ],
    allocation: {
      survivors: [
        { player_id: 2, faction: 'red', troops: 3 },
        { player_id: 3, faction: 'red', troops: 2 },
      ],
    },
    outcome: {
      victory: false,
      attackersLost: 10,
      defendersLost: 5,
      defendersRemaining: 15,
    },
  });

  assert.deepEqual(deltas.get(1), {
    kills: 5,
    losses: 10,
    battles_joined: 1,
    battles_won: 0,
    territories_captured: 0,
  });
  assert.deepEqual(deltas.get(2), {
    kills: 3,
    losses: 3,
    battles_joined: 1,
    battles_won: 1,
    successful_defences: 1,
  });
  assert.deepEqual(deltas.get(3), {
    kills: 2,
    losses: 2,
    battles_joined: 1,
    battles_won: 1,
    successful_defences: 1,
  });
});

test('neutral base defenders receive no player kill credit', () => {
  const deltas = buildBattleStatDeltas({
    attackerPlayerId: 1,
    defenderFaction: 'red',
    lockedDefenders: [{ player_id: 2, faction: 'red', troops: 5 }],
    allocation: { survivors: [{ player_id: 2, faction: 'red', troops: 5 }] },
    outcome: { victory: false, attackersLost: 10, defendersLost: 0, defendersRemaining: 20 },
  });

  assert.equal(deltas.get(2).kills, 2);
});

test('a capture is a retake only when that faction owned the territory earlier in the same season', async () => {
  const client = createStatsClient();
  client.ownership.add('7:n1:blue');
  const battle = {
    territoryId: 'n1',
    attackerPlayerId: 1,
    attackerFaction: 'blue',
    defenderFaction: 'red',
    lockedDefenders: [],
    allocation: { survivors: [] },
    outcome: { victory: true, attackersLost: 2, defendersLost: 5, defendersRemaining: 0 },
  };

  const sameSeason = await recordBattleStats(client, { ...battle, seasonId: 7 });
  const newSeason = await recordBattleStats(client, { ...battle, seasonId: 8 });

  assert.equal(sameSeason.retake, true);
  assert.equal(newSeason.retake, false);
  assert.equal(client.stats.get('7:1').retakes, 1);
  assert.equal(client.stats.get('8:1').retakes, 0);
});

test('season rows remain separate and repeated updates use one row without duplicate counting', async () => {
  const client = createStatsClient();
  await addPlayerSeasonStats(client, 1, 9, { kills: 2 });
  await addPlayerSeasonStats(client, 1, 9, { kills: 3 });
  await addPlayerSeasonStats(client, 2, 9, { kills: 4 });

  assert.equal(client.stats.size, 2);
  assert.equal(client.stats.get('1:9').kills, 5);
  assert.equal(client.stats.get('2:9').kills, 4);
});

test('reinforcement troops are added to the current season inside the defence transaction', async () => {
  const client = createStatsClient();
  await addPlayerSeasonStats(client, 5, 9, { reinforcement_troops_sent: 23 });
  assert.equal(client.stats.get('5:9').reinforcement_troops_sent, 23);

  const serverSource = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const defendRoute = serverSource.match(/app\.post\('\/api\/game\/defend'[\s\S]*?app\.post\('\/api\/game\/recall-defenders'/)?.[0] || '';
  assert.ok(defendRoute.indexOf("client.query('BEGIN')") < defendRoute.indexOf('addPlayerSeasonStats'));
  assert.ok(defendRoute.indexOf('addPlayerSeasonStats') < defendRoute.indexOf("client.query('COMMIT')"));
});

test('rankings expose only username, faction and statistic counters', async () => {
  const privateRow = {
    player_id: 4,
    username: 'Vega',
    faction: 'green',
    password_hash: 'secret',
    resource_food: 999,
    soldiers: 100,
    ...Object.fromEntries(STAT_COLUMNS.map((column, index) => [column, index + 1])),
  };
  const client = { async query() { return { rows: [privateRow] }; } };

  const result = await getSeasonStats(client, { seasonId: 3, playerId: 4 });
  const publicKeys = ['username', 'faction', ...STAT_COLUMNS].sort();

  assert.deepEqual(Object.keys(result.rankings.kills[0]).sort(), publicKeys);
  assert.deepEqual(Object.keys(result.myStats).sort(), publicKeys);
  assert.equal('password_hash' in result.rankings.kills[0], false);
  assert.equal('resource_food' in result.myStats, false);
});

test('Activity uses internal tabs and socket refresh without adding bottom navigation', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');

  assert.match(html, /id="activity-tab-feed"/);
  assert.match(html, /id="activity-tab-rankings"/);
  assert.match(html, /id="activity-tab-my-stats"/);
  assert.equal((html.match(/id="nav-activity"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="nav-(rankings|my-stats)"/);
  assert.match(script, /screen-activity'[\s\S]*?renderActivity\(\)/);
});