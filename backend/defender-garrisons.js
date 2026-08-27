function sumStationedDefenders(defenders) {
  return defenders.reduce((total, defender) => total + Math.max(0, Math.floor(Number(defender.troops) || 0)), 0);
}

function allocateDefenderCasualties(defenders, casualties) {
  const sanitizedDefenders = defenders.map((defender) => ({
    territory_id: defender.territory_id,
    player_id: defender.player_id,
    faction: defender.faction,
    troops: Math.max(0, Math.floor(Number(defender.troops) || 0)),
  })).filter((defender) => defender.troops > 0);
  const totalDefenders = sumStationedDefenders(sanitizedDefenders);
  const totalCasualties = Math.min(Math.max(0, Math.floor(Number(casualties) || 0)), totalDefenders);

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

async function applyDefenderCasualties(client, territoryId, defendersLost) {
  const stationedResult = await client.query(
    `SELECT territory_id, player_id, faction, troops
     FROM territory_defenders
     WHERE territory_id = $1
     ORDER BY player_id
     FOR UPDATE`,
    [territoryId]
  );
  const allocation = allocateDefenderCasualties(stationedResult.rows, defendersLost);
  await replaceTerritoryDefenders(client, territoryId, allocation.survivors);
  return allocation;
}

module.exports = {
  sumStationedDefenders,
  allocateDefenderCasualties,
  replaceTerritoryDefenders,
  applyDefenderCasualties,
};
