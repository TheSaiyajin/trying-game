const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  getUpgradeCost,
  getProductionFromBuildings,
  getFactionStorageCaps,
  getStorageCapacity,
  limitResourceGain,
  limitPassiveFortressTroopGain,
  getFactionTerritoryBonuses,
  getTrainingCost,
  getOfflineResourceGain,
  calculateBattleOutcome,
} = require('../backend/game-logic');
const { applySchemaMigrations } = require('../backend/db');

test('admin route parser accepts positive digit-string IDs', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const match = serverSource.match(/function parsePositiveInt\(value, fallback = 0, maxValue = 1000000\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'parsePositiveInt should be present');
  const parsePositiveInt = new Function(`return function parsePositiveInt(value, fallback = 0, maxValue = 1000000) {${match[1]}\n};`)();

  assert.equal(parsePositiveInt('2', 0, 100000), 2);
});

test('upgrade cost preserves level 2 and scales exponentially after it', () => {
  assert.deepEqual(getUpgradeCost('farm', 1), { food: 50, wood: 80, iron: 0 });
  assert.deepEqual(getUpgradeCost('farm', 2), { food: 100, wood: 160, iron: 0 });
  assert.deepEqual(getUpgradeCost('farm', 3), { food: 210, wood: 336, iron: 0 });
  assert.deepEqual(getUpgradeCost('storage', 5), { food: 1372, wood: 2196, iron: 1647 });
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

  assert.deepEqual(
    getProductionFromBuildings({ farm: 11, lumbermill: 11, ironmine: 11, barracks: 11 }),
    { food: 50, wood: 40, iron: 30, manpower: 20 }
  );
});

test('storage levels and territory bonuses determine fully upgraded capacity', () => {
  assert.equal(getStorageCapacity(1), 10000);
  assert.equal(getStorageCapacity(2), 15000);
  assert.equal(getStorageCapacity(5), 30000);
  assert.equal(getStorageCapacity(10), 55000);
  assert.equal(getStorageCapacity(2, 0.30), 19500);
  assert.deepEqual(getFactionStorageCaps(
    [{ owner_faction: 'blue', bonus_type: 'storage', bonus_value: 0.30, storage_bonus: 0.30 }],
    'blue',
    { storage: 2 }
  ), { food: 19500, wood: 19500, iron: 19500, manpower: 19500 });
});

test('storage bonuses cap new gains without removing resources earned above a lost buff cap', () => {
  const buffedTerritories = [{ owner_faction: 'blue', bonus_type: 'storage', bonus_value: 0.20 }];
  assert.deepEqual(getFactionStorageCaps(buffedTerritories, 'blue'), {
    food: 12000, wood: 12000, iron: 12000, manpower: 12000,
  });
  assert.deepEqual(limitResourceGain(
    { food: 11500, wood: 9999, iron: 12000, manpower: 10000 },
    { food: 100, wood: 100, iron: 100, manpower: 100 },
    getFactionStorageCaps([], 'blue')
  ), { food: 0, wood: 1, iron: 0, manpower: 0 });
});

test('only Storage territories add capacity while fortress and resource effects remain active', () => {
  const territories = [
    { owner_faction: 'blue', bonus_type: 'storage', bonus_value: 0.20, storage_bonus: 0.15 },
    { owner: 'blue', bonus: 'storage', bonusValue: 0.10 },
    { owner: 'blue', bonus: 'resource', bonusValue: 0.05, fortress: true },
  ];
  const bonuses = getFactionTerritoryBonuses(territories, 'blue');

  assert.equal(bonuses.storage, 0.25);
  assert.equal(bonuses.fortressTroops, 1);
  assert.equal(bonuses.allResources, 0.05);
  assert.equal(bonuses.food, 0.05);
  assert.deepEqual(getFactionStorageCaps(territories, 'blue'), {
    food: 12500, wood: 12500, iron: 12500, manpower: 12500,
  });
});

test('controlled Fortresses add one troop per minute each', () => {
  const bonuses = getFactionTerritoryBonuses([
    { owner_faction: 'blue', is_fortress: true },
    { owner_faction: 'blue', bonus_type: 'fortress' },
    { owner_faction: 'red', is_fortress: true },
  ], 'blue');
  assert.equal(bonuses.fortressTroops, 2);
});

test('passive fortress troops fill only the city reserve up to 250 without clamping it', () => {
  assert.equal(limitPassiveFortressTroopGain(240, 2), 2);
  assert.equal(limitPassiveFortressTroopGain(249, 5), 1);
  assert.equal(limitPassiveFortressTroopGain(250, 5), 0);
  assert.equal(limitPassiveFortressTroopGain(300, 5), 0);
  assert.equal(limitPassiveFortressTroopGain(208, 5), 5);
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
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE buildings ADD COLUMN IF NOT EXISTS storage INTEGER NOT NULL DEFAULT 1')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE territories ADD COLUMN IF NOT EXISTS owner_faction')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS contribution')));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS territory_defenders_territory_player_idx')));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS attack_contributions_territory_player_idx')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE attack_targets ADD COLUMN IF NOT EXISTS resolves_at')));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS attack_targets_territory_idx')));
  assert.ok(sqlCalls.some((sql) => sql.includes('ALTER TABLE faction_leaders ALTER COLUMN player_id DROP NOT NULL')));
  assert.ok(sqlCalls.some((sql) => sql.includes('UPDATE territories t') && sql.includes('GREATEST(t.defense_troops')));
  // Admin is never auto-granted by this migration anymore (that was the username-only
  // admin vulnerability); only the defense-in-depth demotion of unexpected admins remains.
  assert.ok(!sqlCalls.some((sql) => sql.includes("UPDATE players SET role = 'admin' WHERE username = $1")));
  assert.ok(sqlCalls.some((sql) => sql.includes("UPDATE players SET role = 'member' WHERE username <> $1 AND role = 'admin'")));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS faction_chat_messages')));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE INDEX IF NOT EXISTS idx_faction_chat_messages_faction_time')));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS topology_version')));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS player_season_stats')));
  assert.ok(sqlCalls.some((sql) => sql.includes('PRIMARY KEY (season_id, player_id)')));
  assert.ok(sqlCalls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS season_territory_faction_ownership')));
  assert.ok(sqlCalls.some((sql) => sql.includes('INSERT INTO season_territory_faction_ownership') && sql.includes("s.status = 'active'")));
  assert.equal(sqlCalls.some((sql) => sql.includes('INSERT INTO player_season_stats') && sql.includes('SELECT')), false);
});

test('storage schema, registration, snapshots, and upgrades stay server-authoritative', () => {
  const schemaSource = fs.readFileSync(path.join(__dirname, '../backend/schema.sql'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const routeStart = serverSource.indexOf("app.post('/api/game/upgrade-building'");
  const routeEnd = serverSource.indexOf("app.post('/api/game/train-soldiers'", routeStart);
  const upgradeRoute = serverSource.slice(routeStart, routeEnd);

  assert.match(schemaSource, /storage INTEGER NOT NULL DEFAULT 1/);
  assert.match(serverSource, /INSERT INTO buildings \(player_id, farm, lumbermill, ironmine, barracks, storage\)/);
  assert.match(serverSource, /storage: Number\(row\.storage \|\| 1\)/);
  assert.match(serverSource, /buildingUpgradeCosts/);
  assert.match(serverSource, /nextStorageCaps/);
  assert.match(upgradeRoute, /const client = await getClient\(\)/);
  assert.match(upgradeRoute, /await client\.query\('BEGIN'\)/);
  assert.match(upgradeRoute, /SELECT \* FROM players WHERE id = \$1 FOR UPDATE/);
  assert.match(upgradeRoute, /SELECT \* FROM buildings WHERE player_id = \$1 FOR UPDATE/);
  assert.match(upgradeRoute, /currentLevel >= MAX_BUILDING_LEVEL/);
  assert.match(upgradeRoute, /maximum level of \$\{MAX_BUILDING_LEVEL\}/);
  assert.match(upgradeRoute, /await client\.query\('COMMIT'\)/);
  assert.match(upgradeRoute, /client\.release\(\)/);
});

test('training cost and idle earnings are consistent with server-authoritative rules', () => {
  const trainingCost = getTrainingCost(5, 1);
  assert.equal(trainingCost.food, 250);
  assert.equal(trainingCost.iron, 125);
  assert.equal(trainingCost.manpower, 100);

  assert.deepEqual(getTrainingCost(10, 0.95), { food: 475, iron: 238, manpower: 190 });
  assert.deepEqual(getTrainingCost(20, 0.95), { food: 950, iron: 475, manpower: 380 });

  const serverSource = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const trainingRoute = serverSource.match(/app\.post\('\/api\/game\/train-soldiers'[\s\S]*?\n\}\)\);/);
  const trainingSource = fs.readFileSync(path.join(__dirname, '../backend/soldier-training.js'), 'utf8');
  assert.ok(trainingRoute?.[0].includes('performSoldierTraining(client'), 'training endpoint should use the atomic authority helper');
  assert.ok(trainingSource.includes('getTrainingCost(count, trainingMultiplier)'), 'training authority should use the shared cost helper');
  assert.ok(trainingSource.includes('SELECT * FROM players WHERE id = $1 FOR UPDATE'), 'training authority should lock the player before checking resources');
  assert.ok(trainingSource.includes('soldiers = soldiers + $4'), 'training should add requested troops even above the passive cap');
  assert.ok(!trainingRoute?.[0].includes('limitPassiveFortressTroopGain'), 'the passive fortress cap must not apply to training');

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
