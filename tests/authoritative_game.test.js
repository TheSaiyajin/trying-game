const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getUpgradeCost,
  getProductionFromBuildings,
  calculateBattleOutcome,
} = require('../backend/game-logic');

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
