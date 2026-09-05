const { isSaiUsername } = require('./admin-policy');
const { logAdminAction } = require('./admin-write-operations');
const {
  getLockedTerritoryDefenders,
  getTerritoryDefenseState,
  sumStationedDefenders,
} = require('./defender-garrisons');

function buildArmyName(faction) {
  return `${faction.charAt(0).toUpperCase()}${faction.slice(1)} Army`;
}

function getFactionChangeRole(player) {
  if (isSaiUsername(player.username)) return 'admin';
  const role = String(player.role || '').toLowerCase();
  if (role === 'leader' || role === 'admin') return 'member';
  return role || 'member';
}

async function clearInvalidFactionDefenders(client, playerId, faction) {
  const territoryResult = await client.query(
    `SELECT t.id, t.owner_faction, t.defense_troops
     FROM territories t
     WHERE t.owner_faction <> $2
       AND EXISTS (
         SELECT 1
         FROM territory_defenders td
         WHERE td.territory_id = t.id
           AND td.player_id = $1
       )
     ORDER BY t.id
     FOR UPDATE OF t`,
    [playerId, faction]
  );

  let recalledTroops = 0;
  const clearedTerritories = [];

  for (const territory of territoryResult.rows) {
    const defenders = await getLockedTerritoryDefenders(client, territory.id);
    const stationed = defenders.find((defender) => Number(defender.player_id) === Number(playerId));
    if (!stationed) continue;

    const defenseState = getTerritoryDefenseState(territory.defense_troops, defenders);
    const remainingStationed = sumStationedDefenders(
      defenders.filter((defender) => Number(defender.player_id) !== Number(playerId))
    );

    await client.query(
      'DELETE FROM territory_defenders WHERE territory_id = $1 AND player_id = $2',
      [territory.id, playerId]
    );
    await client.query(
      'UPDATE territories SET defense_troops = $1 WHERE id = $2',
      [defenseState.baseDefenseTroops + remainingStationed, territory.id]
    );

    recalledTroops += Number(stationed.troops);
    clearedTerritories.push({
      territoryId: territory.id,
      ownerFaction: territory.owner_faction,
      troopsRecalled: Number(stationed.troops),
    });
  }

  return { recalledTroops, clearedTerritories };
}

async function changePlayerFaction(client, { actorId, playerId, faction }) {
  const playerResult = await client.query(
    'SELECT id, username, faction, role FROM players WHERE id = $1 FOR UPDATE',
    [playerId]
  );
  const player = playerResult.rows[0];
  if (!player) {
    return { ok: false, status: 404, error: 'Player not found.' };
  }

  const cleanup = await clearInvalidFactionDefenders(client, playerId, faction);
  const nextRole = getFactionChangeRole(player);

  await client.query(
    `UPDATE players
     SET faction = $1,
         faction_locked = TRUE,
         army_name = $2,
         role = $3,
         soldiers = soldiers + $4
     WHERE id = $5`,
    [faction, buildArmyName(faction), nextRole, cleanup.recalledTroops, playerId]
  );
  await client.query(
    `INSERT INTO season_memberships (season_id, player_id, faction)
     SELECT id, $1::integer, $2::varchar(16) FROM seasons WHERE status = 'active'
     ON CONFLICT (season_id, player_id) DO UPDATE SET faction = EXCLUDED.faction`,
    [playerId, faction]
  );
  await client.query(
    `DELETE FROM faction_city_tiles
     WHERE player_id = $1
       AND season_id IN (SELECT id FROM seasons WHERE status = 'active')`,
    [playerId]
  );
  await client.query(
    `INSERT INTO faction_city_tiles (season_id, player_id, faction, slot_index)
     SELECT s.id, $1::integer, $2::varchar(16),
            COALESCE((SELECT MAX(slot_index) + 1 FROM faction_city_tiles WHERE season_id = s.id AND faction = $2::varchar(16)), 0)
     FROM seasons s WHERE s.status = 'active'
     ON CONFLICT (season_id, player_id) DO NOTHING`,
    [playerId, faction]
  );
  await client.query('UPDATE faction_leaders SET player_id = NULL WHERE player_id = $1', [playerId]);
  await client.query(
    `UPDATE territory_defenders td
     SET faction = $1, updated_at = NOW()
     FROM territories t
     WHERE td.territory_id = t.id
       AND td.player_id = $2
       AND t.owner_faction = $1`,
    [faction, playerId]
  );
  await logAdminAction(client, actorId, 'change_faction', {
    playerId,
    username: player.username,
    oldFaction: player.faction,
    newFaction: faction,
    recalledTroops: cleanup.recalledTroops,
    clearedTerritories: cleanup.clearedTerritories,
    roleAfterChange: nextRole,
  });

  return {
    ok: true,
    playerId,
    oldFaction: player.faction,
    newFaction: faction,
    recalledTroops: cleanup.recalledTroops,
    clearedTerritories: cleanup.clearedTerritories,
    roleAfterChange: nextRole,
  };
}

module.exports = {
  buildArmyName,
  getFactionChangeRole,
  clearInvalidFactionDefenders,
  changePlayerFaction,
};
