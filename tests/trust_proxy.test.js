const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTrustProxySetting } = require('../backend/trust-proxy');

test('production trusts exactly 2 proxy hops by default (Cloudflare -> Nginx -> Express)', () => {
  assert.equal(resolveTrustProxySetting({ NODE_ENV: 'production' }), 2);
});

test('development disables proxy trust by default', () => {
  assert.equal(resolveTrustProxySetting({ NODE_ENV: 'development' }), false);
  assert.equal(resolveTrustProxySetting({}), false);
});

test('TRUST_PROXY_HOPS overrides the default in either environment', () => {
  assert.equal(resolveTrustProxySetting({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' }), 1);
  assert.equal(resolveTrustProxySetting({ NODE_ENV: 'development', TRUST_PROXY_HOPS: '3' }), 3);
  assert.equal(resolveTrustProxySetting({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '0' }), 0);
});

test('rejects invalid TRUST_PROXY_HOPS values instead of silently trusting everything', () => {
  assert.throws(() => resolveTrustProxySetting({ TRUST_PROXY_HOPS: 'true' }), /non-negative integer/);
  assert.throws(() => resolveTrustProxySetting({ TRUST_PROXY_HOPS: '-1' }), /non-negative integer/);
  assert.throws(() => resolveTrustProxySetting({ TRUST_PROXY_HOPS: '1.5' }), /non-negative integer/);
  assert.throws(() => resolveTrustProxySetting({ TRUST_PROXY_HOPS: 'all' }), /non-negative integer/);
});

test('never resolves to the unbounded "trust everything" setting', () => {
  assert.notEqual(resolveTrustProxySetting({ NODE_ENV: 'production' }), true);
  assert.notEqual(resolveTrustProxySetting({ NODE_ENV: 'development' }), true);
});

test('ignores an empty TRUST_PROXY_HOPS value and falls back to the environment default', () => {
  assert.equal(resolveTrustProxySetting({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '' }), 2);
  assert.equal(resolveTrustProxySetting({ NODE_ENV: 'development', TRUST_PROXY_HOPS: '' }), false);
});
