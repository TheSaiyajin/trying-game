const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorizedAdminPlayer } = require('../backend/admin-policy');
const { changePlayerFaction } = require('../backend/admin-faction-change');

function createFakeClient({ players, territories, defenders, factionLeaders }) {
  const adminActions = [];

  return {
    adminActions,
    async query(sql, params = []) {
      const text = sql.trim();

      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }

      if (text === 'SELECT id, username, faction, role FROM players WHERE id = $1 FOR UPDATE') {
        const player = players.get(params[0]);
        return { rows: player ? [{ id: player.id, username: player.username, faction: player.faction, role: player.role }] : [] };
      }

      if (text.startsWith('SELECT DISTINCT t.id, t.owner_faction, t.defense_troops')) {
        const [playerId, faction] = params;
        const rows = [...defenders.entries()]
          .filter(([key]) => Number(key.split(':')[1]) === Number(playerId))
          .map(([key]) => key.split(':')[0])
          .filter((territoryId, index, list) => list.indexOf(territoryId) === index)
          .map((territoryId) => territories.get(territoryId))
          .filter((territory) => territory && territory.owner_faction !== faction)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((territory) => ({
            id: territory.id,
            owner_faction: territory.owner_faction,
            defense_troops: territory.defense_troops,
          }));
        return { rows };
      }

      if (text.startsWith('SELECT territory_id, player_id, faction, troops')) {
        const territoryId = params[0];
        const rows = [...defenders.entries()]
          .filter(([key]) => key.startsWith(`${territoryId}:`))
          .map(([key, defender]) => {
            const [, playerId] = key.split(':');
            return {
              territory_id: territoryId,
              player_id: Number(playerId),
              faction: defender.faction,
              troops: defender.troops,
            };
          })
          .sort((left, right) => left.player_id - right.player_id);
        return { rows, rowCount: rows.length };
      }

      if (text === 'DELETE FROM territory_defenders WHERE territory_id = $1 AND player_id = $2') {
        defenders.delete(`${params[0]}:${params[1]}`);
        return { rows: [] };
      }

      if (text === 'UPDATE territories SET defense_troops = $1 WHERE id = $2') {
        const territory = territories.get(params[1]);
        if (territory) territory.defense_troops = params[0];
        return { rows: [] };
      }

      if (text.startsWith('UPDATE players')) {
        const [faction, armyName, role, recalledTroops, playerId] = params;
        const player = players.get(playerId);
        if (player) {
          player.faction = faction;
          player.faction_locked = true;
          player.army_name = armyName;
          player.role = role;
          player.soldiers += recalledTroops;
        }
        return { rows: [] };
      }

      if (text === 'UPDATE faction_leaders SET player_id = NULL WHERE player_id = $1') {
        for (const [faction, assignedPlayerId] of factionLeaders.entries()) {
          if (Number(assignedPlayerId) === Number(params[0])) {
            factionLeaders.set(faction, null);
          }
        }
        return { rows: [] };
      }

      if (text.startsWith('UPDATE territory_defenders td')) {
        const [faction, playerId] = params;
        for (const [key, defender] of defenders.entries()) {
          const [territoryId, keyPlayerId] = key.split(':');
          if (Number(keyPlayerId) === Number(playerId) && territories.get(territoryId)?.owner_faction === faction) {
            defenders.set(key, { ...defender, faction });
          }
        }
        return { rows: [] };
      }

      if (text.startsWith('INSERT INTO admin_actions')) {
        adminActions.push({
          actorId: params[0],
          actionName: params[1],
          detail: JSON.parse(params[2]),
        });
        return { rows: [] };
      }

      throw new Error(`Unexpected query in fake client: ${text}`);
    },
  };
}

test('changing a player faction keeps progress, locks faction, recalls invalid defenders, and logs the change', async () => {
  const players = new Map([
    [1, { id: 1, username: 'Sai', faction: 'blue', role: 'admin', soldiers: 100 }],
    [2, { id: 2, username: 'Rook', faction: 'blue', role: 'leader', soldiers: 35, resource_food: 900, army_name: 'Blue Army', faction_locked: true }],
    [3, { id: 3, username: 'Shield', faction: 'blue', role: 'member', soldiers: 20 }],
  ]);
  const territories = new Map([
    ['b1', { id: 'b1', owner_faction: 'blue', defense_troops: 40 }],
    ['r1', { id: 'r1', owner_faction: 'red', defense_troops: 12 }],
  ]);
  const defenders = new Map([
    ['b1:2', { faction: 'blue', troops: 8 }],
    ['b1:3', { faction: 'blue', troops: 5 }],
    ['r1:2', { faction: 'blue', troops: 4 }],
  ]);
  const factionLeaders = new Map([
    ['blue', 2],
    ['red', null],
  ]);
  const client = createFakeClient({ players, territories, defenders, factionLeaders });

  const result = await changePlayerFaction(client, { actorId: 1, playerId: 2, faction: 'red' });

  assert.equal(result.ok, true);
  assert.equal(result.oldFaction, 'blue');
  assert.equal(result.newFaction, 'red');
  assert.equal(result.recalledTroops, 8);
  assert.deepEqual(result.clearedTerritories, [
    { territoryId: 'b1', ownerFaction: 'blue', troopsRecalled: 8 },
  ]);
  assert.equal(players.get(2).faction, 'red');
  assert.equal(players.get(2).faction_locked, true);
  assert.equal(players.get(2).army_name, 'Red Army');
  assert.equal(players.get(2).role, 'member');
  assert.equal(players.get(2).resource_food, 900);
  assert.equal(players.get(2).soldiers, 43);
  assert.equal(territories.get('b1').defense_troops, 32);
  assert.deepEqual(defenders.get('r1:2'), { faction: 'red', troops: 4 });
  assert.equal(defenders.has('b1:2'), false);
  assert.equal(factionLeaders.get('blue'), null);
  assert.equal(client.adminActions.length, 1);
  assert.equal(client.adminActions[0].actionName, 'change_faction');
  assert.deepEqual(client.adminActions[0].detail.clearedTerritories, [
    { territoryId: 'b1', ownerFaction: 'blue', troopsRecalled: 8 },
  ]);
});

test('changing faction returns 404 for a missing player', async () => {
  const client = createFakeClient({
    players: new Map(),
    territories: new Map(),
    defenders: new Map(),
    factionLeaders: new Map(),
  });

  const result = await changePlayerFaction(client, { actorId: 1, playerId: 999, faction: 'green' });

  assert.deepEqual(result, { ok: false, status: 404, error: 'Player not found.' });
});

test('non-Sai users cannot satisfy the admin policy required by faction changes', () => {
  assert.equal(isAuthorizedAdminPlayer({ username: 'Sai', role: 'admin' }), true);
  assert.equal(isAuthorizedAdminPlayer({ username: 'OtherPlayer', role: 'admin' }), false);
  assert.equal(isAuthorizedAdminPlayer({ username: 'OtherPlayer', role: 'leader' }), false);
});
