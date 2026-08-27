const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBattle } = require('../backend/resolve-battle');

function createResolveBattleClient({ initialTerritory, lockedTerritory = initialTerritory }) {
  const calls = [];
  const territory = { ...initialTerritory };
  return {
    calls,
    territory,
    async query(sql, params = []) {
      const text = sql.trim();
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text === 'SELECT * FROM territories WHERE id = $1') return { rows: [territory] };
      if (text === 'SELECT * FROM territories WHERE id = $1 FOR UPDATE') return { rows: [{ ...lockedTerritory }] };
      if (text.includes('FROM attack_contributions')) return { rows: [{ total: 10 }] };
      if (text.includes('FROM territory_defenders')) return { rows: [], rowCount: 0 };
      if (text.startsWith('DELETE FROM territory_defenders')) return { rows: [] };
      if (text.startsWith('UPDATE territories SET')) return { rows: [] };
      if (text.startsWith('UPDATE players SET resource_food = resource_food + 25')) return { rows: [] };
      if (text.startsWith('INSERT INTO battle_history')) return { rows: [] };
      if (text.startsWith('DELETE FROM attack_contributions')) return { rows: [] };
      if (text.startsWith('INSERT INTO admin_actions')) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

test('older battle resolution cannot capture capitals', async () => {
  const client = createResolveBattleClient({
    initialTerritory: { id: 'r1', owner_faction: 'red', defense_troops: 30, is_fortress: false, is_capital: true },
  });

  const result = await resolveBattle(client, {
    player: { id: 1, faction: 'blue' },
    territoryId: 'r1',
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: 'Capital territories cannot be attacked or occupied.',
  });
  assert.equal(client.calls.includes('BEGIN'), false);
});

test('battle resolution also re-checks capital protection after locking', async () => {
  const client = createResolveBattleClient({
    initialTerritory: { id: 'n1', owner_faction: 'red', defense_troops: 30, is_fortress: false, is_capital: false },
    lockedTerritory: { id: 'n1', owner_faction: 'red', defense_troops: 30, is_fortress: false, is_capital: true },
  });

  const result = await resolveBattle(client, {
    player: { id: 1, faction: 'blue' },
    territoryId: 'n1',
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: 'Capital territories cannot be attacked or occupied.',
  });
  assert.equal(client.calls.includes('ROLLBACK'), true);
  assert.equal(client.calls.some((call) => call.startsWith('INSERT INTO battle_history')), false);
});
