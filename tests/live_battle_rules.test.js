const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BATTLE_DURATION_MS,
  BATTLE_PROTECTION_MS,
  BATTLE_ROUND_MS,
  RALLY_PREPARATION_MS,
  calculateBattleRound,
  getProtectionRemainingMs,
} = require('../backend/battle-rules');
const { getFactionTerritoryBonuses } = require('../backend/game-logic');

test('battle timings use hidden preparation, minute rounds, a 20-minute limit, and 30-minute protection', () => {
  assert.equal(RALLY_PREPARATION_MS, 10 * 60 * 1000);
  assert.equal(BATTLE_ROUND_MS, 60 * 1000);
  assert.equal(BATTLE_DURATION_MS, 20 * 60 * 1000);
  assert.equal(BATTLE_PROTECTION_MS, 30 * 60 * 1000);
});

test('a battle round applies simultaneous casualties from both starting troop totals', () => {
  assert.deepEqual(calculateBattleRound({ attackers: 100, defenders: 80 }), {
    attackersLost: 8,
    defendersLost: 10,
  });
});

test('attack and defense bonuses strengthen only their own side damage', () => {
  assert.deepEqual(calculateBattleRound({
    attackers: 100,
    defenders: 100,
    attackBonus: 0.2,
    defenseBonus: 0.2,
  }), {
    attackersLost: 12,
    defendersLost: 12,
  });
});

test('combat bonuses cap at 25% in territory totals and battle damage', () => {
  const territories = [
    { owner: 'blue', bonus: 'attack', bonusValue: 0.2 },
    { owner: 'blue', bonus: 'attack', bonusValue: 0.2 },
    { owner: 'blue', bonus: 'defense', bonusValue: 0.3 },
  ];
  const bonuses = getFactionTerritoryBonuses(territories, 'blue');

  assert.equal(bonuses.attack, 0.25);
  assert.equal(bonuses.defense, 0.25);
  assert.deepEqual(calculateBattleRound({
    attackers: 200,
    defenders: 100,
    attackBonus: 5,
    defenseBonus: 5,
  }), {
    attackersLost: 12,
    defendersLost: 25,
  });
});

test('a live round causes at least one casualty when both sides still have troops', () => {
  assert.deepEqual(calculateBattleRound({ attackers: 1, defenders: 1 }), {
    attackersLost: 1,
    defendersLost: 1,
  });
});

test('protection counts down from its stored server timestamp', () => {
  const now = new Date('2026-09-03T12:00:00.000Z');
  assert.equal(getProtectionRemainingMs('2026-09-03T12:30:00.000Z', now), BATTLE_PROTECTION_MS);
  assert.equal(getProtectionRemainingMs('2026-09-03T11:59:00.000Z', now), 0);
});

test('contested territories grant no bonuses and attack/defense types are ready', () => {
  const territories = [
    { id: 'a1', owner: 'blue', bonus: 'attack', bonusValue: 0.1 },
    { id: 'a2', owner: 'blue', bonus: 'food', bonusValue: 0.2, contested: true },
    { id: 'd1', owner: 'red', bonus: 'defense', bonusValue: 0.15 },
    { id: 'd2', owner: 'red', bonus: 'storage', bonusValue: 0.2, contested: true },
  ];
  const blue = getFactionTerritoryBonuses(territories, 'blue');
  const red = getFactionTerritoryBonuses(territories, 'red');
  assert.equal(blue.attack, 0.1);
  assert.equal(blue.food, 0);
  assert.equal(red.defense, 0.15);
  assert.equal(red.storage, 0);
});

test('server snapshots mark only active battles contested and block defender recalls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.match(source, /at\.territory_id = t\.id AND at\.phase = 'active'/);
  assert.match(source, /Defenders cannot be recalled during an active battle/);
  assert.match(source, /battle_defender_contributions/);
});
