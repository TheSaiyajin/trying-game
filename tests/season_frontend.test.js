const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCountdown } = require('../script.js');

test('countdown is formatted as HH:MM:SS', () => {
  assert.equal(formatCountdown(0), '00:00:00');
  assert.equal(formatCountdown(1000), '00:00:01');
  assert.equal(formatCountdown(61 * 1000), '00:01:01');
  assert.equal(formatCountdown((2 * 3600 + 5 * 60 + 9) * 1000), '02:05:09');
});

test('countdown never goes negative even if the clock briefly drifts past the reset', () => {
  assert.equal(formatCountdown(-5000), '00:00:00');
});
