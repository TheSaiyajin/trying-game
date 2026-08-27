const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const DEV_JWT_SECRET_FALLBACK = 'dev-secret-change-me';

// Fail loudly on production startup instead of silently signing tokens with a
// well-known, publicly documented development secret. Development/test may still use
// the documented fallback for convenience.
if (process.env.NODE_ENV === 'production'
  && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_JWT_SECRET_FALLBACK)) {
  throw new Error(
    'JWT_SECRET must be set to a strong, unique value in production (NODE_ENV=production). '
    + 'Refusing to start with a missing or default development secret.'
  );
}

const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_SECRET_FALLBACK;
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 86400);

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function issueToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: SESSION_TTL_SECONDS });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  SESSION_TTL_SECONDS,
};
