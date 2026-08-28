// Express's `trust proxy` setting controls how many reverse-proxy hops it trusts when
// reading X-Forwarded-For (used by express-rate-limit and req.ip). SaiWars runs behind
// Cloudflare -> Nginx -> Express, i.e. exactly 2 hops the app should trust in production.
// Using `app.set('trust proxy', true)` trusts the entire X-Forwarded-For chain (including
// client-supplied values), which is what triggers express-rate-limit's
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning and lets clients spoof their own rate-limit key.
function resolveTrustProxySetting(env = process.env) {
  const raw = env.TRUST_PROXY_HOPS;

  if (raw !== undefined && String(raw).trim() !== '') {
    const hops = Number(raw);
    if (!Number.isInteger(hops) || hops < 0) {
      throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer, got: "${raw}"`);
    }
    return hops;
  }

  // No explicit override: trust exactly the known Cloudflare -> Nginx hop count in
  // production, and trust nothing by default in development (no proxy in front locally).
  return env.NODE_ENV === 'production' ? 2 : false;
}

module.exports = { resolveTrustProxySetting };
