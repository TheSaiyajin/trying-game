const { AttackError } = require('./attack-logic');
const { CAPITAL_ATTACK_ERROR, isCapitalTerritory } = require('./territory-protection');

const RALLY_DURATION_MS = 10 * 60 * 1000;

function toSoldierCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return NaN;
  return Math.floor(num);
}

function publicRally(row) {
  return {
    territoryId: row.territory_id,
    attackerFaction: row.faction,
    defenderFaction: row.defender_faction,
    startedBy: row.started_by === null ? null : Number(row.started_by),
    resolvesAt: row.resolves_at,
    totalAttackers: Number(row.total_attackers || 0),
    myContribution: Number(row.my_contribution || 0),
  };
}

async function startOrJoinRally(client, {
  playerId,
  territoryId,
  soldiers,
  seasonId,
  now = new Date(),
}) {
  const cleanTerritoryId = typeof territoryId === 'string' ? territoryId.trim() : '';
  if (!cleanTerritoryId) throw new AttackError(400, 'Target territory required.');

  const soldierCount = toSoldierCount(soldiers);
  if (!Number.isFinite(soldierCount) || soldierCount <= 0) {
    throw new AttackError(400, 'Rally contribution must send at least one soldier.');
  }

  await client.query('BEGIN');
  try {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
      [cleanTerritoryId]
    );
    const acquiredLock = lockResult.rows[0] ? Boolean(lockResult.rows[0].locked) : true;
    if (!acquiredLock) throw new AttackError(409, 'This territory is busy. Try again.');

    const playerResult = await client.query('SELECT * FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    const player = playerResult.rows[0];
    if (!player) throw new AttackError(404, 'Player not found.');
    if (!player.faction) throw new AttackError(403, 'Choose a faction before attacking.');
    if (Number(player.soldiers) < soldierCount) throw new AttackError(400, 'Not enough soldiers to send.');

    const targetResult = await client.query('SELECT * FROM territories WHERE id = $1 FOR UPDATE', [cleanTerritoryId]);
    const target = targetResult.rows[0];
    if (!target) throw new AttackError(404, 'Territory not found.');
    if (isCapitalTerritory(target)) throw new AttackError(403, CAPITAL_ATTACK_ERROR);

    const ownerFaction = target.owner_faction || 'neutral';
    if (ownerFaction === 'neutral') {
      throw new AttackError(409, 'This territory is neutral. Attack it directly.');
    }
    if (ownerFaction === player.faction) {
      throw new AttackError(403, 'You cannot attack your own territory.');
    }

    const adjacent = await client.query(
      `SELECT 1
       FROM territory_neighbors n
       INNER JOIN territories t ON t.id = n.territory_id
       WHERE n.neighbor_id = $1 AND t.owner_faction = $2
       LIMIT 1`,
      [cleanTerritoryId, player.faction]
    );
    if (!adjacent.rowCount) {
      throw new AttackError(403, 'This territory is not adjacent to your faction.');
    }

    const activeResult = await client.query(
      'SELECT * FROM attack_targets WHERE territory_id = $1 FOR UPDATE',
      [cleanTerritoryId]
    );
    let rally = activeResult.rows[0] || null;
    const created = !rally;

    if (rally) {
      if (Number(rally.season_id) !== Number(seasonId)) {
        throw new AttackError(409, 'This rally belongs to an expired season. Try again shortly.');
      }
      if (rally.faction !== player.faction) {
        throw new AttackError(409, 'Another faction already has a rally against this territory.');
      }
      if (rally.defender_faction !== ownerFaction) {
        throw new AttackError(409, 'Territory ownership changed. Try again shortly.');
      }
      if (new Date(rally.resolves_at).getTime() <= now.getTime()) {
        throw new AttackError(409, 'This rally is resolving. Try again shortly.');
      }
    } else {
      const resolvesAt = new Date(now.getTime() + RALLY_DURATION_MS);
      const insertResult = await client.query(
        `INSERT INTO attack_targets
           (faction, territory_id, started_by, defender_faction, season_id, created_at, resolves_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [player.faction, cleanTerritoryId, player.id, ownerFaction, seasonId, now, resolvesAt]
      );
      rally = insertResult.rows[0] || {
        faction: player.faction,
        territory_id: cleanTerritoryId,
        started_by: player.id,
        defender_faction: ownerFaction,
        season_id: seasonId,
        created_at: now,
        resolves_at: resolvesAt,
      };
    }

    await client.query(
      `UPDATE players
       SET soldiers = soldiers - $1, last_action_at = NOW()
       WHERE id = $2`,
      [soldierCount, player.id]
    );
    await client.query(
      `INSERT INTO attack_contributions (territory_id, player_id, contribution, faction)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (territory_id, player_id)
       DO UPDATE SET contribution = attack_contributions.contribution + EXCLUDED.contribution,
                     faction = EXCLUDED.faction,
                     updated_at = NOW()`,
      [cleanTerritoryId, player.id, soldierCount, player.faction]
    );
    const totalResult = await client.query(
      `SELECT COALESCE(SUM(contribution), 0) AS total_attackers
       FROM attack_contributions
       WHERE territory_id = $1 AND faction = $2`,
      [cleanTerritoryId, player.faction]
    );

    await client.query('COMMIT');
    return {
      created,
      sent: soldierCount,
      rally: publicRally({
        ...rally,
        total_attackers: totalResult.rows[0]?.total_attackers,
        my_contribution: soldierCount,
      }),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function getActiveRallies(client, { seasonId, playerId }) {
  const result = await client.query(
    `SELECT at.territory_id, at.faction, at.defender_faction, at.started_by,
            at.resolves_at,
            COALESCE(SUM(ac.contribution), 0) AS total_attackers,
            COALESCE(SUM(ac.contribution) FILTER (WHERE ac.player_id = $2), 0) AS my_contribution
     FROM attack_targets at
     LEFT JOIN attack_contributions ac ON ac.territory_id = at.territory_id AND ac.faction = at.faction
     WHERE at.season_id = $1
     GROUP BY at.id
     ORDER BY at.resolves_at, at.id`,
    [seasonId, playerId]
  );
  return result.rows.map(publicRally);
}

async function getExpiredRallyTerritoryIds(client, { now = new Date(), limit = 25 } = {}) {
  const result = await client.query(
    `SELECT territory_id
     FROM attack_targets
     WHERE resolves_at <= $1
     ORDER BY resolves_at, id
     LIMIT $2`,
    [now, limit]
  );
  return result.rows.map((row) => row.territory_id);
}

module.exports = {
  RALLY_DURATION_MS,
  getActiveRallies,
  getExpiredRallyTerritoryIds,
  publicRally,
  startOrJoinRally,
};
