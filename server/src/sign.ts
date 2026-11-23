/**
 * Signs app installers for the Tauri updater (minisign format, Ed25519), so the GitHub build needs no signing secret.
 * The private key is the Worker secret UPDATER_SIGNING_KEY = {"pkcs8":"<base64 DER>","keynum":"<16 hex>"}; the
 * matching public key is in app/src-tauri/tauri.conf.json (plugins.updater.pubkey). Apps refuse any installer whose
 * signature does not match, and the signed trusted comment carries the version (requireSignedVersion), so an old
 * genuine installer cannot be served as a newer one.
 *
 * Format (what minisign-verify in tauri-plugin-updater reads, after base64-decoding the whole text):
 *   untrusted comment: signature from tauri secret key
 *   base64("Ed" | keynum[8] | ed25519(file)[64])
 *   trusted comment: timestamp:<unix>\tfile:<name>\tversion:<x.y.z>
 *   base64(ed25519(signature[64] | trusted comment text)[64])
 */
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

export async function signInstaller(secretJson: string, file: Uint8Array, fileName: string, version: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const { pkcs8, keynum } = JSON.parse(secretJson) as { pkcs8: string; keynum: string };
  const key = await crypto.subtle.importKey('pkcs8', unb64(pkcs8), { name: 'Ed25519' }, false, ['sign']);
  const kn = hexBytes(keynum);
  if (kn.length !== 8) throw new Error('UPDATER_SIGNING_KEY keynum must be 8 bytes');
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, file));
  const trusted = `timestamp:${now}\tfile:${fileName.replace(/[\t\r\n]/g, ' ')}\tversion:${version}`;
  const global = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, cat(sig, enc.encode(trusted))));
  const text = `untrusted comment: signature from tauri secret key\n${b64(cat(enc.encode('Ed'), kn, sig))}\ntrusted comment: ${trusted}\n${b64(global)}\n`;
  return b64(enc.encode(text));
}
