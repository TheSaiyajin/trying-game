const test = require('node:test');
const assert = require('node:assert/strict');
const { DAY_MS, getUtcDayNumber, getUtcDayBounds, getCurrentUtcDayBounds } = require('../backend/season-time');

test('a season runs from 00:00 UTC until the next 00:00 UTC', () => {
  const now = new Date('2026-03-15T13:45:00.000Z');
  const { startsAt, endsAt } = getCurrentUtcDayBounds(now);

  assert.equal(startsAt.toISOString(), '2026-03-15T00:00:00.000Z');
  assert.equal(endsAt.toISOString(), '2026-03-16T00:00:00.000Z');
  assert.equal(endsAt.getTime() - startsAt.getTime(), DAY_MS);
});

test('season boundaries never depend on local timezone, only UTC', () => {
  // Two instants that are the "same local day" in some timezones but different UTC days.
  const lateUtc = new Date('2026-03-15T23:59:59.000Z');
  const earlyNextUtc = new Date('2026-03-16T00:00:01.000Z');

  assert.notEqual(getUtcDayNumber(lateUtc), getUtcDayNumber(earlyNextUtc));
});

test('the season number is stable within a day and increments exactly at midnight UTC', () => {
  const exactly = new Date('2026-03-16T00:00:00.000Z');
  const justBefore = new Date(exactly.getTime() - 1);
  assert.equal(getUtcDayNumber(exactly) - getUtcDayNumber(justBefore), 1);
});

test('getUtcDayBounds is the inverse of getUtcDayNumber', () => {
  const now = new Date('2026-07-04T08:00:00.000Z');
  const dayNumber = getUtcDayNumber(now);
  const { startsAt, endsAt } = getUtcDayBounds(dayNumber);
  assert.ok(startsAt <= now && now < endsAt);
});
