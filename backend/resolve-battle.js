const { calculateBattleOutcome } = require('./game-logic');
const {
  applyDefenderCasualties,
  getLockedTerritoryDefenders,
  getTerritoryDefenseState,
  replaceTerritoryDefenders,
} = require('./defender-garrisons');
const { distributeProportionally, recordRallyBattleStats } = require('./player-season-stats');
const { CAPITAL_ATTACK_ERROR, isCapitalTerritory } = require('./territory-protection');

async function cancelRally(client, territoryId, reason) {
  await client.query(
    `UPDATE players p
     SET soldiers = p.soldiers + refunds.troops
     FROM (
       SELECT player_id, SUM(contribution)::integer AS troops
       FROM attack_contributions
       WHERE territory_id = $1
       GROUP BY player_id
     ) refunds
     WHERE p.id = refunds.player_id`,
    [territoryId]
  );
  await client.query('DELETE FROM attack_contributions WHERE territory_id = $1', [territoryId]);
  await client.query('DELETE FROM attack_targets WHERE territory_id = $1', [territoryId]);
  return { ok: false, cancelled: true, reason };
}

async function resolveBattle(client, { territoryId, now = new Date(), force = false }) {
  await client.query('BEGIN');
  try {
    const rallyResult = await client.query(
      'SELECT * FROM attack_targets WHERE territory_id = $1 FOR UPDATE SKIP LOCKED',
      [territoryId]
    );
    const rally = rallyResult.rows[0];
    if (!rally) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'No active rally for this territory.' };
    }
    if (!force && new Date(rally.resolves_at).getTime() > now.getTime()) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'This rally is still gathering troops.' };
    }

    const targetResult = await client.query('SELECT * FROM territories WHERE id = $1 FOR UPDATE', [territoryId]);
    const territory = targetResult.rows[0];
    if (!territory || isCapitalTerritory(territory)) {
      const cancelled = await cancelRally(
        client,
        territoryId,
        territory ? CAPITAL_ATTACK_ERROR : 'Territory no longer exists.'
      );
      await client.query('COMMIT');
      return cancelled;
    }
    if (territory.owner_faction !== rally.defender_faction) {
      const cancelled = await cancelRally(client, territoryId, 'Territory ownership changed.');
      await client.query('COMMIT');
      return cancelled;
    }

    const contributionResult = await client.query(
      `SELECT player_id, contribution, faction
       FROM attack_contributions
       WHERE territory_id = $1 AND faction = $2
       ORDER BY player_id
       FOR UPDATE`,
      [territoryId, rally.faction]
    );
    const contributors = contributionResult.rows.filter((row) => Number(row.contribution) > 0);
    const attackTotal = contributors.reduce((sum, row) => sum + Number(row.contribution), 0);
    if (attackTotal <= 0) {
      await client.query('DELETE FROM attack_targets WHERE territory_id = $1', [territoryId]);
      await client.query('COMMIT');
      return { ok: false, cancelled: true, reason: 'Rally had no troops.' };
    }

    const lockedDefenders = await getLockedTerritoryDefenders(client, territoryId);
    const defenseState = getTerritoryDefenseState(territory.defense_troops, lockedDefenders);
    const defensePower = defenseState.totalDefenseTroops;
    const outcome = calculateBattleOutcome({ attackers: attackTotal }, { defenders: defensePower });
    const allocation = await applyDefenderCasualties(
      client,
      territoryId,
      defensePower,
      outcome.defendersLost,
      lockedDefenders
    );
    const remainingDefenders = outcome.victory ? 0 : allocation.defendersRemaining;
    const starterId = Number(rally.started_by) || Number(contributors[0].player_id);

    if (outcome.victory) {
      const survivorShares = distributeProportionally(
        outcome.attackersRemaining,
        contributors.map((row) => ({ player_id: row.player_id, troops: row.contribution }))
      );
      const survivingGarrisons = contributors
        .map((row) => ({
          territory_id: territoryId,
          player_id: Number(row.player_id),
          faction: rally.faction,
          troops: survivorShares.get(Number(row.player_id)) || 0,
        }))
        .filter((row) => row.troops > 0);

      await client.query(
        `UPDATE territories
         SET owner_faction = $1, defense_troops = $2, last_battle_at = NOW()
         WHERE id = $3`,
        [rally.faction, outcome.attackersRemaining, territoryId]
      );
      await replaceTerritoryDefenders(client, territoryId, survivingGarrisons);
      await client.query(
        `UPDATE players
         SET resource_food = resource_food + 25,
             resource_wood = resource_wood + 25,
             resource_iron = resource_iron + 25
         WHERE id = $1`,
        [starterId]
      );
    } else {
      await client.query(
        `UPDATE territories SET defense_troops = $1, last_battle_at = NOW() WHERE id = $2`,
        [remainingDefenders, territoryId]
      );
    }

    await client.query(
      `INSERT INTO battle_history
         (attacker_faction, defender_faction, territory_id, attacker_player_id,
          troops_sent, defender_total, applied_bonuses, winner, attackers_lost,
          attackers_surviving, defenders_lost, defenders_surviving, owner_before, owner_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        rally.faction,
        rally.defender_faction,
        territoryId,
        starterId,
        attackTotal,
        defensePower,
        JSON.stringify({ mode: 'timed_rally', durationMinutes: 10 }),
        outcome.victory ? rally.faction : rally.defender_faction,
        outcome.attackersLost,
        outcome.attackersRemaining,
        outcome.defendersLost,
        remainingDefenders,
        rally.defender_faction,
        outcome.victory ? rally.faction : rally.defender_faction,
      ]
    );
    await recordRallyBattleStats(client, {
      seasonId: Number(rally.season_id),
      territoryId,
      attackerPlayerId: starterId,
      attackerFaction: rally.faction,
      defenderFaction: rally.defender_faction,
      attackContributors: contributors,
      lockedDefenders,
      allocation,
      outcome,
    });
    await client.query('DELETE FROM attack_contributions WHERE territory_id = $1', [territoryId]);
    await client.query('DELETE FROM attack_targets WHERE territory_id = $1', [territoryId]);
    await client.query('COMMIT');
    return {
      ok: true,
      territoryId,
      attackerFaction: rally.faction,
      defenderFaction: rally.defender_faction,
      outcome,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { cancelRally, resolveBattle };
