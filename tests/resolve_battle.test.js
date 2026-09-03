const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBattle } = require('../backend/resolve-battle');

function createResolveClient({
  rally = null,
  territory = { id: 'r2', owner_faction: 'red', defense_troops: 30, is_capital: false },
  contributions = [],
} = {}) {
  const state = {
    rally,
    territory: { ...territory },
    contributions: contributions.map((row) => ({ ...row })),
    garrisons: [],
    history: [],
    stats: [],
    rewardedPlayerId: null,
  };
  return {
    state,
    async query(sql, params = []) {
      const text = sql.trim();
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('SELECT * FROM attack_targets')) return { rows: state.rally ? [state.rally] : [] };
      if (text === 'SELECT * FROM territories WHERE id = $1 FOR UPDATE') return { rows: state.territory ? [state.territory] : [] };
      if (text.startsWith('SELECT player_id, contribution, faction')) return { rows: state.contributions };
      if (text.includes('FROM territory_defenders')) return { rows: [], rowCount: 0 };
      if (text.startsWith('DELETE FROM territory_defenders')) {
        state.garrisons = [];
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO territory_defenders')) {
        state.garrisons.push({ playerId: params[1], faction: params[2], troops: params[3] });
        return { rows: [] };
      }
      if (text.startsWith('UPDATE territories') && text.includes('owner_faction')) {
        state.territory.owner_faction = params[0];
        state.territory.defense_troops = params[1];
        return { rows: [] };
      }
      if (text.startsWith('UPDATE territories SET defense_troops')) {
        state.territory.defense_troops = params[0];
        return { rows: [] };
      }
      if (text.startsWith('UPDATE players') && text.includes('resource_food')) {
        state.rewardedPlayerId = params[0];
        return { rows: [] };
      }
      if (text.startsWith('UPDATE players p')) return { rows: [] };
      if (text.startsWith('INSERT INTO battle_history')) {
        state.history.push(params);
        return { rows: [] };
      }
      if (text.startsWith('SELECT 1 FROM season_territory_faction_ownership')) return { rows: [], rowCount: 0 };
      if (text.startsWith('INSERT INTO season_territory_faction_ownership')) return { rows: [], rowCount: 1 };
      if (text.startsWith('INSERT INTO player_season_stats')) {
        state.stats.push(params);
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('DELETE FROM attack_contributions')) {
        state.contributions = [];
        return { rows: [] };
      }
      if (text.startsWith('DELETE FROM attack_targets')) {
        state.rally = null;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

test('a rally cannot be resolved before its deadline', async () => {
  const client = createResolveClient({
    rally: {
      faction: 'blue', defender_faction: 'red', territory_id: 'r2', started_by: 1,
      season_id: 7, resolves_at: '2026-09-02T12:10:00.000Z',
    },
  });
  const result = await resolveBattle(client, {
    territoryId: 'r2', now: new Date('2026-09-02T12:09:59.000Z'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.ok(client.state.rally);
});

test('an expired rally combines allied contributions and distributes surviving garrisons', async () => {
  const client = createResolveClient({
    rally: {
      faction: 'blue', defender_faction: 'red', territory_id: 'r2', started_by: 1,
      season_id: 7, resolves_at: '2026-09-02T12:10:00.000Z',
    },
    contributions: [
      { player_id: 1, contribution: 30, faction: 'blue' },
      { player_id: 2, contribution: 20, faction: 'blue' },
    ],
  });

  const result = await resolveBattle(client, {
    territoryId: 'r2', now: new Date('2026-09-02T12:10:01.000Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome.victory, true);
  assert.equal(result.outcome.attackersRemaining, 20);
  assert.equal(client.state.territory.owner_faction, 'blue');
  assert.deepEqual(client.state.garrisons, [
    { playerId: 1, faction: 'blue', troops: 12 },
    { playerId: 2, faction: 'blue', troops: 8 },
  ]);
  assert.equal(client.state.rewardedPlayerId, 1);
  assert.equal(client.state.history.length, 1);
  assert.equal(client.state.stats.length, 2);
  assert.equal(client.state.rally, null);
  assert.equal(client.state.contributions.length, 0);
});

test('a capital rally is cancelled and can never capture the capital', async () => {
  const client = createResolveClient({
    rally: {
      faction: 'blue', defender_faction: 'red', territory_id: 'r1', started_by: 1,
      season_id: 7, resolves_at: '2026-09-02T12:10:00.000Z',
    },
    territory: { id: 'r1', owner_faction: 'red', defense_troops: 30, is_capital: true },
    contributions: [{ player_id: 1, contribution: 20, faction: 'blue' }],
  });
  const result = await resolveBattle(client, {
    territoryId: 'r1', now: new Date('2026-09-02T12:10:01.000Z'),
  });
  assert.equal(result.cancelled, true);
  assert.equal(client.state.territory.owner_faction, 'red');
  assert.equal(client.state.history.length, 0);
  assert.equal(client.state.rally, null);
});
