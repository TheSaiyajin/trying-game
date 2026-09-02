const { getFactionTerritoryBonuses, getTrainingCost } = require('./game-logic');

class TrainingError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TrainingError';
    this.status = status;
  }
}

async function performSoldierTraining(client, { playerId, count }) {
  await client.query('BEGIN');
  try {
    const playerResult = await client.query('SELECT * FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    const player = playerResult.rows[0];
    if (!player) throw new TrainingError(404, 'Player not found.');
    if (!player.faction) throw new TrainingError(400, 'Choose a faction before training troops.');

    const territoriesResult = await client.query(
      'SELECT owner_faction, bonus_type, bonus_value, storage_bonus, is_fortress FROM territories'
    );
    const territoryBonuses = getFactionTerritoryBonuses(territoriesResult.rows, player.faction);
    const trainingMultiplier = Math.max(0.4, 1 - (territoryBonuses.training || 0));
    const cost = getTrainingCost(count, trainingMultiplier);

    if (Number(player.resource_food) < cost.food
      || Number(player.resource_iron) < cost.iron
      || Number(player.resource_manpower) < cost.manpower) {
      throw new TrainingError(400, 'Not enough resources to train soldiers.');
    }

    await client.query(
      `UPDATE players
       SET resource_food = resource_food - $1,
           resource_iron = resource_iron - $2,
           resource_manpower = resource_manpower - $3,
           soldiers = soldiers + $4,
           last_action_at = NOW()
       WHERE id = $5`,
      [cost.food, cost.iron, cost.manpower, count, playerId]
    );
    await client.query('COMMIT');
    return { cost, trained: count };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = { TrainingError, performSoldierTraining };