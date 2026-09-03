const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('only the attacking faction may add troops to an active battle or its visible rally', () => {
  const rally = {
    r2: { territoryId: 'r2', attackerFaction: 'blue', defenderFaction: 'red' },
  };
  assert.equal(canAttack('r2', gameState('blue', rally)), true);
  assert.equal(canAttack('r2', gameState('green', rally)), false);
  assert.equal(canAttack('r2', gameState('red', rally)), false);
});

test('a territory in its post-battle protection period cannot be attacked', () => {
  const state = gameState('blue');
  state.territories.r2.protectedUntil = new Date(Date.now() + 60_000).toISOString();
  assert.equal(canAttack('r2', state), false);
});

test('rally snapshots are normalized for the map UI', () => {
  const rallies = mapRallies([{
    territoryId: 'r2', attackerFaction: 'blue', defenderFaction: 'red',
    startedBy: 1, phase: 'active', resolvesAt: '2026-09-02T12:20:00.000Z',
    nextTickAt: '2026-09-02T12:01:00.000Z', roundNumber: '2',
    totalAttackers: '50', myContribution: '20',
  }]);
  assert.equal(rallies.r2.phase, 'active');
  assert.equal(rallies.r2.roundNumber, 2);
  assert.equal(rallies.r2.totalAttackers, 50);
  assert.equal(rallies.r2.myContribution, 20);
});

test('enemy territory UI offers solo attack and hidden rally choices', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  assert.match(html, /launchAttack\('solo'\)[\s\S]*Start Hidden Rally/);
  assert.match(html, /launchAttack\('rally'\)/);
  assert.match(script, /JSON\.stringify\(\{ territoryId: selectedTerritoryId, soldiers, mode \}\)/);
  assert.match(script, /\/game\/launch-rally/);
});

test('server hides preparing rallies from every faction except the attacker', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'rally-battles.js'), 'utf8');
  assert.match(source, /at\.phase = 'active' OR at\.faction = \$3/);
});
