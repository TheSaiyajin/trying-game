function sumStationedDefenders(defenders) {
  return defenders.reduce((total, defender) => total + Math.max(0, Math.floor(Number(defender.troops) || 0)), 0);
}

function sanitizeTroopCount(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function getTerritoryDefenseState(totalDefenseTroops, defenders) {
  const stationedTroops = sumStationedDefenders(defenders);
  const totalTroops = Math.max(sanitizeTroopCount(totalDefenseTroops), stationedTroops);
  return {
    totalDefenseTroops: totalTroops,
    stationedTroops,
    baseDefenseTroops: totalTroops - stationedTroops,
  };
}

function allocateDefenderCasualties(defenders, casualties) {
  const sanitizedDefenders = defenders.map((defender) => ({
    territory_id: defender.territory_id,
    player_id: defender.player_id,
    faction: defender.faction,
    troops: sanitizeTroopCount(defender.troops),
  })).filter((defender) => defender.troops > 0);
  const totalDefenders = sumStationedDefenders(sanitizedDefenders);
  const totalCasualties = Math.min(sanitizeTroopCount(casualties), totalDefenders);

  if (!sanitizedDefenders.length || totalCasualties <= 0) {
    return {
      survivors: sanitizedDefenders,
      defendersLost: 0,
      defendersRemaining: totalDefenders,
    };
  }

  const provisional = sanitizedDefenders.map((defender, index) => {
    const exactLoss = (defender.troops * totalCasualties) / totalDefenders;
    const loss = Math.min(defender.troops, Math.floor(exactLoss));
    return {
      ...defender,
      index,
      exactLoss,
      loss,
      remainder: exactLoss - loss,
    };
  });

  let assignedLosses = provisional.reduce((total, defender) => total + defender.loss, 0);
  if (assignedLosses < totalCasualties) {
    const ranked = [...provisional].sort((left, right) => {
      if (right.remainder !== left.remainder) return right.remainder - left.remainder;
      if (right.troops !== left.troops) return right.troops - left.troops;
      return left.index - right.index;
    });

    for (const defender of ranked) {
      if (assignedLosses >= totalCasualties) break;
      if (defender.loss >= defender.troops) continue;
      defender.loss += 1;
      assignedLosses += 1;
    }
  }

  const survivors = provisional
    .map((defender) => ({
      territory_id: defender.territory_id,
      player_id: defender.player_id,
      faction: defender.faction,
      troops: defender.troops - defender.loss,
    }))
    .filter((defender) => defender.troops > 0);

  return {
    survivors,
    defendersLost: assignedLosses,
    defendersRemaining: sumStationedDefenders(survivors),
  };
}

async function getLockedTerritoryDefenders(client, territoryId) {
  const stationedResult = await client.query(
    `SELECT territory_id, player_id, faction, troops
     FROM territory_defenders
     WHERE territory_id = $1
     ORDER BY player_id
     FOR UPDATE`,
    [territoryId]
  );
  return stationedResult.rows;
}

function resolveDefenderCasualties(totalDefenseTroops, defenders, casualties) {
  const defenseState = getTerritoryDefenseState(totalDefenseTroops, defenders);
  const totalCasualties = Math.min(sanitizeTroopCount(casualties), defenseState.totalDefenseTroops);
  const stationedCasualties = Math.min(totalCasualties, defenseState.stationedTroops);
  const allocation = allocateDefenderCasualties(defenders, stationedCasualties);
  const baseCasualties = totalCasualties - stationedCasualties;

  return {
    survivors: allocation.survivors,
    defendersLost: totalCasualties,
    defendersRemaining: Math.max(0, defenseState.totalDefenseTroops - totalCasualties),
    stationedDefendersRemaining: allocation.defendersRemaining,
    baseDefendersRemaining: Math.max(0, defenseState.baseDefenseTroops - baseCasualties),
    stationedCasualties,
    baseCasualties,
  };
}

async function replaceTerritoryDefenders(client, territoryId, defenders) {
  await client.query('DELETE FROM territory_defenders WHERE territory_id = $1', [territoryId]);
  const mergedDefenders = new Map();
  for (const defender of defenders) {
    const playerId = Number(defender.player_id);
    if (!Number.isFinite(playerId)) continue;
    const existing = mergedDefenders.get(playerId);
    mergedDefenders.set(playerId, {
      territory_id: territoryId,
      player_id: playerId,
      faction: defender.faction,
      troops: Math.max(0, Math.floor(Number(existing?.troops || 0) + Number(defender.troops || 0))),
    });
  }
  for (const defender of mergedDefenders.values()) {
    if (defender.troops <= 0) continue;
    await client.query(
      `INSERT INTO territory_defenders (territory_id, player_id, faction, troops)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (territory_id, player_id)
       DO UPDATE SET troops = EXCLUDED.troops, faction = EXCLUDED.faction, updated_at = NOW()`,
      [territoryId, defender.player_id, defender.faction, defender.troops]
    );
  }
}

async function applyDefenderCasualties(client, territoryId, totalDefenseTroops, defendersLost, lockedDefenders = null) {
  const defenders = lockedDefenders || await getLockedTerritoryDefenders(client, territoryId);
  const resolution = resolveDefenderCasualties(totalDefenseTroops, defenders, defendersLost);
  await replaceTerritoryDefenders(client, territoryId, resolution.survivors);
  return resolution;
}

// After any admin action changes a territory's owner_faction, defenders stationed under the
// old faction are no longer valid there (a player can't garrison a territory their faction
// doesn't own). This removes those stale rows and refunds the troops back to each affected
// player's reserve soldiers, then keeps defense_troops consistent with what remains stationed.
async function reconcileTerritoryDefendersForNewOwner(client, territoryId, newOwnerFaction, totalDefenseTroops) {
  const defenders = await getLockedTerritoryDefenders(client, territoryId);
  const staleDefenders = defenders.filter((defender) => defender.faction !== newOwnerFaction);
  if (!staleDefenders.length) {
    return { refundedTroops: 0, refunds: [] };
  }

  const validDefenders = defenders.filter((defender) => defender.faction === newOwnerFaction);
  const defenseState = getTerritoryDefenseState(totalDefenseTroops, defenders);
  const remainingStationed = sumStationedDefenders(validDefenders);

  for (const defender of staleDefenders) {
    await client.query('UPDATE players SET soldiers = soldiers + $1 WHERE id = $2', [defender.troops, defender.player_id]);
  }
  await client.query(
    'DELETE FROM territory_defenders WHERE territory_id = $1 AND faction <> $2',
    [territoryId, newOwnerFaction]
  );
  await client.query(
    'UPDATE territories SET defense_troops = $1 WHERE id = $2',
    [defenseState.baseDefenseTroops + remainingStationed, territoryId]
  );

  return {
    refundedTroops: staleDefenders.reduce((sum, defender) => sum + Number(defender.troops), 0),
    refunds: staleDefenders.map((defender) => ({ playerId: defender.player_id, troops: Number(defender.troops) })),
  };
}

module.exports = {
  sumStationedDefenders,
  getTerritoryDefenseState,
  allocateDefenderCasualties,
  getLockedTerritoryDefenders,
  resolveDefenderCasualties,
  replaceTerritoryDefenders,
  applyDefenderCasualties,
  reconcileTerritoryDefendersForNewOwner,
};
