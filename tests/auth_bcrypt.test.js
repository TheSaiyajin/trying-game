const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../backend/auth');

test('bcrypt upgrade keeps hashing and verification compatible with existing $2b$ hashes', async () => {
  // A hash produced by the previously deployed bcrypt version (v5, $2b$ format, cost 12).
  // Login must keep working against hashes created before the dependency upgrade.
  const preExistingHash = '$2b$12$S3UHQEnn6x/WUntI0SJJCOwYLib1dUIdBDCRjveBvPB1smZQ9w2We';

  const matches = await verifyPassword('test', preExistingHash);
  const mismatches = await verifyPassword('wrong-password', preExistingHash);

  assert.equal(matches, true);
  assert.equal(mismatches, false);
});

test('newly hashed passwords round-trip through hashPassword/verifyPassword', async () => {
  const hash = await hashPassword('correct horse battery staple');

  assert.match(hash, /^\$2[aby]\$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('incorrect', hash), false);
});
