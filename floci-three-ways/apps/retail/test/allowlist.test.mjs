// Pure CIDR arithmetic. No database, so this suite always runs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowlistCheck, ipInCidr, ipToInt, normaliseIp, parseCidrs } from '../src/allowlist.mjs';

describe('parseCidrs', () => {
  it('splits and trims', () => {
    assert.deepEqual(parseCidrs(' 10.0.0.0/8 , 203.0.113.7/32 '), ['10.0.0.0/8', '203.0.113.7/32']);
  });

  it('returns nothing for unset or empty input', () => {
    assert.deepEqual(parseCidrs(undefined), []);
    assert.deepEqual(parseCidrs(''), []);
    assert.deepEqual(parseCidrs(' , '), []);
  });
});

describe('normaliseIp', () => {
  it('strips the IPv4-mapped IPv6 prefix', () => {
    assert.equal(normaliseIp('::ffff:127.0.0.1'), '127.0.0.1');
  });

  it('leaves a plain address alone', () => {
    assert.equal(normaliseIp('10.0.0.1'), '10.0.0.1');
  });

  it('returns an empty string for a non-string', () => {
    assert.equal(normaliseIp(undefined), '');
  });
});

describe('ipToInt', () => {
  it('converts a dotted quad', () => {
    assert.equal(ipToInt('0.0.0.0'), 0);
    assert.equal(ipToInt('255.255.255.255'), 4294967295);
    assert.equal(ipToInt('10.0.0.1'), 167772161);
  });

  it('rejects malformed input', () => {
    for (const bad of ['10.0.0', '10.0.0.256', 'a.b.c.d', '', '::1', '10.0.0.1.2']) {
      assert.equal(ipToInt(bad), null, bad);
    }
  });
});

describe('ipInCidr', () => {
  it('matches inside the range', () => {
    assert.equal(ipInCidr('10.4.5.6', '10.0.0.0/8'), true);
    assert.equal(ipInCidr('192.168.1.255', '192.168.1.0/24'), true);
    assert.equal(ipInCidr('203.0.113.7', '203.0.113.7/32'), true);
  });

  it('does not match outside the range', () => {
    assert.equal(ipInCidr('11.0.0.1', '10.0.0.0/8'), false);
    assert.equal(ipInCidr('192.168.2.1', '192.168.1.0/24'), false);
    assert.equal(ipInCidr('203.0.113.8', '203.0.113.7/32'), false);
  });

  it('treats a bare address as a /32', () => {
    assert.equal(ipInCidr('203.0.113.7', '203.0.113.7'), true);
    assert.equal(ipInCidr('203.0.113.8', '203.0.113.7'), false);
  });

  it('matches everything on /0', () => {
    assert.equal(ipInCidr('8.8.8.8', '0.0.0.0/0'), true);
  });

  it('refuses a prefix outside 0 to 32', () => {
    assert.equal(ipInCidr('10.0.0.1', '10.0.0.0/33'), false);
    assert.equal(ipInCidr('10.0.0.1', '10.0.0.0/-1'), false);
    assert.equal(ipInCidr('10.0.0.1', '10.0.0.0/x'), false);
  });

  it('does not match an IPv6 caller against an IPv4 range', () => {
    assert.equal(ipInCidr('2001:db8::1', '0.0.0.0/0'), false);
  });
});

describe('allowlistCheck', () => {
  it('passes through when no list is configured', () => {
    assert.equal(allowlistCheck({ path: '/orders', sourceIp: '8.8.8.8' }, undefined), null);
    assert.equal(allowlistCheck({ path: '/orders', sourceIp: '8.8.8.8' }, ''), null);
  });

  it('passes through an allowed caller', () => {
    assert.equal(allowlistCheck({ path: '/orders', sourceIp: '10.1.1.1' }, '10.0.0.0/8'), null);
  });

  it('returns a 403 body naming the caller', () => {
    const blocked = allowlistCheck({ path: '/orders', sourceIp: '::ffff:8.8.8.8' }, '10.0.0.0/8');
    assert.deepEqual(blocked, { status: 403, body: { error: 'forbidden', sourceIp: '8.8.8.8' } });
  });

  it('exempts /health even when the caller is blocked', () => {
    assert.equal(allowlistCheck({ path: '/health', sourceIp: '8.8.8.8' }, '10.0.0.0/8'), null);
  });
});
