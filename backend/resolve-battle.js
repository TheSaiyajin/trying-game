const { calculateBattleOutcome } = require('./game-logic');
const {
  applyDefenderCasualties,
  getLockedTerritoryDefenders,
  getTerritoryDefenseState,
  replaceTerritoryDefenders,
} = require('./defender-garrisons');
const { CAPITAL_ATTACK_ERROR, isCapitalTerritory } = require('./territory-protection');
const { recordBattleStats } = require('./player-season-stats');

function parsePositiveInt(value, fallback = 0, maxValue = 1000000) {
  const num = Number(value) || fallback;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(0, Math.floor(num)), maxValue);
}

async function resolveBattle(client, { player, territoryId, seasonId }) {
  const target = await client.query('SELECT * FROM territories WHERE id = $1', [territoryId]);
  const territory = target.rows[0];
  if (!territory) return { ok: false, status: 404, error: 'Territory not found.' };
  if (isCapitalTerritory(territory)) {
    return { ok: false, status: 403, error: CAPITAL_ATTACK_ERROR };
  }

  await client.query('BEGIN');
  try {
    const lockedTargetResult = await client.query('SELECT * FROM territories WHERE id = $1 FOR UPDATE', [territoryId]);
    const lockedTarget = lockedTargetResult.rows[0];
    if (!lockedTarget) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Territory not found.' };
    }
    if (isCapitalTerritory(lockedTarget)) {
      await client.query('ROLLBACK');
      return { ok: false, status: 403, error: CAPITAL_ATTACK_ERROR };
    }

    const totalContribution = await client.query(
      `SELECT COALESCE(SUM(contribution), 0) AS total FROM attack_contributions WHERE territory_id = $1 FOR UPDATE`,
      [territoryId]
    );
    const attackTotal = parsePositiveInt(totalContribution.rows[0]?.total || 0, 0, 100000);
    if (attackTotal <= 0) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'No attack contribution recorded for this target.' };
    }

    const lockedDefenders = await getLockedTerritoryDefenders(client, territoryId);
    const defenseState = getTerritoryDefenseState(lockedTarget.defense_troops, lockedDefenders);
    const defensePower = defenseState.totalDefenseTroops;
    const fortBonus = lockedTarget.is_fortress ? 1.2 : 1;
    const outcome = calculateBattleOutcome({ attackers: attackTotal, attackBonus: 1.1 }, { defenders: defensePower, defenseBonus: fortBonus });

    const ownerBefore = lockedTarget.owner_faction;
    const attackerFaction = player.faction || 'neutral';
    const defenderFaction = ownerBefore;
    const survivingAttackers = outcome.victory ? Math.max(1, outcome.attackersRemaining) : 0;
    const allocation = await applyDefenderCasualties(client, territoryId, defensePower, outcome.defendersLost, lockedDefenders);
    const remainingDefenders = outcome.victory ? 0 : allocation.defendersRemaining;

    if (outcome.victory) {
      await client.query(
        `UPDATE territories SET owner_faction = $1, defense_troops = $2, last_battle_at = NOW() WHERE id = $3`,
        [attackerFaction, survivingAttackers, territoryId]
      );
      await replaceTerritoryDefenders(client, territoryId, [{
        territory_id: territoryId,
        player_id: player.id,
        faction: attackerFaction,
        troops: survivingAttackers,
      }]);
      await client.query(
        `UPDATE players SET resource_food = resource_food + 25, resource_wood = resource_wood + 25, resource_iron = resource_iron + 25 WHERE id = $1`,
        [player.id]
      );
    } else {
      await client.query(
        `UPDATE territories SET defense_troops = $1, last_battle_at = NOW() WHERE id = $2`,
        [Math.max(1, remainingDefenders), territoryId]
      );
    }

    await client.query(
      `INSERT INTO battle_history (attacker_faction, defender_faction, territory_id, attacker_player_id, troops_sent, defender_total, applied_bonuses, winner, attackers_lost, attackers_surviving, defenders_lost, defenders_surviving, owner_before, owner_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [attackerFaction, defenderFaction, territoryId, player.id, attackTotal, defensePower, JSON.stringify({ fortBonus, attackBonus: 1.1 }), outcome.victory ? attackerFaction : defenderFaction, outcome.attackersLost, survivingAttackers, outcome.defendersLost, remainingDefenders, ownerBefore, outcome.victory ? attackerFaction : ownerBefore]
    );
    await recordBattleStats(client, {
      seasonId,
      territoryId,
      attackerPlayerId: player.id,
      attackerFaction,
      defenderFaction,
      lockedDefenders,
      allocation,
      outcome,
    });
    await client.query('DELETE FROM attack_contributions WHERE territory_id = $1', [territoryId]);
    await client.query(
      `INSERT INTO admin_actions (actor_id, action_name, action_detail) VALUES ($1, $2, $3)`,
      [player.id, 'battle_resolution', JSON.stringify({ territoryId, outcome })]
    );
    await client.query('COMMIT');
    return { ok: true, outcome };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = {
  resolveBattle,
};
