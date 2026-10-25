import crypto from 'node:crypto';
export function generateApiKey() {
  return `tai_${crypto.randomBytes(24).toString('base64url')}`;
}
export function hashKey(key: string) {
  return crypto.createHash('sha256').update(key).digest('hex');
}
export function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
export function normalizeDomain(value: string) {
  let u: URL;
  try {
    u = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new Error('Invalid domain');
  }
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || u.username || u.password) throw new Error('Invalid domain');
  return h + (u.port ? `:${u.port}` : '');
}
export function originMatches(origin: string, allowed: string[]) {
  try {
    return allowed.includes(normalizeDomain(origin));
  } catch {
    return false;
  }
}
export function safeSegment(v: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(v)) throw new Error('Unsafe path segment');
  return v;
}
