// UTC-only day boundaries for the daily season schedule. Every season starts at 00:00 UTC
// and ends at the next 00:00 UTC. Never use the VPS local timezone here.
const DAY_MS = 24 * 60 * 60 * 1000;

function getUtcDayNumber(date = new Date()) {
  return Math.floor(date.getTime() / DAY_MS);
}

function getUtcDayBounds(dayNumber) {
  return {
    startsAt: new Date(dayNumber * DAY_MS),
    endsAt: new Date((dayNumber + 1) * DAY_MS),
  };
}

// The UTC day number doubles as the season number: deterministic, gap-free, and never
// dependent on how many seasons have actually been created (safe after long downtime).
function getCurrentUtcDayBounds(now = new Date()) {
  const seasonNumber = getUtcDayNumber(now);
  return { seasonNumber, ...getUtcDayBounds(seasonNumber) };
}

module.exports = {
  DAY_MS,
  getUtcDayNumber,
  getUtcDayBounds,
  getCurrentUtcDayBounds,
};
