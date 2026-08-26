const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
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
