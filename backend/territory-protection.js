const CAPITAL_IDS = new Set(['b1', 'r1', 'g1']);
const CAPITAL_ATTACK_ERROR = 'Capital territories cannot be attacked or occupied.';

function isCapitalTerritory(territory) {
  if (!territory) return false;
  return Boolean(territory.is_capital ?? territory.capital) || CAPITAL_IDS.has(String(territory.id || '').toLowerCase());
}

module.exports = {
  CAPITAL_ATTACK_ERROR,
  CAPITAL_IDS,
  isCapitalTerritory,
};
