const { calculateBattleOutcome } = require('./game-logic');
const { applyDefenderCasualties, replaceTerritoryDefenders } = require('./defender-garrisons');

// Thrown for any expected/validated failure so the route can map it to the right
// HTTP status (400/403/404/409) instead of falling through to a generic 500.
class AttackError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AttackError';
    this.status = status;
  }
}

function toSoldierCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return NaN;
  return Math.floor(num);
}

/**
 * Resolves an attack against a territory using only troop counts.
 * `client` must be a dedicated (non-pooled) connection so BEGIN/COMMIT/ROLLBACK
 * and the advisory lock apply to this request only.
 */
async function performAttack(client, { playerId, territoryId, soldiers }) {
  const cleanTerritoryId = typeof territoryId === 'string' ? territoryId.trim() : '';
  if (!cleanTerritoryId) {
    throw new AttackError(400, 'Target territory required.');
  }

  const soldierCount = toSoldierCount(soldiers);
  if (!Number.isFinite(soldierCount) || soldierCount <= 0) {
    throw new AttackError(400, 'Attack must send at least one soldier.');
  }

  const playerResult = await client.query('SELECT * FROM players WHERE id = $1', [playerId]);
  const player = playerResult.rows[0];
  if (!player) throw new AttackError(404, 'Player not found.');
  if (!player.faction) throw new AttackError(403, 'Choose a faction before attacking.');

  const targetResult = await client.query('SELECT * FROM territories WHERE id = $1', [cleanTerritoryId]);
  const target = targetResult.rows[0];
  if (!target) throw new AttackError(404, 'Territory not found.');
  if ((target.owner_faction || 'neutral') === player.faction) {
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

  if (Number(player.soldiers) < soldierCount) {
    throw new AttackError(400, 'Not enough soldiers to send.');
  }

  await client.query('BEGIN');
  try {
    // Advisory lock scoped to this transaction: a concurrent attack on the same
    // territory fails fast with 409 instead of racing on the same row updates.
    const lockResult = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [cleanTerritoryId]);
    const acquiredLock = lockResult.rows[0] ? Boolean(lockResult.rows[0].locked) : true;
    if (!acquiredLock) {
      throw new AttackError(409, 'An attack on this territory is already in progress.');
    }

    const lockedPlayerResult = await client.query('SELECT soldiers FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    const lockedPlayer = lockedPlayerResult.rows[0];
    if (!lockedPlayer) throw new AttackError(404, 'Player not found.');
    if (Number(lockedPlayer.soldiers) < soldierCount) {
      throw new AttackError(400, 'Not enough soldiers to send.');
    }

    const lockedTargetResult = await client.query('SELECT * FROM territories WHERE id = $1 FOR UPDATE', [cleanTerritoryId]);
    const lockedTarget = lockedTargetResult.rows[0];
    if (!lockedTarget) throw new AttackError(404, 'Territory not found.');
    if ((lockedTarget.owner_faction || 'neutral') === player.faction) {
      throw new AttackError(403, 'You cannot attack your own territory.');
    }

    await client.query(
      `UPDATE players SET soldiers = soldiers - $1, last_action_at = NOW() WHERE id = $2`,
      [soldierCount, playerId]
    );

    const defensePower = Math.max(0, Math.floor(Number(lockedTarget.defense_troops) || 0));
    const outcome = calculateBattleOutcome({ attackers: soldierCount }, { defenders: defensePower });
    const ownerBefore = lockedTarget.owner_faction || 'neutral';
    const attackerFaction = player.faction;
    const defenderFaction = ownerBefore;
    const allocation = await applyDefenderCasualties(client, cleanTerritoryId, outcome.defendersLost);
    const remainingDefenders = outcome.victory
      ? 0
      : (allocation.survivors.length ? allocation.defendersRemaining : Math.max(0, defensePower - outcome.defendersLost));

    if (outcome.victory) {
      await client.query(
        `UPDATE territories SET owner_faction = $1, defense_troops = $2, last_battle_at = NOW() WHERE id = $3`,
        [attackerFaction, outcome.attackersRemaining, cleanTerritoryId]
      );
      await replaceTerritoryDefenders(client, cleanTerritoryId, [{
        territory_id: cleanTerritoryId,
        player_id: playerId,
        faction: attackerFaction,
        troops: outcome.attackersRemaining,
      }]);
      await client.query(
        `UPDATE players SET resource_food = resource_food + 25, resource_wood = resource_wood + 25, resource_iron = resource_iron + 25 WHERE id = $1`,
        [playerId]
      );
    } else {
      await client.query(
        `UPDATE territories SET defense_troops = $1, last_battle_at = NOW() WHERE id = $2`,
        [remainingDefenders, cleanTerritoryId]
      );
    }

    await client.query(
      `INSERT INTO battle_history (attacker_faction, defender_faction, territory_id, attacker_player_id, troops_sent, defender_total, applied_bonuses, winner, attackers_lost, attackers_surviving, defenders_lost, defenders_surviving, owner_before, owner_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        attackerFaction,
        defenderFaction,
        cleanTerritoryId,
        playerId,
        soldierCount,
        defensePower,
        JSON.stringify({ mode: 'troop_count_only' }),
        outcome.victory ? attackerFaction : defenderFaction,
        outcome.attackersLost,
        outcome.attackersRemaining,
        outcome.defendersLost,
        remainingDefenders,
        ownerBefore,
        outcome.victory ? attackerFaction : ownerBefore,
      ]
    );

    await client.query('COMMIT');
    return { outcome, territoryId: cleanTerritoryId, sent: soldierCount };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // The original error is what matters; swallow rollback failure to avoid masking it.
    }
    throw error;
  }
}

module.exports = { AttackError, performAttack };
