const test = require('node:test');
const assert = require('node:assert/strict');
const { canAttack, formatRallyCountdown, mapRallies } = require('../script');

function gameState(playerFaction, rallies = {}) {
  return {
    player: { faction: playerFaction },
    rallies,
    territories: {
      b1: { owner: 'blue', capital: false, adj: ['r2'] },
      g1: { owner: 'green', capital: false, adj: ['r2'] },
      r2: { owner: 'red', capital: false, adj: ['b1', 'g1'] },
    },
  };
}

test('rally countdown is stable at ten minutes and never goes negative', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z');
  assert.equal(formatRallyCountdown('2026-09-02T12:10:00.000Z', now), '10:00');
  assert.equal(formatRallyCountdown('2026-09-02T12:00:09.200Z', now), '00:10');
  assert.equal(formatRallyCountdown('2026-09-02T11:59:00.000Z', now), '00:00');
});

test('only the attacking faction may add troops to an active rally', () => {
  const rally = {
    r2: { territoryId: 'r2', attackerFaction: 'blue', defenderFaction: 'red' },
  };
  assert.equal(canAttack('r2', gameState('blue', rally)), true);
  assert.equal(canAttack('r2', gameState('green', rally)), false);
  assert.equal(canAttack('r2', gameState('red', rally)), false);
});

test('rally snapshots are normalized for the map UI', () => {
  const rallies = mapRallies([{
    territoryId: 'r2', attackerFaction: 'blue', defenderFaction: 'red',
    startedBy: 1, resolvesAt: '2026-09-02T12:10:00.000Z',
    totalAttackers: '50', myContribution: '20',
  }]);
  assert.equal(rallies.r2.totalAttackers, 50);
  assert.equal(rallies.r2.myContribution, 20);
});
