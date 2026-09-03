const {
  BATTLE_PROTECTION_MS,
  BATTLE_ROUND_MS,
  calculateBattleRound,
} = require('./battle-rules');
const {
  applyDefenderCasualties,
  getLockedTerritoryDefenders,
  getTerritoryDefenseState,
  replaceTerritoryDefenders,
} = require('./defender-garrisons');
const { distributeProportionally, recordRallyBattleStats } = require('./player-season-stats');
const { CAPITAL_ATTACK_ERROR, isCapitalTerritory } = require('./territory-protection');
const { activateLockedRally, loadBattleBonuses } = require('./rally-battles');

async function cancelRally(client, territoryId, reason) {
  await client.query(
    `UPDATE players p SET soldiers = p.soldiers + refunds.troops
     FROM (
       SELECT player_id, SUM(contribution)::integer AS troops
       FROM attack_contributions WHERE territory_id = $1 GROUP BY player_id
     ) refunds WHERE p.id = refunds.player_id`,
    [territoryId]
  );
  await client.query('DELETE FROM battle_defender_contributions WHERE territory_id = $1', [territoryId]);
  await client.query('DELETE FROM attack_contributions WHERE territory_id = $1', [territoryId]);
  await client.query('DELETE FROM attack_targets WHERE territory_id = $1', [territoryId]);
  return { ok: false, cancelled: true, reason };
}

function sumAttackers(contributors) {
  return contributors.reduce((sum, row) => sum + Math.max(0, Number(row.contribution) || 0), 0);
}

async function applyAttackerCasualties(client, territoryId, contributors, casualties) {
  const before = sumAttackers(contributors);
  const remaining = Math.max(0, before - Math.min(before, Math.max(0, Math.floor(Number(casualties) || 0))));
  const shares = distributeProportionally(
    remaining,
    contributors.map((row) => ({ player_id: row.player_id, troops: row.contribution }))
  );
  for (const contributor of contributors) {
    const troops = shares.get(Number(contributor.player_id)) || 0;
    contributor.contribution = troops;
    await client.query(
      'UPDATE attack_contributions SET contribution = $1, updated_at = NOW() WHERE territory_id = $2 AND player_id = $3',
      [troops, territoryId, contributor.player_id]
    );
  }
  return remaining;
}

async function getDefenderParticipants(client, territoryId) {
  const result = await client.query(
    `SELECT territory_id, player_id, faction, contribution AS troops
     FROM battle_defender_contributions WHERE territory_id = $1 ORDER BY player_id`,
    [territoryId]
  );
  return result.rows;
}

async function finalizeBattle(client, {
  rally,
  territory,
  contributors,
  currentDefenders,
  attackersRemaining,
  defendersRemaining,
  attackersLost,
  defendersLost,
  now,
  attackBonus,
  defenseBonus,
}) {
  // The attacker must eliminate every defender before the time limit. A mutual
  // wipe or any defenders remaining at the deadline counts as a successful defense.
  const victory = defendersRemaining <= 0 && attackersRemaining > 0;
  const starterId = Number(rally.started_by) || Number(contributors[0]?.player_id);
  const protectedUntil = new Date(now.getTime() + BATTLE_PROTECTION_MS);
  const initialAttackers = contributors.reduce(
    (sum, row) => sum + Math.max(0, Number(row.initial_contribution) || 0),
    0
  );
  const initialDefenders = defendersRemaining + defendersLost;

  if (victory) {
    const survivingGarrisons = contributors
      .map((row) => ({
        territory_id: rally.territory_id,
        player_id: Number(row.player_id),
        faction: rally.faction,
        troops: Math.max(0, Number(row.contribution) || 0),
      }))
      .filter((row) => row.troops > 0);
    await client.query(
      `UPDATE territories
       SET owner_faction = $1, defense_troops = $2, last_battle_at = $3, protected_until = $4
       WHERE id = $5`,
      [rally.faction, attackersRemaining, now, protectedUntil, rally.territory_id]
    );
    await replaceTerritoryDefenders(client, rally.territory_id, survivingGarrisons);
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
      `UPDATE players p SET soldiers = p.soldiers + refunds.troops
       FROM (
         SELECT player_id, contribution AS troops
         FROM attack_contributions WHERE territory_id = $1 AND contribution > 0
       ) refunds WHERE p.id = refunds.player_id`,
      [rally.territory_id]
    );
    await client.query(
      `UPDATE territories
       SET defense_troops = $1, last_battle_at = $2, protected_until = $3
       WHERE id = $4`,
      [defendersRemaining, now, protectedUntil, rally.territory_id]
    );
  }

  const outcome = {
    victory,
    attackPower: initialAttackers,
    defensePower: initialDefenders,
    attackersLost,
    attackersRemaining,
    defendersLost,
    defendersRemaining,
  };
  await client.query(
    `INSERT INTO battle_history
       (attacker_faction, defender_faction, territory_id, attacker_player_id,
        troops_sent, defender_total, applied_bonuses, winner, attackers_lost,
        attackers_surviving, defenders_lost, defenders_surviving, owner_before, owner_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      rally.faction,
      rally.defender_faction,
      rally.territory_id,
      starterId,
      initialAttackers,
      initialDefenders,
      JSON.stringify({
        mode: 'live_battle',
        durationMinutes: 20,
        roundSeconds: 60,
        attackBonus,
        defenseBonus,
      }),
      victory ? rally.faction : rally.defender_faction,
      attackersLost,
      attackersRemaining,
      defendersLost,
      defendersRemaining,
      rally.defender_faction,
      victory ? rally.faction : rally.defender_faction,
    ]
  );

  const defenderParticipants = await getDefenderParticipants(client, rally.territory_id);
  await recordRallyBattleStats(client, {
    seasonId: Number(rally.season_id),
    territoryId: rally.territory_id,
    attackerPlayerId: starterId,
    attackerFaction: rally.faction,
    defenderFaction: rally.defender_faction,
    attackContributors: contributors.map((row) => ({
      ...row,
      contribution: Number(row.initial_contribution) || Number(row.contribution) || 0,
    })),
    lockedDefenders: defenderParticipants,
    allocation: { survivors: currentDefenders, defendersRemaining },
    outcome,
  });
  await client.query('DELETE FROM battle_defender_contributions WHERE territory_id = $1', [rally.territory_id]);
  await client.query('DELETE FROM attack_contributions WHERE territory_id = $1', [rally.territory_id]);
  await client.query('DELETE FROM attack_targets WHERE territory_id = $1', [rally.territory_id]);
  return {
    ok: true,
    resolved: true,
    territoryId: rally.territory_id,
    attackerFaction: rally.faction,
    defenderFaction: rally.defender_faction,
    protectedUntil,
    outcome,
  };
}

async function resolveBattle(client, { territoryId, now = new Date() }) {
  await client.query('BEGIN');
  try {
    const rallyResult = await client.query(
      'SELECT * FROM attack_targets WHERE territory_id = $1 FOR UPDATE SKIP LOCKED',
      [territoryId]
    );
    let rally = rallyResult.rows[0];
    if (!rally) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'No active attack for this territory.' };
    }

    const territoryResult = await client.query('SELECT * FROM territories WHERE id = $1 FOR UPDATE', [territoryId]);
    const territory = territoryResult.rows[0];
    if (!territory || isCapitalTerritory(territory)) {
      const cancelled = await cancelRally(client, territoryId, territory ? CAPITAL_ATTACK_ERROR : 'Territory no longer exists.');
      await client.query('COMMIT');
      return cancelled;
    }
    if (territory.owner_faction !== rally.defender_faction) {
      const cancelled = await cancelRally(client, territoryId, 'Territory ownership changed.');
      await client.query('COMMIT');
      return cancelled;
    }

    if ((rally.phase || 'rally') === 'rally') {
      if (new Date(rally.resolves_at).getTime() > now.getTime()) {
        await client.query('ROLLBACK');
        return { ok: false, status: 409, error: 'The hidden rally is still preparing.' };
      }
      rally = await activateLockedRally(client, rally, territory, now);
      await client.query('COMMIT');
      return { ok: true, launched: true, territoryId };
    }

    const contributionResult = await client.query(
      `SELECT player_id, contribution, initial_contribution, faction
       FROM attack_contributions
       WHERE territory_id = $1 AND faction = $2 ORDER BY player_id FOR UPDATE`,
      [territoryId, rally.faction]
    );
    const contributors = contributionResult.rows;
    let attackersRemaining = sumAttackers(contributors);
    let currentDefenders = await getLockedTerritoryDefenders(client, territoryId);
    let defenseState = getTerritoryDefenseState(territory.defense_troops, currentDefenders);
    let defendersRemaining = defenseState.totalDefenseTroops;
    let attackersLost = Number(rally.attackers_lost || 0);
    let defendersLost = Number(rally.defenders_lost || 0);
    let roundNumber = Number(rally.round_number || 0);
    let nextTickAt = new Date(rally.next_tick_at);
    const resolvesAt = new Date(rally.resolves_at);
    const bonuses = await loadBattleBonuses(client, rally.faction, rally.defender_faction);
    let roundsProcessed = 0;

    while (
      Number.isFinite(nextTickAt.getTime())
      && nextTickAt.getTime() <= now.getTime()
      && nextTickAt.getTime() <= resolvesAt.getTime()
      && attackersRemaining > 0
      && defendersRemaining > 0
    ) {
      const losses = calculateBattleRound({
        attackers: attackersRemaining,
        defenders: defendersRemaining,
        attackBonus: bonuses.attackBonus,
        defenseBonus: bonuses.defenseBonus,
      });
      attackersRemaining = await applyAttackerCasualties(client, territoryId, contributors, losses.attackersLost);
      const allocation = await applyDefenderCasualties(
        client,
        territoryId,
        defendersRemaining,
        losses.defendersLost,
        currentDefenders
      );
      currentDefenders = allocation.survivors;
      defendersRemaining = allocation.defendersRemaining;
      await client.query('UPDATE territories SET defense_troops = $1 WHERE id = $2', [defendersRemaining, territoryId]);
      attackersLost += losses.attackersLost;
      defendersLost += losses.defendersLost;
      roundNumber += 1;
      roundsProcessed += 1;
      nextTickAt = new Date(nextTickAt.getTime() + BATTLE_ROUND_MS);
    }

    const deadlineReached = resolvesAt.getTime() <= now.getTime();
    if (attackersRemaining <= 0 || defendersRemaining <= 0 || deadlineReached) {
      const result = await finalizeBattle(client, {
        rally,
        territory,
        contributors,
        currentDefenders,
        attackersRemaining,
        defendersRemaining,
        attackersLost,
        defendersLost,
        now,
        attackBonus: bonuses.attackBonus,
        defenseBonus: bonuses.defenseBonus,
      });
      await client.query('COMMIT');
      return { ...result, roundsProcessed };
    }

    await client.query(
      `UPDATE attack_targets
       SET next_tick_at = $2, round_number = $3, attackers_lost = $4,
           defenders_lost = $5, attack_bonus = $6, defense_bonus = $7
       WHERE territory_id = $1`,
      [
        territoryId,
        nextTickAt,
        roundNumber,
        attackersLost,
        defendersLost,
        bonuses.attackBonus,
        bonuses.defenseBonus,
      ]
    );
    await client.query('COMMIT');
    return { ok: true, advanced: roundsProcessed > 0, roundsProcessed, territoryId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = {
  applyAttackerCasualties,
  cancelRally,
  finalizeBattle,
  resolveBattle,
  sumAttackers,
};
