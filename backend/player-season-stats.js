const STAT_COLUMNS = [
  'kills',
  'losses',
  'battles_joined',
  'battles_won',
  'successful_defences',
  'territories_captured',
  'retakes',
  'reinforcement_troops_sent',
];

function distributeProportionally(total, defenders) {
  const amount = Math.max(0, Math.floor(Number(total) || 0));
  const weighted = defenders
    .map((defender, index) => ({
      playerId: defender.player_id === null ? null : Number(defender.player_id),
      troops: Math.max(0, Math.floor(Number(defender.troops) || 0)),
      index,
    }))
    .filter((defender) => (defender.playerId === null || Number.isFinite(defender.playerId)) && defender.troops > 0);
  const totalTroops = weighted.reduce((sum, defender) => sum + defender.troops, 0);
  if (!amount || !totalTroops) return new Map();

  const shares = weighted.map((defender) => {
    const exact = (amount * defender.troops) / totalTroops;
    return { ...defender, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let assigned = shares.reduce((sum, share) => sum + share.value, 0);
  const ranked = [...shares].sort((left, right) => (
    right.remainder - left.remainder || right.troops - left.troops || left.index - right.index
  ));
  for (const share of ranked) {
    if (assigned >= amount) break;
    share.value += 1;
    assigned += 1;
  }
  return new Map(shares.filter((share) => share.playerId !== null).map((share) => [share.playerId, share.value]));
}

function buildBattleStatDeltas({ attackerPlayerId, defenderFaction, lockedDefenders, allocation, outcome }) {
  const deltas = new Map();
  deltas.set(Number(attackerPlayerId), {
    kills: outcome.defendersLost,
    losses: outcome.attackersLost,
    battles_joined: 1,
    battles_won: outcome.victory ? 1 : 0,
    territories_captured: outcome.victory ? 1 : 0,
  });

  const eligibleDefenders = lockedDefenders.filter((defender) => defender.faction === defenderFaction);
  const stationedTroops = eligibleDefenders.reduce((sum, defender) => sum + Number(defender.troops), 0);
  const totalDefenseTroops = Number(outcome.defendersLost) + Number(outcome.defendersRemaining);
  const baseTroops = Math.max(0, totalDefenseTroops - stationedTroops);
  const kills = distributeProportionally(outcome.attackersLost, [
    ...eligibleDefenders,
    { player_id: null, troops: baseTroops },
  ]);
  const survivors = new Map(allocation.survivors.map((defender) => [Number(defender.player_id), Number(defender.troops)]));
  for (const defender of eligibleDefenders) {
    const playerId = Number(defender.player_id);
    deltas.set(playerId, {
      kills: kills.get(playerId) || 0,
      losses: Math.max(0, Number(defender.troops) - (survivors.get(playerId) || 0)),
      battles_joined: 1,
      battles_won: outcome.victory ? 0 : 1,
      successful_defences: outcome.victory ? 0 : 1,
    });
  }
  return deltas;
}

async function addPlayerSeasonStats(client, seasonId, playerId, delta) {
  const values = STAT_COLUMNS.map((column) => Math.max(0, Math.floor(Number(delta[column]) || 0)));
  if (!values.some((value) => value > 0)) return;
  await client.query(
    `INSERT INTO player_season_stats
       (season_id, player_id, kills, losses, battles_joined, battles_won, successful_defences, territories_captured, retakes, reinforcement_troops_sent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (season_id, player_id) DO UPDATE SET
       kills = player_season_stats.kills + EXCLUDED.kills,
       losses = player_season_stats.losses + EXCLUDED.losses,
       battles_joined = player_season_stats.battles_joined + EXCLUDED.battles_joined,
       battles_won = player_season_stats.battles_won + EXCLUDED.battles_won,
       successful_defences = player_season_stats.successful_defences + EXCLUDED.successful_defences,
       territories_captured = player_season_stats.territories_captured + EXCLUDED.territories_captured,
       retakes = player_season_stats.retakes + EXCLUDED.retakes,
       reinforcement_troops_sent = player_season_stats.reinforcement_troops_sent + EXCLUDED.reinforcement_troops_sent,
       updated_at = NOW()`,
    [seasonId, playerId, ...values]
  );
}

async function recordBattleStats(client, { seasonId, territoryId, attackerPlayerId, attackerFaction, defenderFaction, lockedDefenders, allocation, outcome }) {
  let retake = false;
  if (outcome.victory) {
    const priorOwnership = await client.query(
      `SELECT 1 FROM season_territory_faction_ownership
       WHERE season_id = $1 AND territory_id = $2 AND faction = $3`,
      [seasonId, territoryId, attackerFaction]
    );
    retake = priorOwnership.rowCount > 0;
    await client.query(
      `INSERT INTO season_territory_faction_ownership (season_id, territory_id, faction)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [seasonId, territoryId, attackerFaction]
    );
  }

  const deltas = buildBattleStatDeltas({ attackerPlayerId, defenderFaction, lockedDefenders, allocation, outcome });
  if (retake) deltas.get(Number(attackerPlayerId)).retakes = 1;
  for (const [playerId, delta] of deltas) {
    await addPlayerSeasonStats(client, seasonId, playerId, delta);
  }
  return { retake, deltas };
}

function emptyStats() {
  return Object.fromEntries(STAT_COLUMNS.map((column) => [column, 0]));
}

function publicStatsRow(row) {
  return {
    username: row.username,
    faction: row.faction,
    ...Object.fromEntries(STAT_COLUMNS.map((column) => [column, Number(row[column]) || 0])),
  };
}

async function getSeasonStats(client, { seasonId, playerId, limit = 10 }) {
  const result = await client.query(
    `SELECT pss.player_id, p.username, sm.faction,
            pss.kills, pss.losses, pss.battles_joined, pss.battles_won,
            pss.successful_defences, pss.territories_captured, pss.retakes,
            pss.reinforcement_troops_sent
     FROM player_season_stats pss
     INNER JOIN players p ON p.id = pss.player_id
     INNER JOIN season_memberships sm ON sm.season_id = pss.season_id AND sm.player_id = pss.player_id
     WHERE pss.season_id = $1`,
    [seasonId]
  );
  const rows = result.rows.map(publicStatsRow);
  const rankings = Object.fromEntries(STAT_COLUMNS.map((column) => [
    column,
    [...rows]
      .sort((left, right) => right[column] - left[column] || left.username.localeCompare(right.username))
      .slice(0, limit),
  ]));
  const ownRow = result.rows.find((row) => Number(row.player_id) === Number(playerId));
  return {
    myStats: ownRow ? publicStatsRow(ownRow) : emptyStats(),
    rankings,
  };
}

module.exports = {
  STAT_COLUMNS,
  addPlayerSeasonStats,
  buildBattleStatDeltas,
  distributeProportionally,
  emptyStats,
  getSeasonStats,
  publicStatsRow,
  recordBattleStats,
};