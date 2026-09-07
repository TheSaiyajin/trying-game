const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateSupplyAttritionLoss,
  computeSuppliedTerritoryIds,
  processTerritorySupply,
} = require('../backend/supply-lines');

function territory(id, owner, neighbors = [], capital = false) {
  return { id, owner_faction: owner, neighbors, is_capital: capital };
}

test('owned chains from a capital are supplied and enemy cuts disconnect beyond them', () => {
  const connected = [
    territory('A', 'green', ['B'], true),
    territory('B', 'green', ['A', 'C']),
    territory('C', 'green', ['B']),
  ];
  assert.deepEqual([...computeSuppliedTerritoryIds(connected)], ['A', 'B', 'C']);

  connected[1].owner_faction = 'red';
  assert.deepEqual([...computeSuppliedTerritoryIds(connected)], ['A']);
  connected[1].owner_faction = 'green';
  assert.equal(computeSuppliedTerritoryIds(connected).has('C'), true);
});

test('attrition is five percent rounded up with a minimum loss of one', () => {
  assert.equal(calculateSupplyAttritionLoss(100), 5);
  assert.equal(calculateSupplyAttritionLoss(101), 6);
  assert.equal(calculateSupplyAttritionLoss(1), 1);
  assert.equal(calculateSupplyAttritionLoss(0), 0);
});

function createAttritionClient(defenders) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM territory_defenders') && sql.includes('FOR UPDATE')) return { rows: defenders };
      return { rows: [] };
    },
  };
}

test('first ten minutes cause no loss and the first due tick only removes stationed defenders', async () => {
  const cutSince = new Date('2026-01-01T00:00:00Z');
  const client = createAttritionClient([
    { territory_id: 'C', player_id: 1, faction: 'green', troops: 80 },
    { territory_id: 'C', player_id: 2, faction: 'green', troops: 20 },
  ]);
  const disconnected = {
    ...territory('C', 'green'),
    supply_cut_since: cutSince,
    last_supply_attrition_at: null,
  };

  const early = await processTerritorySupply(client, disconnected, {
    supplied: false,
    activeBattle: false,
    now: new Date('2026-01-01T00:09:59Z'),
  });
  assert.equal(early.troopsLost, 0);
  assert.equal(client.calls.length, 0);

  const due = await processTerritorySupply(client, disconnected, {
    supplied: false,
    activeBattle: false,
    now: new Date('2026-01-01T00:10:00Z'),
  });
  assert.equal(due.troopsLost, 5);
  assert.deepEqual(
    client.calls.filter((call) => call.sql.startsWith('UPDATE territory_defenders')).map((call) => call.params[0]),
    [4, 1]
  );
  assert.equal(client.calls.some((call) => call.sql.includes('UPDATE players')), false);
});

test('capital and active battle territories never lose stationed troops', async () => {
  const client = createAttritionClient([{ territory_id: 'A', player_id: 1, faction: 'blue', troops: 100 }]);
  const dueTerritory = {
    ...territory('A', 'blue', [], true),
    supply_cut_since: new Date('2026-01-01T00:00:00Z'),
    last_supply_attrition_at: null,
  };
  assert.equal((await processTerritorySupply(client, dueTerritory, {
    supplied: false,
    activeBattle: false,
    now: new Date('2026-01-01T00:20:00Z'),
  })).troopsLost, 0);

  dueTerritory.is_capital = false;
  assert.equal((await processTerritorySupply(client, dueTerritory, {
    supplied: false,
    activeBattle: true,
    now: new Date('2026-01-01T00:20:00Z'),
  })).troopsLost, 0);
  assert.equal(client.calls.some((call) => call.sql.includes('FROM territory_defenders')), false);
});

test('reconnection clears cut timestamps and an applied tick cannot repeat before its next due time', async () => {
  const client = createAttritionClient([{ territory_id: 'C', player_id: 1, faction: 'green', troops: 20 }]);
  const disconnected = {
    ...territory('C', 'green'),
    supply_cut_since: new Date('2026-01-01T00:00:00Z'),
    last_supply_attrition_at: new Date('2026-01-01T00:10:00Z'),
  };
  const repeated = await processTerritorySupply(client, disconnected, {
    supplied: false,
    activeBattle: false,
    now: new Date('2026-01-01T00:10:00Z'),
  });
  assert.equal(repeated.troopsLost, 0);
  assert.equal(client.calls.length, 0);

  const restored = await processTerritorySupply(client, disconnected, {
    supplied: true,
    activeBattle: false,
    now: new Date('2026-01-01T00:10:00Z'),
  });
  assert.equal(restored.changed, true);
  assert.equal(client.calls[0].sql.includes('supply_cut_since = NULL'), true);
});