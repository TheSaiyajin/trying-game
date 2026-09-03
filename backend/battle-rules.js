const BATTLE_DURATION_MS = 20 * 60 * 1000;
const BATTLE_ROUND_MS = 60 * 1000;
const BATTLE_PROTECTION_MS = 30 * 60 * 1000;
const RALLY_PREPARATION_MS = 10 * 60 * 1000;
const BASE_CASUALTY_RATE = 0.10;

function normalizeTroops(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function normalizeCombatBonus(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

// Both losses are calculated from the troop totals at the start of the round,
// so neither side gets a first-strike advantage. Attack bonuses increase damage
// dealt by attackers; defense bonuses increase damage dealt by defenders.
function calculateBattleRound({ attackers, defenders, attackBonus = 0, defenseBonus = 0 }) {
  const attackerCount = normalizeTroops(attackers);
  const defenderCount = normalizeTroops(defenders);
  if (!attackerCount || !defenderCount) {
    return { attackersLost: 0, defendersLost: 0 };
  }

  const defendersLost = Math.min(
    defenderCount,
    Math.max(1, Math.floor(attackerCount * BASE_CASUALTY_RATE * (1 + normalizeCombatBonus(attackBonus))))
  );
  const attackersLost = Math.min(
    attackerCount,
    Math.max(1, Math.floor(defenderCount * BASE_CASUALTY_RATE * (1 + normalizeCombatBonus(defenseBonus))))
  );
  return { attackersLost, defendersLost };
}

function getProtectionRemainingMs(protectedUntil, now = new Date()) {
  if (!protectedUntil) return 0;
  return Math.max(0, new Date(protectedUntil).getTime() - new Date(now).getTime());
}

module.exports = {
  BASE_CASUALTY_RATE,
  BATTLE_DURATION_MS,
  BATTLE_PROTECTION_MS,
  BATTLE_ROUND_MS,
  RALLY_PREPARATION_MS,
  calculateBattleRound,
  getProtectionRemainingMs,
  normalizeCombatBonus,
};
