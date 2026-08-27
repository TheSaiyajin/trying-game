const CAPITAL_ATTACK_ERROR = 'Capital territories cannot be attacked or occupied.';

function isCapitalTerritory(territory) {
  if (!territory) return false;
  return Boolean(territory.is_capital ?? territory.capital);
}

module.exports = {
  CAPITAL_ATTACK_ERROR,
  isCapitalTerritory,
};
