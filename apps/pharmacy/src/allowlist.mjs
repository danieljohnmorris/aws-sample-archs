// ALLOWED_CIDRS gate. IPv4 only, which is all floci hands us.
// /health is exempt so load balancer and container health checks keep working.

/** Split the env var into a list of CIDR strings. Empty when unset. */
export function parseCidrs(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Strip the IPv4-mapped IPv6 prefix node:http gives us on dual-stack sockets. */
export function normaliseIp(ip) {
  if (typeof ip !== 'string') return '';
  const trimmed = ip.trim();
  if (trimmed.toLowerCase().startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

/** Dotted quad to a 32 bit unsigned integer, or null when it is not IPv4. */
export function ipToInt(ip) {
  const parts = normaliseIp(ip).split('.');
  if (parts.length !== 4) return null;
  let total = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    total = total * 256 + octet;
  }
  return total >>> 0;
}

/** True when `ip` sits inside `cidr`. A bare address counts as a /32. */
export function ipInCidr(ip, cidr) {
  const [network, prefixRaw] = String(cidr).split('/');
  const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const target = ipToInt(ip);
  const base = ipToInt(network);
  if (target === null || base === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (target & mask) >>> 0 === (base & mask) >>> 0;
}

/** True when `ip` matches any entry. */
export function ipAllowed(ip, cidrs) {
  return cidrs.some((cidr) => ipInCidr(ip, cidr));
}

/**
 * Returns a 403 response when the caller is blocked, or null to carry on.
 * An unset or empty ALLOWED_CIDRS turns the gate off, per CONTRACT.md.
 */
export function allowlistCheck({ path, sourceIp }, allowedCidrsRaw) {
  const cidrs = parseCidrs(allowedCidrsRaw);
  if (cidrs.length === 0) return null;
  if (path === '/health') return null;
  if (ipAllowed(sourceIp, cidrs)) return null;
  return { status: 403, body: { error: 'forbidden', sourceIp: normaliseIp(sourceIp) } };
}
