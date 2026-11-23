import { closeClient, one, requestStore, sql, type Env } from './db';
import { ensureFolder, fileStream, getFile, startResumable, thumbnail } from './google';
import { verifyGithubOidc } from './oidc';

/**
 * upload.talastudio.net: the server of the TalaStudio upload Windows app.
 * Every /api call carries the PC's device token (Authorization: Bearer …), made once at install by /api/register.
 * The bytes never pass through here on the way up: the PC sends them straight to a Google Drive resumable session.
 */
const VERSION = '2026-11-23.2';

type Json = Record<string, unknown>;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (message: string, status: number) => json({ error: message }, status);

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function bearer(req: Request): string {
  const t = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!t) throw new HttpError(401, 'PC ini belum terdaftar. Buka aplikasi dan isi nama PC.');
  return t;
}
const appVersion = (req: Request) => (req.headers.get('x-app-version') ?? '').slice(0, 40) || null;
async function body(req: Request): Promise<Json> {
  try { return (await req.json()) as Json; } catch { throw new HttpError(400, 'Isi permintaan bukan JSON.'); }
}
const uuid = (s: string) => { if (!/^[0-9a-f-]{36}$/i.test(s)) throw new HttpError(404, 'Tidak ditemukan.'); return s; };

/** Map database errors raised by filedrop.* to HTTP answers with the message people can act on. */
function dbError(e: unknown): Response {
  const err = e as { code?: string; message?: string };
  if (e instanceof HttpError) return fail(e.message, e.status);
  if (typeof (e as { status?: unknown }).status === 'number') return fail(err.message ?? 'Ditolak.', (e as { status: number }).status);
  if (err.code === '28000') return fail('PC ini tidak dikenal atau sudah dicabut. Pasang ulang aplikasinya atau hubungi IT.', 401);
  if (err.code === '22023') return fail(err.message ?? 'Permintaan tidak valid.', 400);
  if (err.code === 'P0002') return fail(err.message ?? 'Tidak ditemukan.', 404);
  if (err.code === '54000') return fail(err.message ?? 'Terlalu banyak permintaan.', 429);
  console.error(err);
  return fail(`Server bermasalah: ${(err.message ?? 'error').slice(0, 200)}`, 500);
}

const cmp = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
const contentDisposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = (re: RegExp) => re.exec(p);

  if (p === '/' && req.method === 'GET') return new Response(`TalaStudio upload server ${VERSION}\n`, { headers: { 'content-type': 'text/plain' } });

  // ---- install: register this PC (no login; the person types the PC name) ----
  if (p === '/api/register' && req.method === 'POST') {
    const b = await body(req);
    return json(await one(sql`select filedrop.device_register(${String(b.name ?? '')}, ${String(b.os ?? '').slice(0, 80)}, ${appVersion(req)}) as r`));
  }
  if (p === '/api/me' && req.method === 'GET') return json(await one(sql`select filedrop.me(${bearer(req)}, ${appVersion(req)}) as r`));
  if (p === '/api/rename' && req.method === 'POST') {
    const b = await body(req);
    return json(await one(sql`select filedrop.device_rename(${bearer(req)}, ${String(b.name ?? '')}) as r`));
  }
  if (p === '/api/codes' && req.method === 'GET') return json({ codes: await one(sql`select filedrop.codes(${bearer(req)}) as r`) });

  // ---- shared history (the app polls this every few seconds) ----
  if (p === '/api/feed' && req.method === 'GET') {
    const since = url.searchParams.get('since');
    const s = since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : null;
    return json(await one(sql`select filedrop.feed(${bearer(req)}, ${s}::timestamptz) as r`));
  }

  // ---- uploads ----
  if (p === '/api/uploads' && req.method === 'POST') {
    const token = bearer(req);
    const b = await body(req);
    const size = Number(b.size);
    if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'Ukuran file tidak valid.');
    const start = await one<Json>(sql`select filedrop.upload_start(${token}, ${String(b.name ?? '').slice(0, 255)}, ${size}, ${String(b.sha256 ?? '')},
      ${String(b.mime ?? 'application/octet-stream').slice(0, 120)}, ${String(b.code ?? '')}, ${String(b.kind ?? 'other')}, ${b.note ? String(b.note) : null}) as r`);
    if (start.duplicate) return json(start);
    const id = String(start.version_id);
    try {
      const driveId = String(start.drive_id ?? ''), root = String(start.drive_root ?? '');
      if (!driveId || !root) throw new Error('Folder Drive upload belum disetel (upload.drive_id / upload.drive_root).');
      let parent = root;
      for (const f of ['_UPLOAD', String(start.code)]) parent = await ensureFolder(f, parent, driveId);
      const session = await startResumable({
        name: String(start.stored_name), mime: String(b.mime ?? 'application/octet-stream'), size, parentId: parent,
        description: `Dikirim dari aplikasi TalaStudio upload oleh ${start.by} (file asli: ${String(b.name ?? '').slice(0, 200)}).${b.note ? `\n${String(b.note).slice(0, 500)}` : ''}`,
        appProperties: { ts_source: 'filedrop', ts_version_id: id, ts_item: String(start.code).slice(0, 100) },
      });
      await sql`select filedrop.upload_session(${token}, ${id}::uuid, ${session}, ${driveId})`;
      return json({ version_id: id, version: start.version, code: start.code, kind: start.kind, stored_name: start.stored_name, session_url: session });
    } catch (e) {
      await sql`select filedrop.upload_fail(${token}, ${id}::uuid, false, ${(e as Error).message.slice(0, 280)})`.catch(() => undefined);
      throw new HttpError(502, `Tidak bisa membuka upload ke Drive: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  let r = m(/^\/api\/uploads\/([^/]+)\/(progress|done|fail|resume)$/);
  if (r && req.method === 'POST') {
    const token = bearer(req), id = uuid(r[1]), b = await body(req);
    if (r[2] === 'progress') return json(await one(sql`select filedrop.upload_progress(${token}, ${id}::uuid, ${Math.max(0, Math.floor(Number(b.bytes) || 0))}) as r`));
    if (r[2] === 'resume') {
      const s = await one<Json | null>(sql`select filedrop.upload_resume(${token}, ${id}::uuid) as r`);
      if (!s?.session_url) throw new HttpError(410, 'Upload ini sudah tidak aktif. Kirim ulang filenya.');
      return json(s);
    }
    if (r[2] === 'fail') {
      await sql`select filedrop.upload_fail(${token}, ${id}::uuid, ${b.cancelled === true}, ${String(b.reason ?? '').slice(0, 280)})`;
      return json({ ok: true });
    }
    // done: check the Drive file really holds the whole upload before telling everyone
    const s = await one<Json | null>(sql`select filedrop.upload_resume(${token}, ${id}::uuid) as r`);
    const fileId = String(b.file_id ?? '');
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new HttpError(400, 'ID file Drive tidak valid.');
    const f = await getFile(fileId);
    if (s && Number(f.size) !== Number(s.size)) {
      await sql`select filedrop.upload_fail(${token}, ${id}::uuid, false, ${`Ukuran di Drive ${f.size} byte, seharusnya ${s.size}.`})`;
      throw new HttpError(409, 'File di Drive tidak lengkap. Kirim ulang filenya.');
    }
    return json(await one(sql`select filedrop.upload_done(${token}, ${id}::uuid, ${f.id}, ${f.webViewLink ?? null}) as r`));
  }
  r = m(/^\/api\/versions\/([^/]+)\/note$/);
  if (r && req.method === 'POST') {
    const b = await body(req);
    await sql`select filedrop.version_note(${bearer(req)}, ${uuid(r[1])}::uuid, ${String(b.note ?? '')})`;
    return json({ ok: true });
  }

  // ---- downloads and previews ----
  r = m(/^\/api\/versions\/([^/]+)\/download$/);
  if (r && req.method === 'GET') {
    const d = await one<{ drive_file_id: string; name: string; mime: string; size: number }>(sql`select filedrop.download(${bearer(req)}, ${uuid(r[1])}::uuid) as r`);
    const g = await fileStream(d.drive_file_id, req.headers.get('range'));
    if (!g.ok && g.status !== 206) throw new HttpError(502, `Google Drive ${g.status}: file tidak bisa diambil.`);
    const h = new Headers({ 'content-type': d.mime || 'application/octet-stream', 'content-disposition': contentDisposition(d.name), 'cache-control': 'no-store' });
    for (const k of ['content-length', 'content-range', 'accept-ranges']) { const v = g.headers.get(k); if (v) h.set(k, v); }
    return new Response(g.body, { status: g.status, headers: h });
  }
  r = m(/^\/api\/versions\/([^/]+)\/preview$/);
  if (r && req.method === 'GET') {
    const d = await one<{ drive_file_id: string } | null>(sql`select filedrop.preview(${bearer(req)}, ${uuid(r[1])}::uuid) as r`);
    if (!d?.drive_file_id) throw new HttpError(404, 'Belum ada pratinjau.');
    const t = await thumbnail(d.drive_file_id, Math.min(1600, Math.max(64, Number(url.searchParams.get('s')) || 480)));
    if (!t) return new Response(null, { status: 204, headers: { 'cache-control': 'private, max-age=300' } });
    return new Response(t.body, { headers: { 'content-type': t.headers.get('content-type') ?? 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
  }

  // ---- app updates (Tauri updater) ----
  if (p === '/app/update' && req.method === 'GET') {
    const latest = await one<Json | null>(sql`select filedrop.release_latest(${bearer(req)}) as r`);
    const current = (url.searchParams.get('current') ?? '0.0.0').replace(/^v/, '');
    if (!latest || cmp(String(latest.version), current) <= 0) return new Response(null, { status: 204 });
    return json({
      version: latest.version, notes: latest.notes ?? '', pub_date: latest.pub_date, signature: latest.signature,
      url: `${url.origin}/app/download/${latest.version}`,
    });
  }
  r = m(/^\/app\/download\/(\d+\.\d+\.\d+)$/);
  if (r && req.method === 'GET') {
    const rows = (await sql`select filedrop.release_file(${bearer(req)}, ${r[1]}) as r`) as unknown as { r: Uint8Array | null }[];
    const bytes = rows[0]?.r;
    if (!bytes) throw new HttpError(404, 'Versi ini tidak ada.');
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': contentDisposition(`TalaStudio-Upload_${r[1]}_x64-setup.exe`), 'cache-control': 'no-store' } });
  }
  if (p === '/app/publish' && req.method === 'POST') {
    const claims = await verifyGithubOidc(req.headers.get('authorization'), url.host, env.GITHUB_REPO ?? 'talait/talastudio-upload');
    const form = await req.formData();
    const version = String(form.get('version') ?? '').replace(/^v/, '');
    const file = form.get('installer') as unknown as File | null;
    const signature = String(form.get('signature') ?? '');
    if (!/^\d+\.\d+\.\d+$/.test(version) || !file || !signature) throw new HttpError(400, 'Kirim version, signature, dan installer.');
    if (claims.ref !== `refs/tags/v${version}`) throw new HttpError(403, `Tag ${claims.ref} tidak cocok dengan versi ${version}.`);
    const buf = new Uint8Array(await file.arrayBuffer());
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join('');
    return json(await one(sql`select filedrop.release_publish(${version}, ${String(form.get('notes') ?? '')}, ${file.name}, ${signature}, ${sha}, ${Buffer.from(buf)}) as r`));
  }

  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(req.url);
    const store = { env } as Parameters<typeof closeClient>[0];
    return requestStore.run(store, async () => {
      try {
        return await route(req, env, url);
      } catch (e) {
        return dbError(e);
      } finally {
        ctx.waitUntil(closeClient(store));
      }
    });
  },
};
