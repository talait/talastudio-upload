import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { open as pickFiles } from '@tauri-apps/plugin-dialog';
import { disable as autostartOff, enable as autostartOn, isEnabled as autostartIsOn } from '@tauri-apps/plugin-autostart';

// ---------- types ----------
type AppState = { registered: boolean; name: string | null; device_id: string | null; version: string; notify: string; paused: boolean; seen: string[] };
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

// ---------- state ----------
let state: AppState;
let items: Item[] = [];
const jobs = new Map<string, Job>();
let filter: 'all' | 'mine' | 'new' = 'all';
let query = '';
const open = new Set<number>();
const downloads = new Map<string, { bytes: number; total: number; path?: string; error?: string }>();
const previews = new Map<string, string | null>();
let online = true;
const seen = new Set<string>();
type Drop = { path: string; name: string; size: number; kind: string; label: string };
let dropped: Drop[] = [];
const skipNaming = () => { try { return localStorage.getItem('skipNaming') === '1'; } catch { return false; } };
let mini = false;
let focusVersion: string | null = null;

const app = document.getElementById('app')!;
const veil = document.getElementById('drag-veil')!;

// ---------- helpers ----------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const mb = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const vnum = (n: number | null | undefined) => `v${String(n ?? 0).padStart(2, '0')}`;
const KIND_LABEL: Record<string, string> = { render: 'render', drawing: 'drawing', model: '3D model', other: 'file' };
const kindLabel = (k: string) => KIND_LABEL[k] ?? 'file';

function kindOf(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'exr', 'hdr', 'psd'].includes(ext)) return 'render';
  if (['pdf', 'dwg', 'dxf', 'dwf'].includes(ext)) return 'drawing';
  if (['blend', 'skp', '3dm', 'max', 'fbx', 'obj', 'glb', 'gltf', '3ds', 'c4d', 'stl', 'step', 'stp'].includes(ext)) return 'model';
  return 'other';
}
const isImage = (name: string) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);

/**
 * The item a file belongs to is its own name, without the extension and without revision endings, so
 * "DOHEY TALLBOY 4 DRAWERS rev2.blend" and "dohey tallboy 4 drawers (1).blend" are versions of the same item.
 * Matching ignores letter case (the server does that); the first name sent is the one everyone sees.
 */
function itemName(fileName: string): string {
  let n = fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  const endings = [
    /[\s\-.]*\(\d+\)$/, // "name (1)"
    /[\s\-.]*-?\s*copy( \(\d+\))?$/i, // "name - Copy"
    /[\s\-.]+(?:v|ver|version|rev|revisi|revision|r)[\s.]*\d+[a-z]?$/i, // "name v2", "name rev 3", "name r2"
    /[\s\-.]+(?:final|fix|fixed)$/i, // "name final"
  ];
  for (let changed = true; changed;) {
    changed = false;
    for (const re of endings) {
      const m = n.replace(re, '').trim();
      if (m && m !== n) { n = m; changed = true; }
    }
  }
  return (n || fileName).slice(0, 80);
}

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
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

function itemStatus(it: Item): { label: string; cls: string; isNew: boolean; unseen?: boolean } {
  const up = uploadingV(it);
  if (up) return { label: `Uploading ${Math.floor((up.progress / Math.max(1, up.size)) * 100)}%`, cls: 'busy', isNew: false };
  const latest = latestDone(it);
  if (!latest) return { label: 'Failed', cls: 'err', isNew: false };
  if (latest.device_id === me()) return { label: 'Sent by me', cls: 'plain', isNew: false };
  if (latest.downloads.some((d) => d.device_id === me())) return { label: 'Downloaded', cls: 'ok', isNew: false };
  // seen = row opened / opened from a notification: still not downloaded, but no longer counted on the taskbar
  if (seen.has(latest.id)) return { label: 'Not downloaded', cls: 'plain', isNew: true, unseen: false };
  if (it.versions.some((v) => v.status === 'done' && hasMine(v))) return { label: 'New revision', cls: 'rev', isNew: true, unseen: true };
  return { label: 'New', cls: 'new', isNew: true, unseen: true };
}

// ---------- rendering ----------
function renderWelcome(error = '') {
  app.innerHTML = `<main class="welcome"><form class="card" id="reg" novalidate>
    <img src="/icon.png" alt="" width="44" height="44">
    <h1>Welcome to TalaStudio Upload</h1>
    <p>Type a name for this PC once. It shows in the history every time you send a file, and you can change it any time.</p>
    <label for="pcname" class="small muted">PC name or owner</label>
    <input id="pcname" type="text" maxlength="60" placeholder="Rinto" autocomplete="off" ${error ? 'aria-invalid="true"' : ''} autofocus>
    ${error ? `<p class="field-error" id="regerr">${esc(error)}</p>` : ''}
    <button class="btn btn-accent" type="submit" id="regbtn">Start</button>
  </form></main>`;
  const form = document.getElementById('reg') as HTMLFormElement;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = (document.getElementById('pcname') as HTMLInputElement).value.trim();
    if (!name) return renderWelcome('Type a PC name first.');
    const b = document.getElementById('regbtn') as HTMLButtonElement;
    b.disabled = true; b.textContent = 'Registering…'; b.setAttribute('aria-busy', 'true');
    try {
      state = await invoke<AppState>('register', { name });
      await startMain();
    } catch (err) { renderWelcome(String(err)); }
  };
}

function shell() {
  app.innerHTML = `
    <header class="top">
      <div class="brand"><img src="/icon.png" alt=""><span>TalaStudio Upload</span></div>
      <span class="who" id="who"></span>
      <button class="btn btn-ghost btn-sm" id="minibtn" title="Compact mode, always on top">${ICON.pin}<span>Compact</span></button>
      <button class="btn btn-ghost btn-sm" id="setbtn" aria-label="Settings">${ICON.gear}</button>
    </header>
    <div class="offline" id="offline" hidden>Not connected to the server. Uploads and history wait until the internet is back.</div>
    <main class="main">
      <div class="drop" id="drop" role="button" tabindex="0">
        ${ICON.upload}<strong>Drag files here or click to choose</strong>
        <span class="small muted">Renders, drawings, 3D models. Keep the file name or type a new one; the same name again becomes the next version.</span>
      </div>
      <div class="mini-sum" id="minisum"></div>
      <div id="naming"></div>
      <p class="section-title" id="jobs-title" hidden>Sent from this PC</p>
      <div class="jobs" id="jobs"></div>
      <div class="filters" role="toolbar" aria-label="Filter">
        <button class="chip" data-f="all" aria-pressed="true">All</button>
        <button class="chip" data-f="mine" aria-pressed="false">Sent by me</button>
        <button class="chip" data-f="new" aria-pressed="false">Not downloaded yet <span id="newcount"></span></button>
        <button class="btn btn-ghost btn-sm" id="seenall" hidden>Mark all as seen</button>
        <input type="text" id="q" placeholder="Search DH-104, collection, name" aria-label="Search">
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
  (document.getElementById('seenall') as HTMLButtonElement).onclick = () => {
    const ids = items.filter((it) => itemStatus(it).unseen).map((it) => latestDone(it)!.id);
    markSeen(ids);
  };
  (document.getElementById('q') as HTMLInputElement).oninput = (e) => { query = (e.target as HTMLInputElement).value.toLowerCase(); renderItems(); };
  document.getElementById('items')!.addEventListener('click', onItemsClick);
  document.getElementById('jobs')!.addEventListener('click', onJobsClick);
  renderWho();
}

function renderWho() {
  const w = document.getElementById('who');
  if (w) w.textContent = `${state.name ?? ''}${state.paused ? ' · notifications paused' : ''}`;
  const off = document.getElementById('offline');
  if (off) off.hidden = online;
}

function jobView(j: Job): string {
  const pct = j.size ? Math.floor((j.bytes / j.size) * 100) : 0;
  const title = j.version ? `${esc(j.code)} · ${kindLabel(j.kind)} · ${vnum(j.version)}` : `${esc(j.code)} · ${kindLabel(j.kind)}`;
  const thumb = isImage(j.name) ? `<img src="${convertFileSrc(j.path)}" alt="">` : j.kind === 'render' ? ICON.photo : ICON.file;
  let line = '';
  let right = '';
  switch (j.state) {
    case 'hashing': line = `<div class="small muted">Checking file… ${pct}%</div><div class="bar"><i style="width:${pct}%"></i></div>`; right = `<button class="btn btn-sm" data-cancel="${j.local_id}">Cancel</button>`; break;
    case 'starting': line = '<div class="small muted">Preparing upload…</div><div class="bar"><i style="width:0"></i></div>'; break;
    case 'uploading':
      line = `<div class="small muted">${mb(j.bytes)} of ${mb(j.size)} · ${pct}%${j.message ? ` · <span class="msg-warn">${esc(j.message)}</span>` : ''}</div><div class="bar"><i style="width:${pct}%"></i></div>`;
      right = `<button class="btn btn-sm" data-cancel="${j.local_id}">Cancel</button>`; break;
    case 'done':
      line = `<div class="small msg-ok">Sent${j.stored_name ? ` as ${esc(j.stored_name)}` : ''}. Every PC can see it now.</div>
        <div class="small" style="margin-top:.35rem;display:flex;gap:.4rem"><input type="text" data-note="${j.version_id}" placeholder="Add a revision note (optional)" maxlength="500" value="${esc(j.note ?? '')}" style="flex:1;min-height:1.85rem;font-size:.85rem"><button class="btn btn-sm" data-savenote="${j.version_id}">Save</button></div>`;
      right = `<button class="btn btn-ghost btn-sm" data-dismiss="${j.local_id}">Close</button>`; break;
    case 'duplicate': line = `<div class="small msg-warn">${esc(j.message)}</div>`; right = `<button class="btn btn-ghost btn-sm" data-dismiss="${j.local_id}">Close</button>`; break;
    case 'failed': line = `<div class="small msg-err">${esc(j.message ?? 'Upload failed.')} Drop the file again to retry.</div>`; right = `<button class="btn btn-ghost btn-sm" data-dismiss="${j.local_id}">Close</button>`; break;
    case 'cancelled': line = '<div class="small muted">Cancelled.</div>'; right = `<button class="btn btn-ghost btn-sm" data-dismiss="${j.local_id}">Close</button>`; break;
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
  if (d.path) return `<button class="btn btn-sm" data-reveal="${esc(d.path)}">Show in folder</button>`;
  return `<span class="small muted">${d.total ? `${Math.floor((d.bytes / d.total) * 100)}%` : mb(d.bytes)}</span>`;
}

function renderItems() {
  const box = document.getElementById('items');
  if (!box) return;
  const visible = items.filter((it) => it.versions.some((v) => v.status === 'done' || v.status === 'uploading'));
  const newCount = visible.filter((it) => itemStatus(it).isNew).length;
  document.getElementById('newcount')!.textContent = newCount ? `(${newCount})` : '';
  const unseenCount = visible.filter((it) => itemStatus(it).unseen).length;
  (document.getElementById('seenall') as HTMLButtonElement).hidden = unseenCount === 0;
  const rows = visible.filter((it) => {
    if (filter === 'mine' && !it.versions.some((v) => v.device_id === me())) return false;
    if (filter === 'new' && !itemStatus(it).isNew) return false;
    if (query && !`${it.code} ${kindLabel(it.kind)} ${it.versions.map((v) => `${v.by} ${v.original_name} ${v.note ?? ''}`).join(' ')}`.toLowerCase().includes(query)) return false;
    return true;
  });
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${visible.length ? 'No files match this filter.' : 'No files yet. Drag a file into the box above to send the first one.'}</div>`;
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
        <div class="item-title ellipsis">${esc(it.code)} · ${kindLabel(it.kind)} · ${vnum(latest.version)} <span class="v">${doneCount > 1 ? `${doneCount} versions` : ''}</span></div>
        <div class="small muted ellipsis">${esc(latest.by)} · ${when(latest.done_at ?? latest.started_at)} · ${esc(latest.note || latest.original_name)}</div>
      </div>
      <span class="pill ${st.cls}">${esc(st.label)}</span>
      ${latestDone(it) ? (downloads.has(latestDone(it)!.id) ? dlView(latestDone(it)!.id) : `<button class="btn btn-sm" data-dl="${latestDone(it)!.id}" aria-label="Download the latest version">${ICON.down}Download</button>`) : ''}
      ${ICON.chev}
    </div>`;
    const vers = isOpen ? `<div class="versions">${it.versions.filter((v) => v.status === 'done' || v.status === 'uploading').map((v, i) => {
      const takers = v.downloads.filter((d) => d.device_id !== v.device_id).map((d) => `${esc(d.by)} ${when(d.at)}`).join(', ');
      const status = v.status === 'uploading' ? `<span class="pill busy">${Math.floor((v.progress / Math.max(1, v.size)) * 100)}%</span>` : i > 0 ? '<span class="pill plain">old</span>' : '';
      return `<div class="ver"><span class="num">${vnum(v.version)}</span>
        <div class="grow"><div class="ellipsis">${esc(v.note || v.original_name)} ${status}</div>
        <div class="small muted ellipsis">${esc(v.by)} · ${when(v.done_at ?? v.started_at)} · ${mb(v.size)}${takers ? ` · downloaded by: ${takers}` : ''}</div></div>
        ${v.status === 'done' ? `${v.link ? `<button class="btn btn-ghost btn-sm" data-link="${esc(v.link)}">Drive</button>` : ''}${downloads.has(v.id) ? dlView(v.id) : `<button class="btn btn-sm" data-dl="${v.id}">Download</button>`}` : ''}
      </div>`;
    }).join('')}</div>` : '';
    return `<div class="card item ${isOpen ? 'open' : ''} ${focusVersion && it.versions.some((v) => v.id === focusVersion) ? 'focus' : ''}" data-item="${it.id}">${head}${vers}</div>`;
  }).join('');
  renderMiniSum();
}

function alertInline(msg: string) {
  const off = document.getElementById('offline');
  if (!off) return;
  off.textContent = msg;
  off.hidden = false;
  setTimeout(() => { off.hidden = online; off.textContent = 'Not connected to the server. Uploads and history wait until the internet is back.'; }, 6000);
}

function renderMiniSum() {
  const el = document.getElementById('minisum');
  if (!el) return;
  const active = [...jobs.values()].filter((j) => ['hashing', 'starting', 'uploading'].includes(j.state)).length;
  const fresh = items.filter((it) => itemStatus(it).unseen).length;
  el.textContent = [active ? `${active} uploading` : 'No uploads running', fresh ? `${fresh} new` : ''].filter(Boolean).join(' · ');
}

// ---------- actions ----------
async function choose() {
  const r = await pickFiles({ multiple: true, directory: false, title: 'Choose files to send' });
  if (!r) return;
  await addFiles(Array.isArray(r) ? r : [r]);
}

async function addFiles(paths: string[]) {
  const infos = await invoke<FileInfo[]>('file_info', { paths });
  const files = infos.filter((f) => f.is_file && f.size > 0)
    .map((f) => ({ path: f.path, name: f.name, size: f.size, kind: kindOf(f.name), label: itemName(f.name) }));
  if (!files.length) return;
  if (skipNaming()) { for (const f of files) void send(f.path, f.label, f.kind, null); return; }
  // name step: the file's own name is filled in; Enter keeps it, or type a new one (owner request 23 Nov 2026)
  dropped.push(...files.filter((f) => !dropped.some((d) => d.path === f.path)));
  if (mini) await toggleMini();
  renderNaming();
}

function renderNaming() {
  const box = document.getElementById('naming');
  if (!box) return;
  if (!dropped.length) { box.innerHTML = ''; return; }
  const known = [...new Set(items.map((i) => i.code))].slice(0, 300);
  box.innerHTML = `<form class="card naming" id="namingform" novalidate>
    <div class="naming-head">
      <h3>Send ${dropped.length === 1 ? 'this file' : `${dropped.length} files`}</h3>
      <span class="small muted">Keep the file name, or type a new one. A name that already exists becomes its next version.</span>
    </div>
    <datalist id="known-names">${known.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
    ${dropped.map((f, i) => `<div class="naming-row">
      <div class="thumb">${isImage(f.name) ? `<img src="${convertFileSrc(f.path)}" alt="">` : f.kind === 'render' ? ICON.photo : ICON.file}</div>
      <div class="grow">
        <label class="small muted ellipsis" for="nm${i}">${esc(f.name)} · ${mb(f.size)}</label>
        <div class="naming-input"><input type="text" id="nm${i}" data-i="${i}" list="known-names" maxlength="80" value="${esc(f.label)}" autocomplete="off">
          <button class="btn btn-ghost btn-sm" type="button" data-orig="${i}" title="Use the original file name">Original</button>
          <button class="btn btn-ghost btn-sm" type="button" data-drop="${i}" aria-label="Remove ${esc(f.name)}">✕</button></div>
        <p class="field-error" id="nmerr${i}" hidden>Type a name.</p>
      </div>
    </div>`).join('')}
    <input type="text" id="nmnote" placeholder="Revision note for ${dropped.length === 1 ? 'this file' : 'these files'} (optional)" maxlength="500">
    <div class="naming-actions">
      <button class="btn btn-accent" type="submit">Send</button>
      <button class="btn btn-ghost" type="button" id="nmcancel">Cancel</button>
      <label class="small muted opt"><input type="checkbox" id="nmskip"> Always keep the file name and send right away</label>
    </div>
  </form>`;
  const first = document.getElementById('nm0') as HTMLInputElement | null;
  first?.focus(); first?.select();
  box.querySelectorAll<HTMLInputElement>('input[data-i]').forEach((inp) => (inp.oninput = () => {
    dropped[Number(inp.dataset.i)].label = inp.value;
    inp.removeAttribute('aria-invalid'); document.getElementById(`nmerr${inp.dataset.i}`)!.hidden = true;
  }));
  box.querySelectorAll<HTMLButtonElement>('[data-orig]').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.orig); const f = dropped[i];
    f.label = f.name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
    const inp = document.getElementById(`nm${i}`) as HTMLInputElement; inp.value = f.label; inp.focus();
  }));
  box.querySelectorAll<HTMLButtonElement>('[data-drop]').forEach((b) => (b.onclick = () => { dropped.splice(Number(b.dataset.drop), 1); renderNaming(); }));
  document.getElementById('nmcancel')!.onclick = () => { dropped = []; renderNaming(); };
  (document.getElementById('namingform') as HTMLFormElement).onsubmit = (e) => {
    e.preventDefault();
    let bad = false;
    dropped.forEach((f, i) => {
      if (!f.label.trim()) { bad = true; const inp = document.getElementById(`nm${i}`)!; inp.setAttribute('aria-invalid', 'true'); document.getElementById(`nmerr${i}`)!.hidden = false; }
    });
    if (bad) return;
    if ((document.getElementById('nmskip') as HTMLInputElement).checked) { try { localStorage.setItem('skipNaming', '1'); } catch { /* storage off */ } }
    const note = (document.getElementById('nmnote') as HTMLInputElement).value;
    const go = dropped.splice(0);
    renderNaming();
    for (const f of go) void send(f.path, f.label.trim(), f.kind, note || null);
  };
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

function markSeen(ids: string[]) {
  const fresh = ids.filter((i) => !seen.has(i));
  for (const i of fresh) seen.add(i);
  renderItems();
  if (fresh.length) void invoke('mark_seen', { ids: fresh }).catch(() => undefined);
}

async function download(id: string) {
  seen.add(id);
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
  if (rv) { e.stopPropagation(); invoke('reveal', { path: rv.dataset.reveal! }).catch((err) => alertInline(String(err))); return; }
  const ln = t.closest<HTMLElement>('[data-link]');
  if (ln) { e.stopPropagation(); invoke('open_link', { url: ln.dataset.link! }).catch((err) => alertInline(String(err))); return; }
  const op = t.closest<HTMLElement>('[data-open]');
  if (op) {
    const id = Number(op.dataset.open);
    if (open.has(id)) open.delete(id);
    else {
      open.add(id);
      const it = items.find((i) => i.id === id);
      const l = it && latestDone(it);
      if (l && !seen.has(l.id)) { markSeen([l.id]); return; }
    }
    renderItems();
  }
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
    s.disabled = true; s.textContent = 'Saving…';
    try {
      await invoke('set_note', { versionId: id, note: input?.value ?? '' });
      for (const j of jobs.values()) if (j.version_id === id) j.note = input?.value ?? '';
      s.textContent = 'Saved';
    } catch (err) { s.textContent = 'Failed, try again'; s.title = String(err); }
    s.disabled = false;
  }
}

let fullSize: { w: number; h: number } | null = null;
async function toggleMini() {
  mini = !mini;
  document.body.classList.toggle('mini', mini);
  const w = getCurrentWindow();
  if (mini) {
    // remember the size the person chose, to come back to it
    const scale = await w.scaleFactor();
    const s = (await w.innerSize()).toLogical(scale);
    fullSize = { w: Math.round(s.width), h: Math.round(s.height) };
    if (await w.isMaximized()) await w.unmaximize();
  }
  await w.setAlwaysOnTop(mini);
  await w.setSize(mini ? new LogicalSize(380, 250) : new LogicalSize(fullSize?.w ?? 1040, fullSize?.h ?? 760));
  const b = document.getElementById('minibtn')!;
  b.innerHTML = mini ? `${ICON.pin}<span>Full size</span>` : `${ICON.pin}<span>Compact</span>`;
}

async function openSettings() {
  const dlg = document.getElementById('settings') as HTMLDialogElement;
  const auto = await autostartIsOn().catch(() => false);
  dlg.innerHTML = `<form class="dlg" method="dialog" id="setform">
    <h2>Settings</h2>
    <fieldset><legend>PC name</legend>
      <div class="row"><input type="text" id="newname" maxlength="60" value="${esc(state.name ?? '')}"><button class="btn" type="button" id="renamebtn">Save</button></div>
      <p class="field-error" id="renameerr" hidden></p>
      <span class="small muted">This name shows in the history on every PC, including for earlier uploads.</span>
    </fieldset>
    <fieldset><legend>Windows notifications</legend>
      ${[['all', 'Every upload from others'], ['downloaded', 'Only new versions of files I downloaded'], ['off', 'Off']].map(([v, l]) =>
        `<label class="opt"><input type="radio" name="notify" value="${v}" ${state.notify === v ? 'checked' : ''}> ${l}</label>`).join('')}
    </fieldset>
    <fieldset><legend>Naming</legend>
      <label class="opt"><input type="checkbox" id="skipnaming" ${skipNaming() ? 'checked' : ''}> Always keep the file name and send right away (skip the name step)</label>
    </fieldset>
    <fieldset><legend>When Windows starts</legend>
      <label class="opt"><input type="checkbox" id="autostart" ${auto ? 'checked' : ''}> Open TalaStudio Upload automatically</label>
    </fieldset>
    <footer><span class="small muted">Version ${esc(state.version)} · <button class="btn btn-ghost btn-sm" type="button" id="updbtn">Check for updates</button></span>
      <button class="btn btn-accent" value="close">Done</button></footer>
  </form>`;
  dlg.showModal();
  document.getElementById('renamebtn')!.onclick = async () => {
    const b = document.getElementById('renamebtn') as HTMLButtonElement;
    const err = document.getElementById('renameerr')!;
    b.disabled = true; b.textContent = 'Saving…';
    try { state = await invoke<AppState>('rename', { name: (document.getElementById('newname') as HTMLInputElement).value }); b.textContent = 'Saved'; err.hidden = true; renderWho(); }
    catch (e) { err.hidden = false; err.textContent = String(e); b.textContent = 'Save'; }
    b.disabled = false;
  };
  dlg.querySelectorAll<HTMLInputElement>('input[name="notify"]').forEach((r) => (r.onchange = async () => { state = await invoke<AppState>('set_notify', { mode: r.value }); }));
  (document.getElementById('skipnaming') as HTMLInputElement).onchange = (e) => {
    try { localStorage.setItem('skipNaming', (e.target as HTMLInputElement).checked ? '1' : '0'); } catch { /* storage off */ }
  };
  (document.getElementById('autostart') as HTMLInputElement).onchange = async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    await (on ? autostartOn() : autostartOff()).catch(() => undefined);
  };
  document.getElementById('updbtn')!.onclick = async () => {
    const b = document.getElementById('updbtn') as HTMLButtonElement;
    b.disabled = true; b.textContent = 'Checking…';
    try {
      const v = await invoke<string | null>('check_update');
      b.textContent = v ? `Installing ${v}…` : 'Up to date';
    } catch (e) { b.textContent = 'Check failed'; b.title = String(e); }
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
}

async function main() {
  state = await invoke<AppState>('get_state');
  for (const id of state.seen ?? []) seen.add(id);

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
    seen.add(e.payload);
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

  setInterval(() => { if (state.registered) renderItems(); }, 60_000); // keep "5 min ago" fresh

  if (state.registered) await startMain();
  else renderWelcome();
}

void main();
