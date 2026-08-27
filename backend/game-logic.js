const BUILDING_DEFS = {
  farm: {
    name: 'Farm',
    resource: 'food',
    baseProduction: 5,
    cost: { food: 50, wood: 80, iron: 0 },
  },
  lumbermill: {
    name: 'Lumber Mill',
    resource: 'wood',
    baseProduction: 4,
    cost: { food: 40, wood: 0, iron: 60 },
  },
  ironmine: {
    name: 'Iron Mine',
    resource: 'iron',
    baseProduction: 3,
    cost: { food: 30, wood: 100, iron: 0 },
  },
  barracks: {
    name: 'Barracks',
    resource: 'manpower',
    baseProduction: 2,
    cost: { food: 80, wood: 60, iron: 80 },
  },
};

function clampInt(value, minimum = 0) {
  const numeric = Number(value) || 0;
  return Math.max(minimum, Math.floor(numeric));
}

function normalizeBuildingLevels(buildings = {}) {
  const normalized = {};
  for (const [key, def] of Object.entries(BUILDING_DEFS)) {
    normalized[key] = clampInt(buildings[key] ?? 1, 1);
  }
  return normalized;
}

function getUpgradeCost(buildingKey, level) {
  const def = BUILDING_DEFS[buildingKey];
  if (!def) {
    throw new Error(`Unknown building: ${buildingKey}`);
  }
  const nextLevel = Math.max(1, clampInt(level, 1));
  return {
    food: def.cost.food * nextLevel,
    wood: def.cost.wood * nextLevel,
    iron: def.cost.iron * nextLevel,
  };
}

function getFactionTerritoryBonuses(territories = [], faction = 'blue') {
  const bonuses = { food: 0, wood: 0, iron: 0, manpower: 0, training: 0 };

  for (const territory of territories) {
    if (territory.owner_faction !== faction) continue;
    const bonusType = String(territory.bonus_type || '').toLowerCase();
    const bonusValue = Number(territory.bonus_value || 0);

    if (bonusType === 'food') bonuses.food += bonusValue;
    if (bonusType === 'wood') bonuses.wood += bonusValue;
    if (bonusType === 'iron') bonuses.iron += bonusValue;
    if (bonusType === 'manpower') bonuses.manpower += bonusValue;
    if (bonusType === 'training') bonuses.training += bonusValue;
    if (bonusType === 'resource') {
      bonuses.food += bonusValue;
      bonuses.wood += bonusValue;
      bonuses.iron += bonusValue;
      bonuses.manpower += bonusValue;
    }
  }

  return bonuses;
}

function getProductionFromBuildings(buildings = {}, territories = [], faction = 'blue', includeBonuses = false) {
  const normalized = normalizeBuildingLevels(buildings);
  const bonuses = includeBonuses ? getFactionTerritoryBonuses(territories, faction) : { food: 0, wood: 0, iron: 0, manpower: 0, training: 0 };

  const food = Math.floor((BUILDING_DEFS.farm.baseProduction * normalized.farm) * (1 + bonuses.food));
  const wood = Math.floor((BUILDING_DEFS.lumbermill.baseProduction * normalized.lumbermill) * (1 + bonuses.wood));
  const iron = Math.floor((BUILDING_DEFS.ironmine.baseProduction * normalized.ironmine) * (1 + bonuses.iron));
  const manpower = Math.floor((BUILDING_DEFS.barracks.baseProduction * normalized.barracks) * (1 + bonuses.manpower));

  return { food, wood, iron, manpower };
}

function getTrainingCost(count = 0, multiplier = 1) {
  const amount = clampInt(count, 0);
  const factor = Number(multiplier) || 1;
  return {
    food: Math.max(0, Math.round(50 * amount * factor)),
    iron: Math.max(0, Math.round(20 * amount * factor)),
    manpower: Math.max(0, Math.round(1 * amount * factor)),
  };
}

function getOfflineResourceGain(production = {}, seconds = 0, capSeconds = 60 * 60 * 12) {
  const elapsed = Math.max(0, Math.min(Number(seconds) || 0, capSeconds));
  return {
    food: Math.max(0, Math.floor((Number(production.food || 0) / 60) * elapsed)),
    wood: Math.max(0, Math.floor((Number(production.wood || 0) / 60) * elapsed)),
    iron: Math.max(0, Math.floor((Number(production.iron || 0) / 60) * elapsed)),
    manpower: Math.max(0, Math.floor((Number(production.manpower || 0) / 60) * elapsed)),
  };
}

function calculateBattleOutcome(attackStats, defenseStats) {
  const attackers = clampInt(attackStats.attackers, 0);
  const defenderCount = clampInt(defenseStats.defenders, 0);
  const victory = attackers > defenderCount;
  const defendersLost = victory ? defenderCount : Math.min(defenderCount, attackers);
  const attackersLost = victory ? defenderCount : attackers;
  const attackersRemaining = victory ? Math.max(1, attackers - defenderCount) : 0;
  const defendersRemaining = victory ? 0 : Math.max(1, defenderCount - attackers);
  const attackPower = attackers;
  const defensePower = defenderCount;

  return {
    victory,
    attackPower,
    defensePower,
    defendersLost,
    attackersLost,
    attackersRemaining,
    defendersRemaining,
  };
}

module.exports = {
  BUILDING_DEFS,
  getUpgradeCost,
  getProductionFromBuildings,
  getFactionTerritoryBonuses,
  getTrainingCost,
  getOfflineResourceGain,
  calculateBattleOutcome,
};
