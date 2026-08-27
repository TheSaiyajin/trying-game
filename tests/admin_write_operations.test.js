const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTerritoryUpdate, updateAdminTerritory } = require('../backend/admin-write-operations');

test('admin cannot change the owner of a capital territory', () => {
  const result = parseTerritoryUpdate(
    { id: 'b1', owner_faction: 'blue', is_capital: true, defense_troops: 35 },
    { owner: 'red' },
    ['blue', 'red', 'green']
  );

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: 'Capital ownership cannot be changed.',
  });
});

test('admin can still change a capital defense amount without changing its owner', async () => {
  const territories = new Map([
    ['b1', { id: 'b1', owner_faction: 'blue', is_capital: true, defense_troops: 35 }],
  ]);
  const adminActions = [];
  const fakeClient = {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT * FROM territories WHERE id = $1')) {
        const territory = territories.get(params[0]);
        return { rows: territory ? [territory] : [] };
      }
      if (sql.startsWith('UPDATE territories SET')) {
        const territory = territories.get(params[params.length - 1]);
        if (typeof params[0] === 'string') territory.owner_faction = params[0];
        territory.defense_troops = params[params.length - 2];
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO admin_actions')) {
        adminActions.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await updateAdminTerritory(fakeClient, {
    territoryId: 'b1',
    body: { owner: 'blue', defense: 42 },
    validFactions: ['blue', 'red', 'green'],
    actorId: 99,
  });

  assert.equal(result.ok, true);
  assert.equal(territories.get('b1').owner_faction, 'blue');
  assert.equal(territories.get('b1').defense_troops, 42);
  assert.equal(adminActions.length, 1);
});
