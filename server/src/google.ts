/**
 * Google Drive as the service account that is a member of the Shared Drive TALASTUDIO ASSETS.
 * Secret GOOGLE_SA_KEY (dashboard only, never in the repo) = the JSON key, the same value as on the workspace Worker.
 * The PCs never see this key: the Worker opens a resumable upload session and hands the PC only that session address.
 */
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,webViewLink,thumbnailLink,hasThumbnail,driveId';

export type DriveFile = {
  id: string; name: string; mimeType: string; size?: string; md5Checksum?: string; webViewLink?: string;
  thumbnailLink?: string; hasThumbnail?: boolean; driveId?: string;
};

const cache = globalThis as unknown as { __gTok?: { token: string; exp: number } };

const b64url = (buf: ArrayBuffer | string) => {
  const bytes = typeof buf === 'string' ? new TextEncoder().encode(buf) : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function googleToken(): Promise<string> {
  if (cache.__gTok && cache.__gTok.exp > Date.now() + 60_000) return cache.__gTok.token;
  const raw = process.env.GOOGLE_SA_KEY;
  if (!raw) throw new Error('Server belum disetel: GOOGLE_SA_KEY belum diisi di Worker.');
  const key = JSON.parse(raw) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = key.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(`${header}.${claims}`));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!j.access_token) throw new Error(`Google token: ${j.error_description ?? j.error ?? res.status}`);
  cache.__gTok = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

async function gfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await googleToken();
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const t = await res.text();
    let msg = t.slice(0, 300);
    try { msg = (JSON.parse(t) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* not JSON */ }
    throw new Error(`Google Drive ${res.status}: ${msg}`);
  }
  return res;
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Subfolder `name` of `parentId`, made when missing. */
export async function ensureFolder(name: string, parentId: string, driveId: string): Promise<string> {
  const params = new URLSearchParams({
    q: `name = '${q(name)}' and '${q(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: '5', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'drive', driveId,
  });
  const found = (await (await gfetch(`${DRIVE}/files?${params}`)).json()) as { files?: { id: string }[] };
  if (found.files?.[0]) return found.files[0].id;
  const created = (await (await gfetch(`${DRIVE}/files?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  })).json()) as { id: string };
  return created.id;
}

/** Open a resumable upload session; the PC PUTs the bytes to the returned address itself. */
export async function startResumable(o: {
  name: string; mime: string; size: number; parentId: string; description?: string; appProperties?: Record<string, string>;
}): Promise<string> {
  const res = await gfetch(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': o.mime || 'application/octet-stream',
      'X-Upload-Content-Length': String(o.size),
    },
    body: JSON.stringify({ name: o.name, parents: [o.parentId], description: o.description, appProperties: o.appProperties }),
  });
  const loc = res.headers.get('location');
  if (!loc) throw new Error('Google Drive tidak memberi alamat upload.');
  return loc;
}

export async function getFile(id: string): Promise<DriveFile> {
  return (await (await gfetch(`${DRIVE}/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${FILE_FIELDS}`)).json()) as DriveFile;
}

/** The file's bytes as a stream (no copy in the Worker). */
export async function fileStream(id: string, range?: string | null): Promise<Response> {
  const token = await googleToken();
  return fetch(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) },
  });
}

/** A small preview picture Drive made for the file (images, PDFs, many others); null when Drive has none yet. */
export async function thumbnail(id: string, size = 480): Promise<Response | null> {
  const f = await getFile(id);
  if (!f.thumbnailLink) return null;
  const token = await googleToken();
  const url = f.thumbnailLink.replace(/=s\d+$/, `=s${size}`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res : null;
}
