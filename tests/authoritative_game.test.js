const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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
  assert.equal(attack.attackersRemaining, 30);
  assert.equal(attack.defendersLost, 90);
});

test('attacking with fewer troops removes the same number of defenders and fails', () => {
  const attack = calculateBattleOutcome({ attackers: 40 }, { defenders: 70 });
  assert.equal(attack.victory, false);
  assert.equal(attack.attackersRemaining, 0);
  assert.equal(attack.attackersLost, 40);
  assert.equal(attack.defendersLost, 40);
  assert.equal(attack.defendersRemaining, 30);
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
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE territories ADD COLUMN IF NOT EXISTS last_battle_at TIMESTAMPTZ')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS updated_at')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS faction')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE players ADD COLUMN IF NOT EXISTS faction VARCHAR(16) NULL')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE buildings ADD COLUMN IF NOT EXISTS farm')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE territories ADD COLUMN IF NOT EXISTS owner_faction')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS contribution')));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS territory_defenders_territory_player_idx')));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS attack_contributions_territory_player_idx')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE faction_leaders ALTER COLUMN player_id DROP NOT NULL')));
  assert.ok(sqlCalls.some((sql) => sql.includes('UPDATE territories t') && sql.includes('GREATEST(t.defense_troops')));
  assert.ok(sqlCalls.some((sql) => sql.includes("UPDATE players SET role = 'admin' WHERE username = $1")));
  assert.ok(sqlCalls.some((sql) => sql.includes("UPDATE players SET role = 'member' WHERE username <> $1 AND role = 'admin'")));
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

test('world seed has 30 neutral territories and one capital per faction', () => {
  const seedPath = path.join(__dirname, '../backend/world-seed.sql');
  const sql = fs.readFileSync(seedPath, 'utf8');

  const neutralTerritories = (sql.match(/'n\d+'\s*,\s*'[^']+'\s*,\s*'neutral'/g) || []).length;
  const blueCapitals = (sql.match(/'b1'\s*,\s*'[^']+'\s*,\s*'blue'/g) || []).length;
  const redCapitals = (sql.match(/'r1'\s*,\s*'[^']+'\s*,\s*'red'/g) || []).length;
  const greenCapitals = (sql.match(/'g1'\s*,\s*'[^']+'\s*,\s*'green'/g) || []).length;

  assert.equal(neutralTerritories, 30);
  assert.equal(blueCapitals, 1);
  assert.equal(redCapitals, 1);
  assert.equal(greenCapitals, 1);
});
