const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getUpgradeCost,
  getProductionFromBuildings,
  getTrainingCost,
  getOfflineResourceGain,
  calculateBattleOutcome,
} = require('../backend/game-logic');
const { applySchemaMigrations } = require('../backend/db');

test('upgrade cost grows with level using backend rules', () => {
  assert.deepEqual(getUpgradeCost('farm', 1), { food: 50, wood: 80, iron: 0 });
  assert.deepEqual(getUpgradeCost('farm', 2), { food: 100, wood: 160, iron: 0 });
});

test('production uses faction-controlled territory bonuses from the backend', () => {
  const buildings = { farm: 2, lumbermill: 3, ironmine: 1, barracks: 2 };
  const territories = [
    { owner_faction: 'blue', bonus_type: 'food', bonus_value: 0.10 },
    { owner_faction: 'blue', bonus_type: 'wood', bonus_value: 0.10 },
    { owner_faction: 'blue', bonus_type: 'iron', bonus_value: 0.10 },
    { owner_faction: 'blue', bonus_type: 'manpower', bonus_value: 0.10 },
  ];

  const result = getProductionFromBuildings(buildings, territories);
  assert.equal(result.food, 10);
  assert.equal(result.wood, 12);
  assert.equal(result.iron, 3);
  assert.equal(result.manpower, 4);
});

test('battle outcome is resolved server-side using backend calculations', () => {
  const attack = calculateBattleOutcome({ attackers: 120, fortBonus: 1.0 }, { defenders: 90, fortBonus: 1.0 });
  assert.equal(attack.victory, true);
  assert.ok(attack.attackersRemaining >= 1);
  assert.ok(attack.defendersLost >= 1);
});

test('legacy databases get the required player migration columns before registration runs', async () => {
  const sqlCalls = [];
  const fakeClient = {
    async query(sql) {
      sqlCalls.push(String(sql));
      if (sql.includes('information_schema.columns')) {
        return {
          rows: [
            { table_name: 'players', column_name: 'id' },
            { table_name: 'players', column_name: 'username' },
            { table_name: 'players', column_name: 'password_hash' },
            { table_name: 'players', column_name: 'faction' },
          ],
        };
      }
      return { rows: [] };
    },
  };

  await applySchemaMigrations(fakeClient);

  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE players ADD COLUMN IF NOT EXISTS faction_locked')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE players ADD COLUMN IF NOT EXISTS role')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE players ADD COLUMN IF NOT EXISTS army_name')));
});

test('training cost and idle earnings are consistent with server-authoritative rules', () => {
  const trainingCost = getTrainingCost(5, 1);
  assert.equal(trainingCost.food, 250);
  assert.equal(trainingCost.iron, 100);
  assert.equal(trainingCost.manpower, 5);

  const offlineGain = getOfflineResourceGain({ food: 8, wood: 6, iron: 4, manpower: 2 }, 300, 60 * 60 * 12);
  assert.equal(offlineGain.food, 40);
  assert.equal(offlineGain.wood, 30);
  assert.equal(offlineGain.iron, 20);
  assert.equal(offlineGain.manpower, 10);
});
