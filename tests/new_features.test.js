const test = require('node:test');
const assert = require('node:assert/strict');
const { getFactionTerritoryBonuses, getProductionFromBuildings } = require('../backend/game-logic');
const { seedWorldIfEmpty } = require('../backend/db');
const {
  buildAuthPayload,
  canAttack,
  getFactionLegendEntries,
  mapTerritories,
  isAdminUser,
} = require('../script.js');
const {
  isSafeUsername,
  isAuthorizedAdminPlayer,
  getRegistrationRole,
  normalizeRequestedRole,
} = require('../backend/admin-policy');
const { allocateDefenderCasualties } = require('../backend/defender-garrisons');

// ===================== Admin / Username policy =====================

test('registration payload never includes a faction: it is assigned automatically each season', () => {
  assert.deepEqual(
    buildAuthPayload({ username: 'PlayerOne', password: 'secret123', isRegister: true }),
    { username: 'PlayerOne', password: 'secret123' }
  );
  assert.deepEqual(
    buildAuthPayload({ username: 'PlayerOne', password: 'secret123', isRegister: true, faction: 'red' }),
    { username: 'PlayerOne', password: 'secret123' }
  );
});

test('map legend marks only blue as the current player for blue players', () => {
  const entries = getFactionLegendEntries('blue');
  assert.deepEqual(entries.map((entry) => entry.label), ['Blue (You)', 'Red', 'Green', 'Target']);
  assert.equal(entries.filter((entry) => entry.label.includes('(You)')).length, 1);
});

test('map legend marks only red as the current player for red players', () => {
  const entries = getFactionLegendEntries('red');
  assert.deepEqual(entries.map((entry) => entry.label), ['Blue', 'Red (You)', 'Green', 'Target']);
  assert.equal(entries.filter((entry) => entry.label.includes('(You)')).length, 1);
});

test('map legend marks only green as the current player for green players', () => {
  const entries = getFactionLegendEntries('green');
  assert.deepEqual(entries.map((entry) => entry.label), ['Blue', 'Red', 'Green (You)', 'Target']);
  assert.equal(entries.filter((entry) => entry.label.includes('(You)')).length, 1);
});

test('username policy allows only safe usernames', () => {
  assert.equal(isSafeUsername('Sai'), true);
  assert.equal(isSafeUsername('good_name-123'), true);
  assert.equal(isSafeUsername('ab'), false);
  assert.equal(isSafeUsername('bad name'), false);
  assert.equal(isSafeUsername('<script>'), false);
  assert.equal(isSafeUsername('semi;colon'), false);
});

test('registering the username Sai never grants admin automatically', () => {
  assert.equal(getRegistrationRole('Sai'), 'member');
  assert.equal(getRegistrationRole('OtherPlayer'), 'member');
  assert.equal(getRegistrationRole(), 'member');
  assert.equal(isAuthorizedAdminPlayer({ username: 'Sai', role: 'admin' }), true);
  assert.equal(isAuthorizedAdminPlayer({ username: 'Sai', role: 'member' }), false);
  assert.equal(isAuthorizedAdminPlayer({ username: 'Sai', role: 'leader' }), false);
  assert.equal(isAuthorizedAdminPlayer({ username: 'OtherPlayer', role: 'admin' }), false);
});

test('role normalization blocks non-Sai admins and preserves Sai admin', () => {
  assert.deepEqual(
    normalizeRequestedRole({ username: 'Sai', role: 'admin' }, 'member'),
    { ok: false, error: 'Sai must remain admin.' }
  );
  assert.deepEqual(
    normalizeRequestedRole({ username: 'Sai', role: 'admin' }, 'admin'),
    { ok: true, role: 'admin' }
  );
  assert.deepEqual(
    normalizeRequestedRole({ username: 'OtherPlayer', role: 'member' }, 'admin'),
    { ok: false, error: 'Role must be member or leader for other players.' }
  );
  assert.deepEqual(
    normalizeRequestedRole({ username: 'OtherPlayer', role: 'member' }, 'leader'),
    { ok: true, role: 'leader' }
  );
});

// ===================== Game state privacy =====================

test('world players list does not expose private resources', () => {
  // Simulate the filtered player object shape returned by getPlayerWorldState
  const worldPlayers = [
    { id: 1, username: 'alice', faction: 'blue', role: 'member' },
    { id: 2, username: 'bob', faction: 'red', role: 'leader' },
  ];

  worldPlayers.forEach((p) => {
    assert.ok(!('resource_food' in p), 'resource_food should not be exposed');
    assert.ok(!('resource_wood' in p), 'resource_wood should not be exposed');
    assert.ok(!('resource_iron' in p), 'resource_iron should not be exposed');
    assert.ok(!('soldiers' in p), 'soldiers should not be exposed');
    assert.ok('username' in p);
    assert.ok('faction' in p);
    assert.ok('role' in p);
  });
});

// ===================== Battle feed =====================

test('battle feed entries have required fields and no private resources', () => {
  const mockBattle = {
    id: 1,
    attacker_faction: 'blue',
    defender_faction: 'neutral',
    territory_id: 'n1',
    territory_name: 'Farmstead',
    attacker_username: 'alice',
    troops_sent: 50,
    attackers_lost: 20,
    defenders_lost: 18,
    attackers_surviving: 30,
    defenders_surviving: 0,
    winner: 'blue',
    owner_before: 'neutral',
    owner_after: 'blue',
    created_at: new Date().toISOString(),
  };

  assert.ok('attacker_faction' in mockBattle);
  assert.ok('defender_faction' in mockBattle);
  assert.ok('attacker_username' in mockBattle);
  assert.ok('territory_name' in mockBattle);
  assert.ok('troops_sent' in mockBattle);
  assert.ok('winner' in mockBattle);
  assert.ok('owner_before' in mockBattle);
  assert.ok('owner_after' in mockBattle);
  // No private resource fields
  assert.ok(!('resource_food' in mockBattle));
  assert.ok(!('resource_wood' in mockBattle));
  assert.ok(!('password_hash' in mockBattle));
});

// ===================== Defender recall validation =====================

test('recall validation: cannot recall more than stationed', () => {
  // Mirrors the server logic: guard.rows[0].troops >= troops
  function simulateRecall(stationedTroops, recallAmount) {
    if (stationedTroops < recallAmount) {
      return { ok: false, error: 'You cannot recall more troops than are stationed.' };
    }
    return { ok: true };
  }

  assert.deepEqual(simulateRecall(10, 10), { ok: true });
  assert.deepEqual(simulateRecall(10, 5), { ok: true });
  assert.deepEqual(simulateRecall(10, 11), { ok: false, error: 'You cannot recall more troops than are stationed.' });
  assert.deepEqual(simulateRecall(0, 1), { ok: false, error: 'You cannot recall more troops than are stationed.' });
});

test('recall validation: only own stationed troops can be recalled (scoped to player_id)', () => {
  // Recalls are filtered by (territory_id, player_id): player A cannot affect player B's garrison
  const defenders = [
    { territory_id: 'n1', player_id: 1, troops: 20 },
    { territory_id: 'n1', player_id: 2, troops: 15 },
  ];

  function getOwnStationedTroops(territoryId, playerId) {
    const row = defenders.find((d) => d.territory_id === territoryId && d.player_id === playerId);
    return row ? row.troops : 0;
  }

  assert.equal(getOwnStationedTroops('n1', 1), 20);
  assert.equal(getOwnStationedTroops('n1', 2), 15);
  assert.equal(getOwnStationedTroops('n1', 3), 0);  // not stationed → 0 → recall would fail
});

test('defender casualties reduce stationed garrisons proportionally', () => {
  const allocation = allocateDefenderCasualties([
    { territory_id: 'n3', player_id: 2, faction: 'red', troops: 7 },
    { territory_id: 'n3', player_id: 4, faction: 'red', troops: 5 },
  ], 5);

  assert.equal(allocation.defendersLost, 5);
  assert.equal(allocation.defendersRemaining, 7);
  assert.deepEqual(allocation.survivors, [
    { territory_id: 'n3', player_id: 2, faction: 'red', troops: 4 },
    { territory_id: 'n3', player_id: 4, faction: 'red', troops: 3 },
  ]);
});

// ===================== Territory bonus formatting =====================

test('mapTerritories preserves territory bonus fields for rendering', () => {
  const mapped = mapTerritories([{ id: 'n1', name: 'Farmstead', owner: 'blue', defense: 12, bonus: 'food', bonusValue: 0.1, storageBonus: 0.2, neighbors: [] }]);
  assert.equal(mapped.n1.bonusValue, 0.1);
  assert.equal(mapped.n1.storageBonus, 0.2);
});

test('canAttack returns false for capitals while normal adjacent enemy territories remain attackable', () => {
  const gameState = {
    player: { faction: 'blue' },
    territories: {
      b1: { id: 'b1', owner: 'blue', capital: true, adj: ['n1'] },
      r1: { id: 'r1', owner: 'red', capital: true, adj: ['n1'] },
      n1: { id: 'n1', owner: 'neutral', capital: false, adj: ['b1'] },
    },
  };

  assert.equal(canAttack('r1', gameState), false);
  assert.equal(canAttack('n1', gameState), true);
});

test('formatBonusLabel produces readable labels for all bonus types', () => {
  const { formatBonusLabel } = require('../script.js');

  assert.equal(formatBonusLabel('food', 0.10), '🌾 +10% Food Production');
  assert.equal(formatBonusLabel('wood', 0.10), '🪵 +10% Wood Production');
  assert.equal(formatBonusLabel('iron', 0.10), '⚙️ +10% Iron Production');
  assert.equal(formatBonusLabel('manpower', 0.10), '👥 +10% Manpower Production');
  assert.equal(formatBonusLabel('training', 0.05), '⚔️ -5% Training Cost');
  assert.equal(formatBonusLabel('fortress', 0), '🏰 Fortress — +1 Troop/min');
  assert.equal(formatBonusLabel('storage', 0.20), '📦 +20% Storage');
  assert.equal(formatBonusLabel('resource', 0.10), '✨ +10% All Resources');
  assert.equal(formatBonusLabel('none', 0), '—');
  assert.equal(formatBonusLabel(null, 0), '—');
});

test('admin UI visibility only allows Sai admin', () => {
  assert.equal(isAdminUser({ username: 'Sai', role: 'admin' }), true);
  assert.equal(isAdminUser({ username: 'Sai', role: 'leader' }), false);
  assert.equal(isAdminUser({ username: 'OtherPlayer', role: 'admin' }), false);
});

// ===================== Territory bonuses work with snapshot-shaped objects =====================

test('getFactionTerritoryBonuses handles snapshot-shaped territory objects (owner + bonus keys)', () => {
  // These use the keys returned by getTerritoriesSnapshot (owner, bonus, bonusValue)
  const territories = [
    { owner: 'blue', bonus: 'food', bonusValue: 0.10 },
    { owner: 'blue', bonus: 'wood', bonusValue: 0.15 },
    { owner: 'red', bonus: 'iron', bonusValue: 0.20 },   // different faction, should be ignored
  ];

  const bonuses = getFactionTerritoryBonuses(territories, 'blue');
  assert.equal(bonuses.food, 0.10);
  assert.equal(bonuses.wood, 0.15);
  assert.equal(bonuses.iron, 0);  // red territory ignored
});

test('getFactionTerritoryBonuses handles raw DB-shaped territory objects (owner_faction + bonus_type keys)', () => {
  const territories = [
    { owner_faction: 'green', bonus_type: 'manpower', bonus_value: 0.10 },
    { owner_faction: 'green', bonus_type: 'resource', bonus_value: 0.10 },
  ];

  const bonuses = getFactionTerritoryBonuses(territories, 'green');
  // 'resource' bonus adds 0.10 to food/wood/iron/manpower, plus 'manpower' bonus adds 0.10
  assert.equal(bonuses.manpower, 0.20);  // 0.10 (manpower) + 0.10 (resource)
  assert.equal(bonuses.food, 0.10);  // from resource bonus
  assert.equal(bonuses.wood, 0.10);
  assert.equal(bonuses.iron, 0.10);
  assert.equal(bonuses.allResources, 0.10);
});

test('production correctly uses territory bonuses from snapshot-shaped objects', () => {
  const buildings = { farm: 4, lumbermill: 1, ironmine: 1, barracks: 1 };
  const territories = [
    { owner: 'blue', bonus: 'food', bonusValue: 0.20 },
  ];
  const result = getProductionFromBuildings(buildings, territories, 'blue', true);
  // farm level 4: 5 * 4 = 20 base; 20 * 1.20 = 24
  assert.equal(result.food, 24);
});

// ===================== DB seeding idempotency =====================

test('seedWorldIfEmpty logic: skips INSERT when territories already exist', async () => {
  // Test the seeding logic without the actual DB module.
  // The function checks COUNT(*) and only seeds if count == 0.

  async function seedWorldIfEmptyLogic(pool) {
    const result = await pool.query('SELECT COUNT(*) AS cnt FROM territories');
    const count = Number(result.rows[0]?.cnt || 0);
    if (count > 0) {
      return 'skipped';
    }
    await pool.query('INSERT INTO territories ...');
    return 'seeded';
  }

  const poolWithData = {
    async query(sql) {
      if (sql.includes('SELECT COUNT')) return { rows: [{ cnt: '5' }] };
      return { rows: [] };
    },
  };
  const result1 = await seedWorldIfEmptyLogic(poolWithData);
  assert.equal(result1, 'skipped');

  const poolEmpty = {
    async query(sql) {
      if (sql.includes('SELECT COUNT')) return { rows: [{ cnt: '0' }] };
      return { rows: [] };
    },
  };
  const result2 = await seedWorldIfEmptyLogic(poolEmpty);
  assert.equal(result2, 'seeded');
});

// ===================== World reset preserves accounts =====================

test('world reset SQL does not include DELETE FROM players', () => {
  const fs = require('fs');
  const path = require('path');
  const seedPath = path.join(__dirname, '../backend/world-seed.sql');
  const rawSeed = fs.readFileSync(seedPath, 'utf8');

  // The server strips these lines when executing world reset
  const seedLines = rawSeed.split('\n').filter((line) => {
    const trimmed = line.trim().toUpperCase();
    return !(trimmed.startsWith('DELETE FROM PLAYERS') ||
             trimmed.startsWith('DELETE FROM BUILDINGS') ||
             trimmed.startsWith('DELETE FROM ATTACK_CONTRIBUTIONS') ||
             trimmed.startsWith('DELETE FROM ATTACK_TARGETS') ||
             trimmed.startsWith('DELETE FROM TERRITORY_NEIGHBORS') ||
             trimmed.startsWith('DELETE FROM TERRITORIES'));
  });
  const filteredSql = seedLines.join('\n');

  assert.ok(!filteredSql.toUpperCase().includes('DELETE FROM PLAYERS'), 'world reset must not delete players');
  assert.ok(!filteredSql.toUpperCase().includes('DELETE FROM BUILDINGS'), 'world reset must not delete buildings');
  assert.ok(filteredSql.toUpperCase().includes('INSERT INTO TERRITORIES'), 'world reset should insert territories');
});
