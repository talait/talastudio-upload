import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { open as pickFiles } from '@tauri-apps/plugin-dialog';
import { disable as autostartOff, enable as autostartOn, isEnabled as autostartIsOn } from '@tauri-apps/plugin-autostart';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';

// ---------- types ----------
type AppState = { registered: boolean; name: string | null; device_id: string | null; version: string; notify: string; paused: boolean };
type Download = { device_id: string; by: string; at: string };
type Version = {
  id: string; version: number | null; name: string; original_name: string; size: number; mime: string | null; note: string | null;
  status: 'uploading' | 'done' | 'failed' | 'cancelled'; progress: number; fail_reason: string | null; link: string | null;
  device_id: string; by: string; started_at: string; done_at: string | null; downloads: Download[];
};
type Item = { id: number; code: string; kind: string; updated_at: string; versions: Version[] };
type Job = {
  local_id: string; path: string; name: string; size: number; code: string; kind: string; note: string | null;
  state: 'hashing' | 'starting' | 'uploading' | 'done' | 'duplicate' | 'failed' | 'cancelled';
  bytes: number; version_id: string | null; version: number | null; stored_name: string | null; message: string | null; started_ms: number;
};
type FileInfo = { path: string; name: string; size: number; is_file: boolean };
type Code = { code: string; name: string | null };
type Pending = { path: string; name: string; size: number; kind: string };

// ---------- state ----------
let state: AppState;
let items: Item[] = [];
const jobs = new Map<string, Job>();
let codes: Code[] = [];
let pending: Pending[] = [];
let filter: 'all' | 'mine' | 'new' = 'all';
let query = '';
const open = new Set<number>();
const downloads = new Map<string, { bytes: number; total: number; path?: string; error?: string }>();
const previews = new Map<string, string | null>();
let online = true;
let mini = false;
let focusVersion: string | null = null;

const app = document.getElementById('app')!;
const veil = document.getElementById('drag-veil')!;

// ---------- helpers ----------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const mb = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const vnum = (n: number | null | undefined) => `v${String(n ?? 0).padStart(2, '0')}`;
const KIND_LABEL: Record<string, string> = { render: 'render', drawing: 'gambar kerja', model: 'model 3D', other: 'file' };
const kindLabel = (k: string) => KIND_LABEL[k] ?? 'file';

function kindOf(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'exr', 'hdr', 'psd'].includes(ext)) return 'render';
  if (['pdf', 'dwg', 'dxf', 'dwf'].includes(ext)) return 'drawing';
  if (['blend', 'skp', '3dm', 'max', 'fbx', 'obj', 'glb', 'gltf', '3ds', 'c4d', 'stl', 'step', 'stp'].includes(ext)) return 'model';
  return 'other';
}
const isImage = (name: string) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);

/** "DH-104" from "meja rias DH104 revisi.png" / "dh_104_render.jpg"; null when the name has no code. */
function codeOf(name: string): string | null {
  const m = /(?:^|[^A-Za-z])([A-Za-z]{2})[-_ ]?(\d{3})(?!\d)/.exec(name);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return 'baru saja';
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Kemarin ${d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

const ICON = {
  upload: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M6 10l6-6 6 6M5 20h14"/></svg>',
  down: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M6 10l6 6 6-6M5 20h14"/></svg>',
  gear: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  pin: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 4 4H6l4-4zM12 14v6"/></svg>',
  chev: '<svg class="icon chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  photo: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
  file: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
};

// ---------- per-person status ----------
const me = () => state.device_id ?? '';
const latestDone = (it: Item) => it.versions.find((v) => v.status === 'done');
const uploadingV = (it: Item) => it.versions.find((v) => v.status === 'uploading');
const hasMine = (v: Version) => v.device_id === me() || v.downloads.some((d) => d.device_id === me());

function itemStatus(it: Item): { label: string; cls: string; isNew: boolean } {
  const up = uploadingV(it);
  if (up) return { label: `Sedang diupload ${Math.floor((up.progress / Math.max(1, up.size)) * 100)}%`, cls: 'busy', isNew: false };
  const latest = latestDone(it);
  if (!latest) return { label: 'Gagal', cls: 'err', isNew: false };
  if (latest.device_id === me()) return { label: 'Kiriman saya', cls: 'plain', isNew: false };
  if (latest.downloads.some((d) => d.device_id === me())) return { label: 'Sudah diunduh', cls: 'ok', isNew: false };
  if (it.versions.some((v) => v.status === 'done' && hasMine(v))) return { label: 'Ada revisi', cls: 'rev', isNew: true };
  return { label: 'Baru', cls: 'new', isNew: true };
}

// ---------- rendering ----------
function renderWelcome(error = '') {
  app.innerHTML = `<main class="welcome"><form class="card" id="reg" novalidate>
    <img src="/icon.png" alt="" width="44" height="44">
    <h1>Selamat datang di TalaStudio Upload</h1>
    <p>Isi nama PC ini sekali saja. Nama ini muncul di riwayat setiap kali kamu mengirim file, dan bisa diganti kapan saja.</p>
    <label for="pcname" class="small muted">Nama PC atau pemiliknya</label>
    <input id="pcname" type="text" maxlength="60" placeholder="Rinto" autocomplete="off" ${error ? 'aria-invalid="true"' : ''} autofocus>
    ${error ? `<p class="field-error" id="regerr">${esc(error)}</p>` : ''}
    <button class="btn btn-accent" type="submit" id="regbtn">Mulai</button>
  </form></main>`;
  const form = document.getElementById('reg') as HTMLFormElement;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = (document.getElementById('pcname') as HTMLInputElement).value.trim();
    if (!name) return renderWelcome('Isi nama PC dulu.');
    const b = document.getElementById('regbtn') as HTMLButtonElement;
    b.disabled = true; b.textContent = 'Mendaftarkan…'; b.setAttribute('aria-busy', 'true');
    try {
      state = await invoke<AppState>('register', { name });
      await startMain();
    } catch (err) { renderWelcome(String(err)); }
  };
}

function shell() {
  app.innerHTML = `
    <header class="top">
      <div class="brand"><img src="/icon.png" alt="">TalaStudio Upload</div>
      <span class="who" id="who"></span>
      <button class="btn btn-ghost btn-sm" id="minibtn" title="Mode kecil, selalu di atas">${ICON.pin}<span>Mode kecil</span></button>
      <button class="btn btn-ghost btn-sm" id="setbtn" aria-label="Pengaturan">${ICON.gear}</button>
    </header>
    <div class="offline" id="offline" hidden>Tidak terhubung ke server. Upload dan riwayat menunggu sampai internet kembali.</div>
    <main class="main">
      <div class="drop" id="drop" role="button" tabindex="0">
        ${ICON.upload}<strong>Tarik file ke sini atau klik untuk memilih</strong>
        <span class="small muted">Render, gambar kerja, model 3D. Kode item di nama file (misalnya DH-104) dikenali otomatis.</span>
      </div>
      <div class="mini-sum" id="minisum"></div>
      <div id="ask"></div>
      <p class="section-title" id="jobs-title" hidden>Kiriman saya di PC ini</p>
      <div class="jobs" id="jobs"></div>
      <div class="filters" role="toolbar" aria-label="Saring">
        <button class="chip" data-f="all" aria-pressed="true">Semua</button>
        <button class="chip" data-f="mine" aria-pressed="false">Kiriman saya</button>
        <button class="chip" data-f="new" aria-pressed="false">Belum saya unduh <span id="newcount"></span></button>
        <input type="text" id="q" placeholder="Cari DH-104, koleksi, nama" aria-label="Cari">
      </div>
      <div class="items" id="items"></div>
    </main>
    <dialog id="settings"></dialog>`;
  (document.getElementById('drop') as HTMLElement).onclick = choose;
  (document.getElementById('drop') as HTMLElement).onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } };
  (document.getElementById('setbtn') as HTMLElement).onclick = openSettings;
  (document.getElementById('minibtn') as HTMLElement).onclick = toggleMini;
  document.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) => (c.onclick = () => {
    filter = c.dataset.f as typeof filter;
    document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
    renderItems();
  }));
  (document.getElementById('q') as HTMLInputElement).oninput = (e) => { query = (e.target as HTMLInputElement).value.toLowerCase(); renderItems(); };
  document.getElementById('items')!.addEventListener('click', onItemsClick);
  document.getElementById('jobs')!.addEventListener('click', onJobsClick);
  renderWho();
}

function renderWho() {
  const w = document.getElementById('who');
  if (w) w.textContent = `${state.name ?? ''}${state.paused ? ' · notifikasi dijeda' : ''}`;
  const off = document.getElementById('offline');
  if (off) off.hidden = online;
}

function renderAsk() {
  const box = document.getElementById('ask')!;
  const p = pending[0];
  if (!p) { box.innerHTML = ''; return; }
  const list = codes.map((c) => `<option value="${esc(c.code)}">${esc(c.name ?? '')}</option>`).join('');
  box.innerHTML = `<form class="card ask" id="askform" novalidate>
    <h3>${esc(p.name)} untuk item apa?${pending.length > 1 ? ` <span class="small">(${pending.length} file menunggu)</span>` : ''}</h3>
    <div class="row">
      <input type="text" id="askcode" list="codelist" placeholder="Kode item, misalnya DH-104, atau nama bebas" maxlength="80" autocomplete="off">
      <datalist id="codelist">${list}</datalist>
      <select id="askkind" aria-label="Jenis file">
        ${['render', 'drawing', 'model', 'other'].map((k) => `<option value="${k}" ${k === p.kind ? 'selected' : ''}>${kindLabel(k)}</option>`).join('')}
      </select>
    </div>
    <input type="text" id="asknote" placeholder="Catatan revisi (opsional)" maxlength="500">
    <p class="field-error" id="askerr" hidden></p>
    <div class="row">
      <button class="btn btn-accent" type="submit">Kirim</button>
      ${pending.length > 1 ? '<button class="btn" type="button" id="askall">Kirim semua dengan item ini</button>' : ''}
      <button class="btn btn-ghost" type="button" id="askskip">Lewati file ini</button>
    </div>
  </form>`;
  const code = document.getElementById('askcode') as HTMLInputElement;
  code.focus();
  const go = (all: boolean) => {
    const v = code.value.trim();
    const err = document.getElementById('askerr')!;
    if (!v) { code.setAttribute('aria-invalid', 'true'); err.hidden = false; err.textContent = 'Isi kode item atau nama dulu.'; return; }
    const kind = (document.getElementById('askkind') as HTMLSelectElement).value;
    const note = (document.getElementById('asknote') as HTMLInputElement).value;
    const take = all ? pending.splice(0) : pending.splice(0, 1);
    for (const f of take) void send(f.path, codeOf(v) ?? v, all ? kindOf(f.name) === 'other' ? kind : kindOf(f.name) : kind, note);
    renderAsk();
  };
  (document.getElementById('askform') as HTMLFormElement).onsubmit = (e) => { e.preventDefault(); go(false); };
  document.getElementById('askall')?.addEventListener('click', () => go(true));
  document.getElementById('askskip')!.onclick = () => { pending.shift(); renderAsk(); };
  code.oninput = () => { code.removeAttribute('aria-invalid'); document.getElementById('askerr')!.hidden = true; };
}

function jobView(j: Job): string {
  const pct = j.size ? Math.floor((j.bytes / j.size) * 100) : 0;
  const title = j.version ? `${esc(j.code)} · ${kindLabel(j.kind)} · ${vnum(j.version)}` : `${esc(j.code)} · ${kindLabel(j.kind)}`;
  const thumb = isImage(j.name) ? `<img src="${convertFileSrc(j.path)}" alt="">` : j.kind === 'render' ? ICON.photo : ICON.file;
  let line = '';
  let right = '';
  switch (j.state) {
    case 'hashing': line = `<div class="small muted">Memeriksa file… ${pct}%</div><div class="bar"><i style="width:${pct}%"></i></div>`; right = `<button class="btn btn-sm" data-cancel="${j.local_id}">Batal</button>`; break;
    case 'starting': line = '<div class="small muted">Menyiapkan upload…</div><div class="bar"><i style="width:0"></i></div>'; break;
    case 'uploading':
      line = `<div class="small muted">${mb(j.bytes)} dari ${mb(j.size)} · ${pct}%${j.message ? ` · <span class="msg-warn">${esc(j.message)}</span>` : ''}</div><div class="bar"><i style="width:${pct}%"></i></div>`;
      right = `<button class="btn btn-sm" data-cancel="${j.local_id}">Batal</button>`; break;
    case 'done':
      line = `<div class="small msg-ok">Terkirim${j.stored_name ? ` sebagai ${esc(j.stored_name)}` : ''}. Semua PC sudah bisa melihatnya.</div>
        <div class="small" style="margin-top:.35rem;display:flex;gap:.4rem"><input type="text" data-note="${j.version_id}" placeholder="Tambah catatan revisi (opsional)" maxlength="500" value="${esc(j.note ?? '')}" style="flex:1;min-height:1.85rem;font-size:.85rem"><button class="btn btn-sm" data-savenote="${j.version_id}">Simpan</button></div>`;
      right = `<button class="btn btn-ghost btn-sm" data-dismiss="${j.local_id}">Tutup</button>`; break;
    case 'duplicate': line = `<div class="small msg-warn">${esc(j.message)}</div>`; right = `<button class="btn btn-ghost btn-sm" data-dismiss="${j.local_id}">Tutup</button>`; break;
    case 'failed': line = `<div class="small msg-err">${esc(j.message ?? 'Upload gagal.')} Tarik file ini lagi untuk mencoba ulang.</div>`; right = `<button class="btn btn-ghost btn-sm" data-dismiss="${j.local_id}">Tutup</button>`; break;
    case 'cancelled': line = '<div class="small muted">Dibatalkan.</div>'; right = `<button class="btn btn-ghost btn-sm" data-dismiss="${j.local_id}">Tutup</button>`; break;
  }
  return `<div class="card job" data-job="${j.local_id}"><div class="thumb">${thumb}</div>
    <div class="grow"><div class="item-title ellipsis">${title}</div><div class="small muted ellipsis">${esc(j.name)}</div>${line}</div>${right}</div>`;
}

function renderJobs() {
  const box = document.getElementById('jobs');
  if (!box) return;
  const list = [...jobs.values()].sort((a, b) => b.started_ms - a.started_ms);
  document.getElementById('jobs-title')!.hidden = list.length === 0;
  // keep a note being typed: only replace cards whose state changed
  const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.dataset.note;
  if (typing) {
    for (const j of list) {
      const el = box.querySelector<HTMLElement>(`[data-job="${j.local_id}"]`);
      if (el && j.state !== 'done') el.outerHTML = jobView(j);
    }
    return;
  }
  box.innerHTML = list.map(jobView).join('');
  renderMiniSum();
}

function thumbFor(v: Version | undefined, kind: string): string {
  if (!v || v.status !== 'done') return kind === 'render' ? ICON.photo : ICON.file;
  const p = previews.get(v.id);
  if (p) return `<img src="${p}" alt="">`;
  if (!previews.has(v.id)) {
    previews.set(v.id, null);
    invoke<string | null>('preview', { versionId: v.id }).then((url) => {
      if (url) { previews.set(v.id, url); document.querySelectorAll<HTMLElement>(`[data-thumb="${v.id}"]`).forEach((e) => (e.innerHTML = `<img src="${url}" alt="">`)); }
    }).catch(() => undefined);
  }
  return kind === 'render' ? ICON.photo : ICON.file;
}

function dlView(id: string): string {
  const d = downloads.get(id);
  if (!d) return '';
  if (d.error) return `<span class="small msg-err">${esc(d.error)}</span>`;
  if (d.path) return `<button class="btn btn-sm" data-reveal="${esc(d.path)}">Buka folder</button>`;
  return `<span class="small muted">${d.total ? `${Math.floor((d.bytes / d.total) * 100)}%` : mb(d.bytes)}</span>`;
}

function renderItems() {
  const box = document.getElementById('items');
  if (!box) return;
  const visible = items.filter((it) => it.versions.some((v) => v.status === 'done' || v.status === 'uploading'));
  const newCount = visible.filter((it) => itemStatus(it).isNew).length;
  document.getElementById('newcount')!.textContent = newCount ? `(${newCount})` : '';
  const rows = visible.filter((it) => {
    if (filter === 'mine' && !it.versions.some((v) => v.device_id === me())) return false;
    if (filter === 'new' && !itemStatus(it).isNew) return false;
    if (query && !`${it.code} ${kindLabel(it.kind)} ${it.versions.map((v) => `${v.by} ${v.original_name} ${v.note ?? ''}`).join(' ')}`.toLowerCase().includes(query)) return false;
    return true;
  });
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${visible.length ? 'Tidak ada file di saringan ini.' : 'Belum ada file. Tarik file ke kotak di atas untuk mengirim yang pertama.'}</div>`;
    renderMiniSum();
    return;
  }
  box.innerHTML = rows.map((it) => {
    const latest = latestDone(it) ?? uploadingV(it)!;
    const st = itemStatus(it);
    const doneCount = it.versions.filter((v) => v.status === 'done').length;
    const isOpen = open.has(it.id);
    const head = `<div class="item-head" data-open="${it.id}">
      <div class="thumb" data-thumb="${latestDone(it)?.id ?? ''}">${thumbFor(latestDone(it), it.kind)}</div>
      <div class="grow">
        <div class="item-title ellipsis">${esc(it.code)} · ${kindLabel(it.kind)} · ${vnum(latest.version)} <span class="v">${doneCount > 1 ? `${doneCount} versi` : ''}</span></div>
        <div class="small muted ellipsis">${esc(latest.by)} · ${when(latest.done_at ?? latest.started_at)} · ${esc(latest.note || latest.original_name)}</div>
      </div>
      <span class="pill ${st.cls}">${esc(st.label)}</span>
      ${latestDone(it) ? (downloads.has(latestDone(it)!.id) ? dlView(latestDone(it)!.id) : `<button class="btn btn-sm" data-dl="${latestDone(it)!.id}" aria-label="Unduh versi terbaru">${ICON.down}Unduh</button>`) : ''}
      ${ICON.chev}
    </div>`;
    const vers = isOpen ? `<div class="versions">${it.versions.filter((v) => v.status === 'done' || v.status === 'uploading').map((v, i) => {
      const takers = v.downloads.filter((d) => d.device_id !== v.device_id).map((d) => `${esc(d.by)} ${when(d.at)}`).join(', ');
      const status = v.status === 'uploading' ? `<span class="pill busy">${Math.floor((v.progress / Math.max(1, v.size)) * 100)}%</span>` : i > 0 ? '<span class="pill plain">lama</span>' : '';
      return `<div class="ver"><span class="num">${vnum(v.version)}</span>
        <div class="grow"><div class="ellipsis">${esc(v.note || v.original_name)} ${status}</div>
        <div class="small muted ellipsis">${esc(v.by)} · ${when(v.done_at ?? v.started_at)} · ${mb(v.size)}${takers ? ` · diunduh: ${takers}` : ''}</div></div>
        ${v.status === 'done' ? `${v.link ? `<button class="btn btn-ghost btn-sm" data-link="${esc(v.link)}">Drive</button>` : ''}${downloads.has(v.id) ? dlView(v.id) : `<button class="btn btn-sm" data-dl="${v.id}">Unduh</button>`}` : ''}
      </div>`;
    }).join('')}</div>` : '';
    return `<div class="card item ${isOpen ? 'open' : ''} ${focusVersion && it.versions.some((v) => v.id === focusVersion) ? 'focus' : ''}" data-item="${it.id}">${head}${vers}</div>`;
  }).join('');
  renderMiniSum();
}

function renderMiniSum() {
  const el = document.getElementById('minisum');
  if (!el) return;
  const active = [...jobs.values()].filter((j) => ['hashing', 'starting', 'uploading'].includes(j.state)).length;
  const fresh = items.filter((it) => itemStatus(it).isNew).length;
  el.textContent = [active ? `${active} sedang upload` : 'Tidak ada upload berjalan', fresh ? `${fresh} file baru` : ''].filter(Boolean).join(' · ');
}

// ---------- actions ----------
async function choose() {
  const r = await pickFiles({ multiple: true, directory: false, title: 'Pilih file untuk dikirim' });
  if (!r) return;
  await addFiles(Array.isArray(r) ? r : [r]);
}

async function addFiles(paths: string[]) {
  const infos = await invoke<FileInfo[]>('file_info', { paths });
  for (const f of infos) {
    if (!f.is_file || f.size === 0) continue;
    const code = codeOf(f.name);
    if (code) void send(f.path, code, kindOf(f.name), null);
    else pending.push({ path: f.path, name: f.name, size: f.size, kind: kindOf(f.name) });
  }
  renderAsk();
}

async function send(path: string, code: string, kind: string, note: string | null) {
  try {
    const j = await invoke<Job>('start_upload', { path, code, kind, note: note || null });
    jobs.set(j.local_id, j);
    renderJobs();
  } catch (e) {
    const id = `x${Date.now()}`;
    jobs.set(id, { local_id: id, path, name: path.split(/[\\/]/).pop() ?? path, size: 0, code, kind, note, state: 'failed', bytes: 0, version_id: null, version: null, stored_name: null, message: String(e), started_ms: Date.now() });
    renderJobs();
  }
}

async function download(id: string) {
  downloads.set(id, { bytes: 0, total: 0 });
  renderItems();
  try {
    const path = await invoke<string>('download', { versionId: id });
    downloads.set(id, { bytes: 0, total: 0, path });
  } catch (e) {
    downloads.set(id, { bytes: 0, total: 0, error: String(e) });
  }
  renderItems();
}

function onItemsClick(e: Event) {
  const t = e.target as HTMLElement;
  const dl = t.closest<HTMLElement>('[data-dl]');
  if (dl) { e.stopPropagation(); void download(dl.dataset.dl!); return; }
  const rv = t.closest<HTMLElement>('[data-reveal]');
  if (rv) { e.stopPropagation(); void revealItemInDir(rv.dataset.reveal!); return; }
  const ln = t.closest<HTMLElement>('[data-link]');
  if (ln) { e.stopPropagation(); void openUrl(ln.dataset.link!); return; }
  const op = t.closest<HTMLElement>('[data-open]');
  if (op) { const id = Number(op.dataset.open); open.has(id) ? open.delete(id) : open.add(id); renderItems(); }
}

async function onJobsClick(e: Event) {
  const t = e.target as HTMLElement;
  const c = t.closest<HTMLElement>('[data-cancel]');
  if (c) { await invoke('cancel_upload', { localId: c.dataset.cancel }); return; }
  const d = t.closest<HTMLElement>('[data-dismiss]');
  if (d) { jobs.delete(d.dataset.dismiss!); await invoke('dismiss_upload', { localId: d.dataset.dismiss }).catch(() => undefined); renderJobs(); return; }
  const s = t.closest<HTMLButtonElement>('[data-savenote]');
  if (s) {
    const id = s.dataset.savenote!;
    const input = document.querySelector<HTMLInputElement>(`[data-note="${id}"]`);
    s.disabled = true; s.textContent = 'Menyimpan…';
    try {
      await invoke('set_note', { versionId: id, note: input?.value ?? '' });
      for (const j of jobs.values()) if (j.version_id === id) j.note = input?.value ?? '';
      s.textContent = 'Tersimpan';
    } catch (err) { s.textContent = 'Gagal, coba lagi'; s.title = String(err); }
    s.disabled = false;
  }
}

async function toggleMini() {
  mini = !mini;
  document.body.classList.toggle('mini', mini);
  const w = getCurrentWindow();
  await w.setAlwaysOnTop(mini);
  await w.setSize(new LogicalSize(mini ? 320 : 980, mini ? 230 : 700));
  const b = document.getElementById('minibtn')!;
  b.innerHTML = mini ? `${ICON.pin}<span>Ukuran penuh</span>` : `${ICON.pin}<span>Mode kecil</span>`;
}

async function openSettings() {
  const dlg = document.getElementById('settings') as HTMLDialogElement;
  const auto = await autostartIsOn().catch(() => false);
  dlg.innerHTML = `<form class="dlg" method="dialog" id="setform">
    <h2>Pengaturan</h2>
    <fieldset><legend>Nama PC</legend>
      <div class="row"><input type="text" id="newname" maxlength="60" value="${esc(state.name ?? '')}"><button class="btn" type="button" id="renamebtn">Simpan</button></div>
      <p class="field-error" id="renameerr" hidden></p>
      <span class="small muted">Nama ini tampil di riwayat semua PC, termasuk untuk kiriman lama.</span>
    </fieldset>
    <fieldset><legend>Notifikasi Windows</legend>
      ${[['all', 'Semua upload dari orang lain'], ['downloaded', 'Hanya revisi file yang pernah saya unduh'], ['off', 'Mati']].map(([v, l]) =>
        `<label class="opt"><input type="radio" name="notify" value="${v}" ${state.notify === v ? 'checked' : ''}> ${l}</label>`).join('')}
    </fieldset>
    <fieldset><legend>Saat Windows menyala</legend>
      <label class="opt"><input type="checkbox" id="autostart" ${auto ? 'checked' : ''}> Buka TalaStudio Upload otomatis</label>
    </fieldset>
    <footer><span class="small muted">Versi ${esc(state.version)} · <button class="btn btn-ghost btn-sm" type="button" id="updbtn">Cek pembaruan</button></span>
      <button class="btn btn-accent" value="close">Selesai</button></footer>
  </form>`;
  dlg.showModal();
  document.getElementById('renamebtn')!.onclick = async () => {
    const b = document.getElementById('renamebtn') as HTMLButtonElement;
    const err = document.getElementById('renameerr')!;
    b.disabled = true; b.textContent = 'Menyimpan…';
    try { state = await invoke<AppState>('rename', { name: (document.getElementById('newname') as HTMLInputElement).value }); b.textContent = 'Tersimpan'; err.hidden = true; renderWho(); }
    catch (e) { err.hidden = false; err.textContent = String(e); b.textContent = 'Simpan'; }
    b.disabled = false;
  };
  dlg.querySelectorAll<HTMLInputElement>('input[name="notify"]').forEach((r) => (r.onchange = async () => { state = await invoke<AppState>('set_notify', { mode: r.value }); }));
  (document.getElementById('autostart') as HTMLInputElement).onchange = async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    await (on ? autostartOn() : autostartOff()).catch(() => undefined);
  };
  document.getElementById('updbtn')!.onclick = async () => {
    const b = document.getElementById('updbtn') as HTMLButtonElement;
    b.disabled = true; b.textContent = 'Memeriksa…';
    try {
      const v = await invoke<string | null>('check_update');
      b.textContent = v ? `Memasang ${v}…` : 'Sudah versi terbaru';
    } catch (e) { b.textContent = 'Gagal memeriksa'; b.title = String(e); }
    b.disabled = false;
  };
}

// ---------- start ----------
async function startMain() {
  shell();
  items = await invoke<Item[]>('items');
  for (const j of await invoke<Job[]>('upload_list')) jobs.set(j.local_id, j);
  renderItems();
  renderJobs();
  invoke<Code[]>('codes').then((c) => { codes = c; if (pending.length) renderAsk(); }).catch(() => undefined);
}

async function main() {
  state = await invoke<AppState>('get_state');

  await listen<Item[]>('items', (e) => { items = e.payload; renderItems(); });
  await listen<Job>('upload', (e) => { jobs.set(e.payload.local_id, e.payload); renderJobs(); });
  await listen<{ version_id: string; bytes: number; total: number; path?: string }>('download', (e) => {
    const d = downloads.get(e.payload.version_id);
    if (d && !d.path) { d.bytes = e.payload.bytes; d.total = e.payload.total; renderItems(); }
  });
  await listen<boolean>('online', (e) => { online = e.payload; renderWho(); });
  await listen<string[]>('files-dropped', (e) => { if (state.registered) void addFiles(e.payload); });
  await listen('pick-files', () => { if (state.registered) void choose(); });
  await listen('settings-changed', async () => { state = await invoke<AppState>('get_state'); renderWho(); });
  await listen<string>('focus-version', (e) => {
    focusVersion = e.payload;
    const it = items.find((i) => i.versions.some((v) => v.id === e.payload));
    if (it) { open.add(it.id); filter = 'all'; renderItems(); document.querySelector(`[data-item="${it.id}"]`)?.scrollIntoView({ block: 'center' }); }
    setTimeout(() => { focusVersion = null; renderItems(); }, 4000);
  });

  await getCurrentWebview().onDragDropEvent((e) => {
    if (!state.registered) return;
    if (e.payload.type === 'enter' || e.payload.type === 'over') veil.hidden = false;
    else if (e.payload.type === 'leave') veil.hidden = true;
    else if (e.payload.type === 'drop') { veil.hidden = true; void addFiles(e.payload.paths); }
  });

  setInterval(() => { if (state.registered) renderItems(); }, 60_000); // keep "5 menit lalu" fresh

  if (state.registered) await startMain();
  else renderWelcome();
}

void main();
