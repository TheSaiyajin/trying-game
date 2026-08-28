const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorizedAdminPlayer } = require('../backend/admin-policy');
const {
  STARTING_BUILDING_LEVELS,
  STARTING_PLAYER_RESOURCES,
  getSeasonResetPlan,
  getWorldResetSeedSql,
  resetAllPlayerResources,
  resetPlayerProgress,
  resetWorldState,
  runAdminTransaction,
} = require('../backend/admin-resets');

function cloneState(state) {
  return {
    players: new Map([...state.players.entries()].map(([id, player]) => [id, { ...player }])),
    buildings: new Map([...state.buildings.entries()].map(([playerId, building]) => [playerId, { ...building }])),
    territories: new Map([...state.territories.entries()].map(([id, territory]) => [id, { ...territory }])),
    territoryDefenders: new Map([...state.territoryDefenders.entries()].map(([key, defender]) => [key, { ...defender }])),
    attackContributions: [...state.attackContributions],
    attackTargets: [...state.attackTargets],
    battleHistory: [...state.battleHistory],
    territoryNeighbors: [...state.territoryNeighbors],
    adminActions: [...state.adminActions],
  };
}

function createResetClient(initialState, options = {}) {
  const state = cloneState(initialState);
  const transactionSnapshots = [];

  return {
    state,
    async query(sql, params = []) {
      const text = sql.trim();

      if (options.failOn && text.startsWith(options.failOn)) {
        throw new Error(options.failMessage || `Forced failure for ${options.failOn}`);
      }

      if (text === 'BEGIN') {
        transactionSnapshots.push(cloneState(state));
        return { rows: [], rowCount: 0 };
      }

      if (text === 'COMMIT') {
        transactionSnapshots.pop();
        return { rows: [], rowCount: 0 };
      }

      if (text === 'ROLLBACK') {
        const snapshot = transactionSnapshots.pop();
        if (snapshot) {
          state.players = snapshot.players;
          state.buildings = snapshot.buildings;
          state.territories = snapshot.territories;
          state.territoryDefenders = snapshot.territoryDefenders;
          state.attackContributions = snapshot.attackContributions;
          state.attackTargets = snapshot.attackTargets;
          state.battleHistory = snapshot.battleHistory;
          state.territoryNeighbors = snapshot.territoryNeighbors;
          state.adminActions = snapshot.adminActions;
        }
        return { rows: [], rowCount: 0 };
      }

      if (text === 'SELECT id FROM players WHERE id = $1 FOR UPDATE') {
        const player = state.players.get(params[0]);
        return { rows: player ? [{ id: player.id }] : [], rowCount: player ? 1 : 0 };
      }

      if (text === 'SELECT id FROM players FOR UPDATE') {
        const rows = [...state.players.values()].map((player) => ({ id: player.id }));
        return { rows, rowCount: rows.length };
      }

      if (text.startsWith('SELECT t.id, t.defense_troops')) {
        const playerId = params[0];
        const rows = [...state.territoryDefenders.values()]
          .filter((defender) => Number(defender.player_id) === Number(playerId))
          .map((defender) => state.territories.get(defender.territory_id))
          .filter(Boolean)
          .map((territory) => ({ id: territory.id, defense_troops: territory.defense_troops }));
        return { rows, rowCount: rows.length };
      }

      if (text.startsWith('SELECT territory_id, player_id, faction, troops')) {
        const rows = [...state.territoryDefenders.values()]
          .filter((defender) => defender.territory_id === params[0])
          .map((defender) => ({ ...defender }));
        return { rows, rowCount: rows.length };
      }

      if (text === 'DELETE FROM territory_defenders WHERE territory_id = $1 AND player_id = $2') {
        state.territoryDefenders.delete(`${params[0]}:${params[1]}`);
        return { rows: [], rowCount: 1 };
      }

      if (text === 'UPDATE territories SET defense_troops = $1 WHERE id = $2') {
        const territory = state.territories.get(params[1]);
        if (territory) territory.defense_troops = params[0];
        return { rows: [], rowCount: territory ? 1 : 0 };
      }

      if (text.startsWith('UPDATE players') && text.includes('WHERE id = $6')) {
        const [food, wood, iron, manpower, soldiers, playerId] = params;
        const player = state.players.get(playerId);
        if (player) {
          Object.assign(player, {
            resource_food: food,
            resource_wood: wood,
            resource_iron: iron,
            resource_manpower: manpower,
            soldiers,
          });
        }
        return { rows: [], rowCount: player ? 1 : 0 };
      }

      if (text.startsWith('UPDATE buildings') && text.includes('WHERE player_id = $5')) {
        const [farm, lumbermill, ironmine, barracks, playerId] = params;
        const buildings = state.buildings.get(playerId);
        if (buildings) {
          Object.assign(buildings, { farm, lumbermill, ironmine, barracks });
        }
        return { rows: [], rowCount: buildings ? 1 : 0 };
      }

      if (text.startsWith('UPDATE players') && !text.includes('WHERE id = $6')) {
        const [food, wood, iron, manpower, soldiers] = params;
        for (const player of state.players.values()) {
          Object.assign(player, {
            resource_food: food,
            resource_wood: wood,
            resource_iron: iron,
            resource_manpower: manpower,
            soldiers,
          });
        }
        return { rows: [], rowCount: state.players.size };
      }

      if (text.startsWith('UPDATE buildings') && !text.includes('WHERE player_id = $5')) {
        const [farm, lumbermill, ironmine, barracks] = params;
        for (const buildings of state.buildings.values()) {
          Object.assign(buildings, { farm, lumbermill, ironmine, barracks });
        }
        return { rows: [], rowCount: state.buildings.size };
      }

      if (text === 'DELETE FROM attack_contributions') {
        state.attackContributions = [];
        return { rows: [], rowCount: 0 };
      }
      if (text === 'DELETE FROM attack_targets') {
        state.attackTargets = [];
        return { rows: [], rowCount: 0 };
      }
      if (text === 'DELETE FROM territory_defenders') {
        state.territoryDefenders = new Map();
        return { rows: [], rowCount: 0 };
      }
      if (text === 'DELETE FROM battle_history') {
        state.battleHistory = [];
        return { rows: [], rowCount: 0 };
      }
      if (text === 'DELETE FROM territory_neighbors') {
        state.territoryNeighbors = [];
        return { rows: [], rowCount: 0 };
      }
      if (text === 'DELETE FROM territories') {
        state.territories = new Map();
        return { rows: [], rowCount: 0 };
      }

      if (text.startsWith('INSERT INTO admin_actions')) {
        state.adminActions.push({
          actorId: params[0],
          actionName: params[1],
          detail: JSON.parse(params[2]),
        });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query in reset test client: ${text}`);
    },
  };
}

function buildResetState() {
  return {
    players: new Map([
      [1, { id: 1, username: 'Sai', password_hash: 'hash-sai', role: 'admin', resource_food: 999, resource_wood: 888, resource_iron: 777, resource_manpower: 666, soldiers: 555 }],
      [2, { id: 2, username: 'Rook', password_hash: 'hash-rook', role: 'member', resource_food: 111, resource_wood: 222, resource_iron: 333, resource_manpower: 444, soldiers: 12 }],
    ]),
    buildings: new Map([
      [1, { player_id: 1, farm: 9, lumbermill: 8, ironmine: 7, barracks: 6 }],
      [2, { player_id: 2, farm: 5, lumbermill: 4, ironmine: 3, barracks: 2 }],
    ]),
    territories: new Map([
      ['b1', { id: 'b1', owner_faction: 'red', defense_troops: 99 }],
      ['n1', { id: 'n1', owner_faction: 'green', defense_troops: 77 }],
    ]),
    territoryDefenders: new Map([
      ['b1:2', { territory_id: 'b1', player_id: 2, troops: 10 }],
    ]),
    attackContributions: [{ territory_id: 'n1', player_id: 2, contribution: 15 }],
    attackTargets: [{ territory_id: 'n1', faction: 'red' }],
    battleHistory: [{ territory_id: 'n1', winner: 'red' }],
    territoryNeighbors: [{ territory_id: 'b1', neighbor_id: 'n1' }],
    adminActions: [],
  };
}

test('reset world preserves accounts while restoring the seeded world state', async () => {
  const client = createResetClient(buildResetState());

  await runAdminTransaction(client, async () => resetWorldState(client, {
    actorId: 1,
    applyWorldSeedFn: async () => {
      client.state.territories = new Map([
        ['b1', { id: 'b1', owner_faction: 'blue', defense_troops: 35 }],
        ['n1', { id: 'n1', owner_faction: 'neutral', defense_troops: 18 }],
      ]);
      client.state.territoryNeighbors = [{ territory_id: 'b1', neighbor_id: 'n1' }];
    },
  }));

  assert.deepEqual(
    [...client.state.players.values()].map((player) => ({ id: player.id, username: player.username, password_hash: player.password_hash, role: player.role })),
    [
      { id: 1, username: 'Sai', password_hash: 'hash-sai', role: 'admin' },
      { id: 2, username: 'Rook', password_hash: 'hash-rook', role: 'member' },
    ]
  );
  assert.equal(client.state.players.get(1).resource_food, STARTING_PLAYER_RESOURCES.food);
  assert.equal(client.state.players.get(2).soldiers, STARTING_PLAYER_RESOURCES.soldiers);
  assert.deepEqual(client.state.buildings.get(2), { player_id: 2, ...STARTING_BUILDING_LEVELS });
  assert.equal(client.state.territoryDefenders.size, 0);
  assert.deepEqual([...client.state.territories.values()], [
    { id: 'b1', owner_faction: 'blue', defense_troops: 35 },
    { id: 'n1', owner_faction: 'neutral', defense_troops: 18 },
  ]);
  assert.equal(client.state.territoryDefenders.size, 0);
  assert.deepEqual(client.state.attackContributions, []);
  assert.deepEqual(client.state.attackTargets, []);
  assert.deepEqual(client.state.battleHistory, []);
  assert.equal(client.state.adminActions.at(-1).actionName, 'reset_world');
});

test('reset player only affects the selected player progress', async () => {
  const client = createResetClient(buildResetState());

  const result = await runAdminTransaction(client, async () => resetPlayerProgress(client, { actorId: 1, playerId: 2 }));

  assert.equal(result.ok, true);
  assert.equal(client.state.players.get(1).resource_food, 999);
  assert.equal(client.state.players.get(1).soldiers, 555);
  assert.equal(client.state.players.get(2).resource_food, STARTING_PLAYER_RESOURCES.food);
  assert.equal(client.state.players.get(2).soldiers, STARTING_PLAYER_RESOURCES.soldiers);
  assert.equal(client.state.territoryDefenders.size, 0);
  assert.equal(client.state.territories.get('b1').defense_troops, 89);
  assert.deepEqual(client.state.buildings.get(1), { player_id: 1, farm: 9, lumbermill: 8, ironmine: 7, barracks: 6 });
  assert.deepEqual(client.state.buildings.get(2), { player_id: 2, ...STARTING_BUILDING_LEVELS });
  assert.equal(client.state.adminActions.at(-1).actionName, 'reset_player');
});

test('reset all player resources clears stationed defenders while keeping territory ownership unchanged', async () => {
  const client = createResetClient(buildResetState());
  const ownersBefore = [...client.state.territories.values()].map((territory) => ({ id: territory.id, owner_faction: territory.owner_faction }));
  const buildingsBefore = [...client.state.buildings.values()].map((building) => ({ ...building }));

  await runAdminTransaction(client, async () => resetAllPlayerResources(client, { actorId: 1 }));

  assert.deepEqual(
    [...client.state.territories.values()].map((territory) => ({ id: territory.id, owner_faction: territory.owner_faction })),
    ownersBefore
  );
  assert.deepEqual([...client.state.buildings.values()], buildingsBefore);
  assert.equal(client.state.players.get(1).resource_food, STARTING_PLAYER_RESOURCES.food);
  assert.equal(client.state.players.get(2).soldiers, STARTING_PLAYER_RESOURCES.soldiers);
  assert.equal(client.state.territoryDefenders.size, 0);
  assert.equal(client.state.territories.get('b1').defense_troops, 89);
  assert.equal(client.state.adminActions.at(-1).actionName, 'reset_all_resources');
});

test('non-Sai users cannot access Sai-only reset endpoints', () => {
  assert.equal(isAuthorizedAdminPlayer({ username: 'Sai', role: 'admin' }), true);
  assert.equal(isAuthorizedAdminPlayer({ username: 'Sai', role: 'member' }), false);
  assert.equal(isAuthorizedAdminPlayer({ username: 'OtherPlayer', role: 'admin' }), false);
  assert.equal(isAuthorizedAdminPlayer({ username: 'OtherPlayer', role: 'leader' }), false);
});

test('failed reset rolls back all destructive changes', async () => {
  const initialState = buildResetState();
  const client = createResetClient(initialState, { failOn: 'INSERT INTO admin_actions', failMessage: 'log write failed' });
  const before = cloneState(initialState);

  await assert.rejects(
    () => runAdminTransaction(client, async () => resetWorldState(client, {
      actorId: 1,
      applyWorldSeedFn: async () => {
        client.state.territories = new Map([
          ['b1', { id: 'b1', owner_faction: 'blue', defense_troops: 35 }],
        ]);
      },
    })),
    /log write failed/
  );

  assert.deepEqual([...client.state.players.entries()], [...before.players.entries()]);
  assert.deepEqual([...client.state.buildings.entries()], [...before.buildings.entries()]);
  assert.deepEqual([...client.state.territories.entries()], [...before.territories.entries()]);
  assert.deepEqual([...client.state.territoryDefenders.entries()], [...before.territoryDefenders.entries()]);
  assert.deepEqual(client.state.attackContributions, before.attackContributions);
  assert.deepEqual(client.state.attackTargets, before.attackTargets);
  assert.deepEqual(client.state.battleHistory, before.battleHistory);
  assert.deepEqual(client.state.territoryNeighbors, before.territoryNeighbors);
});

test('season reset planning stays separate from full world reset behavior', () => {
  const plan = getSeasonResetPlan();

  assert.deepEqual(plan.preserve, ['player_accounts', 'usernames', 'password_hashes', 'account_ids', 'admin_roles']);
  assert.ok(plan.reset.includes('seasonal_rankings'));
  assert.ok(plan.undecided.includes('battle_history_retention'));
});

test('world reset seed filtering never includes account deletion statements', () => {
  const filtered = getWorldResetSeedSql([
    'DELETE FROM players;',
    'DELETE FROM buildings;',
    'DELETE FROM territories;',
    'INSERT INTO territories VALUES (1);',
  ].join('\n'));

  assert.ok(!filtered.toUpperCase().includes('DELETE FROM PLAYERS'));
  assert.ok(!filtered.toUpperCase().includes('DELETE FROM BUILDINGS'));
  assert.ok(!filtered.toUpperCase().includes('DELETE FROM TERRITORIES'));
  assert.ok(filtered.includes('INSERT INTO territories VALUES (1);'));
});
