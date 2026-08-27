// Server-side-only path to grant the admin role. This intentionally has no HTTP route:
// it is only reachable via the CLI (node backend/db.js --bootstrap-admin <token>), so the
// ADMIN_BOOTSTRAP_TOKEN never needs to be sent over the network or referenced in frontend
// JavaScript. Registering with username "Sai" alone must never grant admin (see
// admin-policy.js getRegistrationRole) — this is the only supported way to promote it.
const { ADMIN_USERNAME } = require('./admin-policy');

async function bootstrapAdmin(client, { token }) {
  const expectedToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!expectedToken) {
    return { ok: false, status: 500, error: 'ADMIN_BOOTSTRAP_TOKEN is not configured on the server.' };
  }
  if (!token || token !== expectedToken) {
    return { ok: false, status: 403, error: 'Invalid bootstrap token.' };
  }

  const existing = await client.query(
    'SELECT id, role FROM players WHERE username = $1 FOR UPDATE',
    [ADMIN_USERNAME]
  );
  if (!existing.rowCount) {
    return { ok: false, status: 404, error: `Account "${ADMIN_USERNAME}" does not exist yet. Register it first, then run bootstrap.` };
  }

  await client.query('UPDATE players SET role = $1 WHERE id = $2', ['admin', existing.rows[0].id]);
  return { ok: true, username: ADMIN_USERNAME };
}

module.exports = {
  bootstrapAdmin,
};
