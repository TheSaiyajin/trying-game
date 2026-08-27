const ADMIN_USERNAME = 'Sai';
const SAFE_USERNAME_REGEX = /^[A-Za-z0-9_-]{3,32}$/;

function isSafeUsername(username) {
  return SAFE_USERNAME_REGEX.test(String(username || '').trim());
}

function isSaiUsername(username) {
  return String(username || '') === ADMIN_USERNAME;
}

function isAuthorizedAdminPlayer(player) {
  return Boolean(player)
    && isSaiUsername(player.username)
    && String(player.role || '').toLowerCase() === 'admin';
}

function getRegistrationRole(username) {
  return isSaiUsername(username) ? 'admin' : 'member';
}

function normalizeRequestedRole(player, requestedRole) {
  const role = String(requestedRole || '').trim().toLowerCase();
  if (!player) {
    return { ok: false, error: 'Player not found.' };
  }
  if (isSaiUsername(player.username)) {
    if (role !== 'admin') {
      return { ok: false, error: 'Sai must remain admin.' };
    }
    return { ok: true, role: 'admin' };
  }
  if (!['member', 'leader'].includes(role)) {
    return { ok: false, error: 'Role must be member or leader for other players.' };
  }
  return { ok: true, role };
}

module.exports = {
  ADMIN_USERNAME,
  SAFE_USERNAME_REGEX,
  isSafeUsername,
  isSaiUsername,
  isAuthorizedAdminPlayer,
  getRegistrationRole,
  normalizeRequestedRole,
};
