const { AttackError } = require('./attack-logic');
const {
  BATTLE_DURATION_MS,
  BATTLE_ROUND_MS,
  RALLY_PREPARATION_MS,
  getProtectionRemainingMs,
} = require('./battle-rules');
const { CAPITAL_ATTACK_ERROR, isCapitalTerritory } = require('./territory-protection');
const { getFactionTerritoryBonuses } = require('./game-logic');

const RALLY_DURATION_MS = RALLY_PREPARATION_MS;

function toSoldierCount(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.floor(num) : NaN;
}

function publicRally(row) {
  return {
    territoryId: row.territory_id,
    attackerFaction: row.faction,
    defenderFaction: row.defender_faction,
    startedBy: row.started_by === null ? null : Number(row.started_by),
    phase: row.phase || 'rally',
    resolvesAt: row.resolves_at,
    nextTickAt: row.next_tick_at || null,
    roundNumber: Number(row.round_number || 0),
    totalAttackers: Number(row.total_attackers || 0),
    myContribution: Number(row.my_contribution || 0),
    attackersLost: Number(row.attackers_lost || 0),
    defendersLost: Number(row.defenders_lost || 0),
    attackBonus: Number(row.attack_bonus || 0),
    defenseBonus: Number(row.defense_bonus || 0),
  };
}

async function snapshotDefenderParticipants(client, territoryId, defenderFaction) {
  await client.query('DELETE FROM battle_defender_contributions WHERE territory_id = $1', [territoryId]);
  await client.query(
    `INSERT INTO battle_defender_contributions (territory_id, player_id, faction, contribution)
     SELECT territory_id, player_id, faction, troops
     FROM territory_defenders
     WHERE territory_id = $1 AND faction = $2 AND troops > 0
     ON CONFLICT (territory_id, player_id)
     DO UPDATE SET contribution = EXCLUDED.contribution, faction = EXCLUDED.faction`,
    [territoryId, defenderFaction]
  );
}

async function loadBattleBonuses(client, attackerFaction, defenderFaction) {
  const result = await client.query(
    `SELECT t.*,
            EXISTS (
              SELECT 1 FROM attack_targets at
              WHERE at.territory_id = t.id AND at.phase = 'active'
            ) AS contested
     FROM territories t`
  );
  return {
    attackBonus: getFactionTerritoryBonuses(result.rows, attackerFaction).attack,
    defenseBonus: getFactionTerritoryBonuses(result.rows, defenderFaction).defense,
  };
}

async function activateLockedRally(client, rally, territory, now) {
  if (!territory || territory.owner_faction !== rally.defender_faction || isCapitalTerritory(territory)) {
    throw new AttackError(409, 'The target can no longer be attacked.');
  }
  const countResult = await client.query(
    `SELECT COALESCE(SUM(contribution), 0) AS total
     FROM attack_contributions WHERE territory_id = $1 AND faction = $2`,
    [rally.territory_id, rally.faction]
  );
  if (Number(countResult.rows[0]?.total || 0) <= 0) throw new AttackError(409, 'The rally has no troops.');

  await snapshotDefenderParticipants(client, rally.territory_id, rally.defender_faction);
  const resolvesAt = new Date(now.getTime() + BATTLE_DURATION_MS);
  const nextTickAt = new Date(now.getTime() + BATTLE_ROUND_MS);
  await client.query(
    `UPDATE attack_targets
     SET phase = 'active', battle_started_at = $2, resolves_at = $3,
         next_tick_at = $4, round_number = 0
     WHERE territory_id = $1 RETURNING *`,
    [rally.territory_id, now, resolvesAt, nextTickAt]
  );
  const bonuses = await loadBattleBonuses(client, rally.faction, rally.defender_faction);
  const result = await client.query(
    `UPDATE attack_targets SET attack_bonus = $2, defense_bonus = $3
     WHERE territory_id = $1 RETURNING *`,
    [rally.territory_id, bonuses.attackBonus, bonuses.defenseBonus]
  );
  return result.rows[0] || {
    ...rally,
    phase: 'active',
    battle_started_at: now,
    resolves_at: resolvesAt,
    next_tick_at: nextTickAt,
    round_number: 0,
    attack_bonus: bonuses.attackBonus,
    defense_bonus: bonuses.defenseBonus,
  };
}

async function launchRally(client, { territoryId, playerId, now = new Date(), automatic = false }) {
  await client.query('BEGIN');
  try {
    const rallyResult = await client.query(
      'SELECT * FROM attack_targets WHERE territory_id = $1 FOR UPDATE',
      [territoryId]
    );
    const rally = rallyResult.rows[0];
    if (!rally) throw new AttackError(404, 'No rally exists for this territory.');
    if ((rally.phase || 'rally') !== 'rally') throw new AttackError(409, 'The battle has already started.');
    if (!automatic && Number(rally.started_by) !== Number(playerId)) {
      throw new AttackError(403, 'Only the rally starter can launch early.');
    }
    const territoryResult = await client.query('SELECT * FROM territories WHERE id = $1 FOR UPDATE', [territoryId]);
    const activated = await activateLockedRally(client, rally, territoryResult.rows[0], now);
    await client.query('COMMIT');
    return { ok: true, launched: true, rally: publicRally(activated) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function startOrJoinRally(client, {
  playerId,
  territoryId,
  soldiers,
  seasonId,
  mode = 'rally',
  now = new Date(),
}) {
  const cleanTerritoryId = typeof territoryId === 'string' ? territoryId.trim() : '';
  if (!cleanTerritoryId) throw new AttackError(400, 'Target territory required.');
  if (!['rally', 'solo'].includes(mode)) throw new AttackError(400, 'Choose a solo attack or rally.');

  const soldierCount = toSoldierCount(soldiers);
  if (!Number.isFinite(soldierCount) || soldierCount <= 0) throw new AttackError(400, 'Send at least one soldier.');

  await client.query('BEGIN');
  try {
    const lockResult = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [cleanTerritoryId]);
    const acquiredLock = lockResult.rows[0] ? Boolean(lockResult.rows[0].locked) : true;
    if (!acquiredLock) throw new AttackError(409, 'This territory is busy. Try again.');

    const activeResult = await client.query('SELECT * FROM attack_targets WHERE territory_id = $1 FOR UPDATE', [cleanTerritoryId]);
    let rally = activeResult.rows[0] || null;
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
    if (ownerFaction === 'neutral') throw new AttackError(409, 'This territory is neutral. Attack it directly.');
    if (ownerFaction === player.faction) throw new AttackError(403, 'You cannot attack your own territory.');

    const adjacent = await client.query(
      `SELECT 1 FROM territory_neighbors n
       INNER JOIN territories t ON t.id = n.territory_id
       WHERE n.neighbor_id = $1 AND t.owner_faction = $2 LIMIT 1`,
      [cleanTerritoryId, player.faction]
    );
    if (!adjacent.rowCount) throw new AttackError(403, 'This territory is not adjacent to your faction.');

    const created = !rally;
    if (rally) {
      if (Number(rally.season_id) !== Number(seasonId)) throw new AttackError(409, 'This attack belongs to an expired season.');
      if (rally.faction !== player.faction) throw new AttackError(409, 'This territory cannot be attacked right now.');
      if (rally.defender_faction !== ownerFaction) throw new AttackError(409, 'Territory ownership changed.');
      if (new Date(rally.resolves_at).getTime() <= now.getTime()) {
        throw new AttackError(409, 'This attack is advancing to its next phase. Try again shortly.');
      }
    } else {
      const protectionMs = getProtectionRemainingMs(target.protected_until, now);
      if (protectionMs > 0) {
        throw new AttackError(409, `This territory is protected for ${Math.ceil(protectionMs / 60000)} more minutes.`);
      }
      const immediate = mode === 'solo';
      const phaseEndsAt = new Date(now.getTime() + (immediate ? BATTLE_DURATION_MS : RALLY_PREPARATION_MS));
      const nextTickAt = immediate ? new Date(now.getTime() + BATTLE_ROUND_MS) : null;
      const insertResult = await client.query(
        `INSERT INTO attack_targets
           (faction, territory_id, started_by, defender_faction, season_id, created_at,
            resolves_at, phase, battle_started_at, next_tick_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          player.faction, cleanTerritoryId, player.id, ownerFaction, seasonId, now,
          phaseEndsAt, immediate ? 'active' : 'rally', immediate ? now : null, nextTickAt,
        ]
      );
      rally = insertResult.rows[0] || {
        faction: player.faction,
        territory_id: cleanTerritoryId,
        started_by: player.id,
        defender_faction: ownerFaction,
        season_id: seasonId,
        created_at: now,
        resolves_at: phaseEndsAt,
        phase: immediate ? 'active' : 'rally',
        battle_started_at: immediate ? now : null,
        next_tick_at: nextTickAt,
      };
      if (immediate) {
        await snapshotDefenderParticipants(client, cleanTerritoryId, ownerFaction);
        const bonuses = await loadBattleBonuses(client, player.faction, ownerFaction);
        const bonusResult = await client.query(
          `UPDATE attack_targets SET attack_bonus = $2, defense_bonus = $3
           WHERE territory_id = $1 RETURNING *`,
          [cleanTerritoryId, bonuses.attackBonus, bonuses.defenseBonus]
        );
        rally = bonusResult.rows[0] || { ...rally, attack_bonus: bonuses.attackBonus, defense_bonus: bonuses.defenseBonus };
      }
    }

    await client.query('UPDATE players SET soldiers = soldiers - $1, last_action_at = NOW() WHERE id = $2', [soldierCount, player.id]);
    await client.query(
      `INSERT INTO attack_contributions
         (territory_id, player_id, contribution, initial_contribution, faction)
       VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT (territory_id, player_id)
       DO UPDATE SET contribution = attack_contributions.contribution + EXCLUDED.contribution,
                     initial_contribution = attack_contributions.initial_contribution + EXCLUDED.initial_contribution,
                     faction = EXCLUDED.faction, updated_at = NOW()`,
      [cleanTerritoryId, player.id, soldierCount, player.faction]
    );
    const totalResult = await client.query(
      `SELECT COALESCE(SUM(contribution), 0) AS total_attackers
       FROM attack_contributions WHERE territory_id = $1 AND faction = $2`,
      [cleanTerritoryId, player.faction]
    );
    await client.query('COMMIT');
    return {
      created,
      sent: soldierCount,
      rally: publicRally({ ...rally, total_attackers: totalResult.rows[0]?.total_attackers, my_contribution: soldierCount }),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function getActiveRallies(client, { seasonId, playerId, playerFaction }) {
  const result = await client.query(
    `SELECT at.*,
            COALESCE(SUM(ac.contribution), 0) AS total_attackers,
            COALESCE(SUM(ac.contribution) FILTER (WHERE ac.player_id = $2), 0) AS my_contribution
     FROM attack_targets at
     LEFT JOIN attack_contributions ac ON ac.territory_id = at.territory_id AND ac.faction = at.faction
     WHERE at.season_id = $1 AND (at.phase = 'active' OR at.faction = $3)
     GROUP BY at.id ORDER BY at.resolves_at, at.id`,
    [seasonId, playerId, playerFaction]
  );
  return result.rows.map(publicRally);
}

async function getDueBattleTerritoryIds(client, { now = new Date(), limit = 25 } = {}) {
  const result = await client.query(
    `SELECT territory_id FROM attack_targets
     WHERE (phase = 'rally' AND resolves_at <= $1)
        OR (phase = 'active' AND (next_tick_at <= $1 OR resolves_at <= $1))
     ORDER BY LEAST(resolves_at, COALESCE(next_tick_at, resolves_at)), id LIMIT $2`,
    [now, limit]
  );
  return result.rows.map((row) => row.territory_id);
}

module.exports = {
  RALLY_DURATION_MS,
  activateLockedRally,
  getActiveRallies,
  getDueBattleTerritoryIds,
  getExpiredRallyTerritoryIds: getDueBattleTerritoryIds,
  launchRally,
  loadBattleBonuses,
  publicRally,
  snapshotDefenderParticipants,
  startOrJoinRally,
};
