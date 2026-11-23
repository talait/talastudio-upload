/**
 * GitHub Actions OIDC: the release workflow asks GitHub for a short-lived signed token (audience = this host) and sends it
 * with the installer. We check GitHub's signature, the repository and that it runs for main or a version tag, so publishing an
 * update needs no shared secret at all.
 */
const ISSUER = 'https://token.actions.githubusercontent.com';
type Claims = { iss: string; aud: string | string[]; exp: number; nbf?: number; repository: string; ref: string; workflow_ref?: string };

const jwksCache = globalThis as unknown as { __ghJwks?: { at: number; keys: (JsonWebKey & { kid: string })[] } };

const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function keys(force = false) {
  if (!force && jwksCache.__ghJwks && Date.now() - jwksCache.__ghJwks.at < 3600_000) return jwksCache.__ghJwks.keys;
  const r = await fetch(`${ISSUER}/.well-known/jwks`);
  const j = (await r.json()) as { keys: (JsonWebKey & { kid: string })[] };
  jwksCache.__ghJwks = { at: Date.now(), keys: j.keys };
  return j.keys;
}

export async function verifyGithubOidc(auth: string | null, audience: string, repo: string): Promise<Claims> {
  const deny = (why: string) => Object.assign(new Error(`Publish refused: ${why}`), { status: 403 });
  const token = /^Bearer\s+(\S+)$/.exec(auth ?? '')?.[1];
  if (!token) throw Object.assign(deny('no GitHub OIDC token'), { status: 401 });
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw deny('malformed token');
  let header: { alg: string; kid: string };
  try { header = JSON.parse(new TextDecoder().decode(unb64(h))); } catch { throw deny('malformed token'); }
  if (header.alg !== 'RS256') throw deny('token algorithm');
  let jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw deny('unknown GitHub key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  let ok = false;
  try { ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(s), new TextEncoder().encode(`${h}.${p}`)); } catch { ok = false; }
  if (!ok) throw deny('signature does not match');
  const c = JSON.parse(new TextDecoder().decode(unb64(p))) as Claims;
  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== ISSUER) throw deny('issuer');
  if (!(Array.isArray(c.aud) ? c.aud.includes(audience) : c.aud === audience)) throw deny('audience');
  if (c.exp < now - 30 || (c.nbf && c.nbf > now + 30)) throw deny('token expired');
  if (c.repository !== repo) throw deny(`repo ${c.repository}`);
  if (!/^refs\/(tags\/v\d+\.\d+\.\d+|heads\/main)$/.test(c.ref)) throw deny(`ref ${c.ref}`);
  return c;
}
