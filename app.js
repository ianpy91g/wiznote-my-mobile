'use strict';
/* global marked, DOMPurify */
// WizNote My 手機版：閱讀為主。筆記本身只下載不修改。
// 筆記清單來自電腦版上傳的索引；內文和圖片點開時才下載，看過的存在手機上。
// 加入最愛、刪除和修改內文不直接改筆記，而是在手機索引資料夾留一個請求檔，由電腦版用原本的功能執行，
// 刪除才會進電腦版的回收桶，修改也會留歷史版本、遇到衝突另存衝突檔。電腦處理前先把結果疊在手機上。

const CLIENT_ID = '77837898411-r25e1qo9igtg0ib314ccr5ud77l7uv70.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';
const MOBILE_FOLDER = 'WizNote My Mobile';
const LIST_FILE = 'index.json.gz';
const SEARCH_FILE = 'search.json.gz';
const REQUEST_PREFIX = 'request-';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
// 剛送出的請求可能還沒出現在搜尋結果裡，這段時間內不當成電腦已處理
const REQUEST_GRACE = 2 * 60 * 1000;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PAGE = 100;
// 最上層的「封存」：不出現在全部筆記和一般搜尋，從分類點進去才看得到
const ARCHIVE = '封存';
const isArchived = (folder) => folder === ARCHIVE || folder.startsWith(`${ARCHIVE}/`);

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
};

const state = {
  raw: [],
  notes: [],
  pending: [],
  mobileFolder: '',
  sending: false,
  currentSaved: null,
  editing: null,
  byId: new Map(),
  searchText: null,
  searchSize: 0,
  folderOrder: {},
  tab: 'all',
  folder: '',
  query: '',
  sort: 'm',
  order: 'desc',
  shown: [],
  rendered: 0,
  current: null,
  objectUrls: [],
  refreshing: false,
};

// ---- 手機儲存 ----

function pref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* 私密瀏覽等情況沒有儲存空間，仍可正常閱讀 */ }
  return null;
}

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('wiznote-my', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function store(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const kvGet = (k) => store('readonly', (s) => s.get(k)).catch(() => undefined);
// 手機空間不足時存不進去不算錯誤，內容這次照樣顯示
const kvSet = (k, v) => store('readwrite', (s) => s.put(v, k)).catch(() => undefined);
const kvClear = () => store('readwrite', (s) => s.clear()).catch(() => undefined);

// ---- 閱讀樣式（只存在這支手機上）----

const STYLE_KEY = 'wiznote-style';
const STYLE_DEFAULT = { theme: 'auto', size: '17', boldc: 'on', bubble: 'on' };

function readingStyle() {
  try {
    return { ...STYLE_DEFAULT, ...JSON.parse(pref(STYLE_KEY) || '{}') };
  } catch {
    return { ...STYLE_DEFAULT };
  }
}

function applyStyle(s = readingStyle()) {
  const root = document.documentElement;
  if (s.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', s.theme);
  root.style.setProperty('--read-size', `${s.size}px`);
  document.body.classList.toggle('boldc', s.boldc === 'on');
  document.body.classList.toggle('bubble', s.bubble === 'on');
  for (const seg of document.querySelectorAll('#style-box .seg')) {
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === s[seg.dataset.key]);
  }
}

function bindStyle() {
  for (const seg of document.querySelectorAll('#style-box .seg')) {
    seg.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const s = { ...readingStyle(), [seg.dataset.key]: b.dataset.v };
      pref(STYLE_KEY, JSON.stringify(s));
      applyStyle(s);
      updateJump();
    };
  }
}

// ---- 登入 ----

class AuthError extends Error {}

function token() {
  try {
    const t = JSON.parse(pref('wiznote-token') || 'null');
    if (t && t.exp > Date.now() + 30000) return t.value;
  } catch { /* 視為未登入 */ }
  return '';
}

function login() {
  const oauthState = crypto.randomUUID();
  pref('wiznote-oauth-state', oauthState);
  if (state.current) pref('wiznote-return-note', state.current.id);
  const hint = pref('wiznote-account');
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: location.origin + location.pathname,
    response_type: 'token',
    scope: SCOPE,
    state: oauthState,
  });
  if (hint) q.set('login_hint', hint);
  else q.set('prompt', 'select_account');
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
}

// 回傳登入失敗的說明；不是從 Google 回來就回傳空字串
function takeOauthResult() {
  const back = new URLSearchParams(location.hash.slice(1));
  if (!back.has('access_token') && !back.has('error')) return '';
  history.replaceState(null, '', location.pathname);
  const expected = pref('wiznote-oauth-state');
  pref('wiznote-oauth-state', null);
  if (back.has('error')) return back.get('error') === 'access_denied' ? '已取消登入。' : `Google 登入失敗：${back.get('error')}`;
  if (!expected || expected !== back.get('state')) return '登入驗證失敗，請再試一次。';
  pref('wiznote-token', JSON.stringify({ value: back.get('access_token'), exp: Date.now() + Number(back.get('expires_in') || 3600) * 1000 }));
  return '';
}

// 登出時一併清掉手機上的筆記，否則下一個拿到手機的人還是看得到
async function logout() {
  const unsent = state.pending.filter((p) => !p.sent).length;
  if (unsent && !confirm(`還有 ${unsent} 項變更沒送到雲端，登出後會放棄。要登出嗎？`)) return;
  pref('wiznote-token', null);
  pref('wiznote-account', null);
  await kvClear();
  location.reload();
}

// ---- Google Drive ----

async function drive(url, options = {}) {
  const t = token();
  if (!t) throw new AuthError('需要登入');
  let res;
  try {
    res = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${t}` } });
  } catch {
    throw new Error('無法連線，請確認網路');
  }
  if (res.status === 401) {
    pref('wiznote-token', null);
    throw new AuthError('需要重新登入');
  }
  if (!res.ok) throw new Error(`Google Drive 回應 ${res.status}`);
  return res;
}

async function listFiles(query, fields = 'id,name,mimeType,size,md5Checksum') {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '1000', fields: `nextPageToken,files(${fields})` });
    if (pageToken) q.set('pageToken', pageToken);
    const data = await (await drive(`${API}?${q}`)).json();
    out.push(...data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

const media = (id) => drive(`${API}/${encodeURIComponent(id)}?alt=media`);

async function gunzipJson(res) {
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

// ---- 筆記清單 ----

async function indexFiles() {
  const folders = await listFiles(`name='${MOBILE_FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`, 'id,createdTime');
  if (!folders.length) return null;
  folders.sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || '') || a.id.localeCompare(b.id));
  state.mobileFolder = folders[0].id;
  const files = await listFiles(`'${folders[0].id}' in parents and trashed=false`);
  return {
    list: files.find((f) => f.name === LIST_FILE),
    search: files.find((f) => f.name === SEARCH_FILE),
    requests: new Set(files.filter((f) => f.name.startsWith(REQUEST_PREFIX)).map((f) => f.name)),
  };
}

// 電腦還沒處理的變更疊在索引上：刪除的先藏起來，最愛照手機上的選擇顯示
function setNotes(notes) {
  state.raw = notes;
  const fav = new Map();
  const gone = new Set();
  const edited = new Map();
  for (const p of state.pending) {
    if (p.action === 'trash') gone.add(p.id);
    else if (p.action === 'edit') edited.set(p.id, p.body);
    else fav.set(p.id, p.on);
  }
  state.notes = notes.filter((n) => !gone.has(n.id)).map((n) => {
    let out = n;
    if (fav.has(n.id) && !!n.v !== fav.get(n.id)) out = { ...out, v: fav.get(n.id) ? 1 : 0 };
    if (edited.has(n.id)) out = { ...out, s: snippet(edited.get(n.id)) };
    return out;
  });
  state.byId = new Map(state.notes.map((n) => [n.id, n]));
}

// ---- 手機留給電腦的請求 ----

const savePending = () => kvSet('pending', state.pending);

async function queueRequest(action, id, extra = {}) {
  // 還沒送出的同一篇最愛切換或修改直接換掉，不必送兩次。
  // 換掉的修改電腦從沒看過，所以沿用它的起點，電腦才比對得到。
  const old = action !== 'trash' && state.pending.find((p) => !p.sent && p.action === action && p.id === id);
  if (old) {
    state.pending = state.pending.filter((p) => p !== old);
    if (action === 'edit') extra = { ...extra, base: old.base };
  }
  state.pending.push({
    name: `${REQUEST_PREFIX}${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`,
    action, id, ...extra, at: new Date().toISOString(), sent: 0,
  });
  await savePending();
  setNotes(state.raw);
  renderHome();
  sendPending();
}

async function uploadRequest(p) {
  const { name, sent: _sent, ...req } = p;
  const boundary = `wiz${crypto.randomUUID().replace(/-/g, '')}`;
  const meta = JSON.stringify({ name, parents: [state.mobileFolder], mimeType: 'application/json' });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ version: 1, ...req })}\r\n--${boundary}--`;
  await drive(`${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
}

// 沒網路或登入過期時留在手機上，下次更新清單時再送
async function sendPending({ quiet = false } = {}) {
  if (state.sending || !token() || !state.pending.some((p) => !p.sent)) return;
  state.sending = true;
  try {
    if (!state.mobileFolder) await indexFiles();
    if (!state.mobileFolder) return;
    for (const p of state.pending.filter((x) => !x.sent)) {
      await uploadRequest(p);
      p.sent = Date.now();
      await savePending();
    }
  } catch (e) {
    if (e instanceof AuthError) showLoginBanner();
    else if (!quiet) toast('變更還沒送出，下次連上網路時會自動再送。');
  } finally {
    state.sending = false;
  }
}

// 請求檔不見了代表電腦已經處理，而且清單是在那之後更新的，手機上的暫存可以拿掉
function prunePending(found) {
  const keep = state.pending.filter((p) => !p.sent || found.requests.has(p.name) || Date.now() - p.sent < REQUEST_GRACE);
  if (keep.length === state.pending.length) return false;
  state.pending = keep;
  savePending();
  return true;
}

// 手機上最新一份還沒被電腦處理的修改
function pendingBody(id) {
  for (let i = state.pending.length - 1; i >= 0; i--) {
    const p = state.pending[i];
    if (p.action === 'edit' && p.id === id) return p.body;
  }
  return undefined;
}

const snippet = (body) => body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#>*_`|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pendingNote() {
  const n = state.pending.length;
  return n ? `${n} 項變更等電腦同步後生效` : '';
}

async function refreshIndex() {
  if (state.refreshing || !token()) return;
  state.refreshing = true;
  try {
    const found = await indexFiles();
    if (!found?.list) {
      if (!state.notes.length) showBanner('雲端還沒有手機索引。請在電腦開啟 WizNote My 同步一次。');
      return;
    }
    state.searchSize = Number(found.search?.size || 0);
    await sendPending({ quiet: true });
    let changed = false;
    if (found.list.md5Checksum !== await kvGet('list-md5')) {
      const data = await gunzipJson(await media(found.list.id));
      state.raw = data.notes;
      state.folderOrder = data.folderOrder || {};
      await kvSet('folder-order', state.folderOrder);
      await kvSet('list', data.notes);
      await kvSet('list-md5', found.list.md5Checksum);
      changed = true;
    }
    if (prunePending(found)) changed = true;
    if (changed) {
      setNotes(state.raw);
      renderHome();
    }
    // 已經下載過全文資料才自動更新；沒用過全文搜尋就不佔流量
    const searchMd5 = await kvGet('search-md5');
    if (searchMd5 && found.search && searchMd5 !== found.search.md5Checksum) await downloadSearch(found.search);
    hideBanner();
    await cacheFavorites();
  } catch (e) {
    if (e instanceof AuthError) showLoginBanner();
    else if (!state.notes.length) showBanner(e.message);
    else toast(e.message);
  } finally {
    state.refreshing = false;
  }
}

async function downloadSearch(file) {
  const data = await gunzipJson(await media(file.id));
  state.searchText = data.text;
  await kvSet('search', data.text);
  await kvSet('search-md5', file.md5Checksum);
}

// 「我的最愛」自動存到手機，沒網路也能看。一篇一篇慢慢來，不影響閱讀。
async function cacheFavorites() {
  for (const n of state.notes.filter((x) => x.v)) {
    const cached = await kvGet(`note:${n.d}`);
    if (cached?.h === n.h) continue;
    const saved = await downloadNote(n);
    await downloadImages(saved);
  }
}

// ---- 清單畫面 ----

function showBanner(text, action) {
  const b = $('banner');
  b.replaceChildren(el('span', { textContent: text }));
  if (action) b.append(action);
  b.hidden = false;
}
function hideBanner() {
  $('banner').hidden = true;
}
function loginButton() {
  return el('button', { type: 'button', textContent: '登入', onclick: login });
}
function showLoginBanner() {
  showBanner('登入已過期，已存在手機上的筆記仍可閱讀。', loginButton());
}

function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function filtered() {
  const words = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const inFolder = state.tab === 'folders' && state.folder;
  const items = state.notes.filter((n) => {
    if (state.tab === 'fav' && !n.v) return false;
    if (inFolder && n.f !== state.folder && !n.f.startsWith(`${state.folder}/`)) return false;
    if (!inFolder && state.tab !== 'fav' && isArchived(n.f)) return false;
    if (!words.length) return true;
    const hay = `${n.t}\n${n.s}\n${state.searchText?.[n.id] || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const dir = state.order === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    if (state.sort === 't') return dir * a.t.localeCompare(b.t, 'zh-Hant', { numeric: true });
    return dir * (new Date(a[state.sort]).getTime() - new Date(b[state.sort]).getTime());
  });
  return items;
}

function noteRow(n) {
  const title = el('div', { className: 't' });
  if (n.v) title.append(el('span', { className: 'fav', textContent: '♥' }));
  title.append(n.t);
  const row = el('button', { className: 'row', type: 'button' },
    title,
    el('div', { className: 's', textContent: n.s }),
    el('div', { className: 'm' }, el('span', { className: 'f', textContent: n.f }), el('span', { className: 'd', textContent: fmtDate(state.sort === 'c' ? n.c : n.m) })));
  row.dataset.id = n.id;
  row.onclick = () => openNote(n.id);
  return row;
}

function appendRows() {
  const to = Math.min(state.rendered + PAGE, state.shown.length);
  const frag = document.createDocumentFragment();
  for (let i = state.rendered; i < to; i++) frag.append(noteRow(state.shown[i]));
  $('list').append(frag);
  state.rendered = to;
}

function renderFolders() {
  const box = $('folders');
  const show = state.tab === 'folders' && !state.query.trim();
  box.hidden = !show;
  $('folder-back').hidden = !(state.tab === 'folders' && state.folder);
  if (!show) return;
  const prefix = state.folder ? `${state.folder}/` : '';
  const counts = new Map();
  for (const n of state.notes) {
    if (!n.f.startsWith(prefix) || n.f === state.folder) continue;
    const name = n.f.slice(prefix.length).split('/')[0];
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  // 和電腦版相同的手動排序；沒排過的依名稱排在後面
  const manual = state.folderOrder[state.folder] || [];
  const rank = (name) => {
    if (!state.folder && name === ARCHIVE) return Infinity;
    const i = manual.indexOf(name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  box.replaceChildren(...[...counts].sort((a, b) => (rank(a[0]) === rank(b[0]) ? a[0].localeCompare(b[0], 'zh-Hant') : rank(a[0]) - rank(b[0]))).map(([name, count]) => {
    const row = el('button', { className: 'folder-row', type: 'button' },
      el('span', { className: 'n', textContent: !state.folder && name === ARCHIVE ? `🗄 ${name}` : name }), el('span', { className: 'c', textContent: count }), el('span', { className: 'c', textContent: '›' }));
    row.dataset.folder = prefix + name;
    row.onclick = () => openFolder(prefix + name);
    return row;
  }));
}

function renderHome() {
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('on', t.dataset.tab === state.tab);
    t.setAttribute('aria-selected', String(t.dataset.tab === state.tab));
  }
  const title = { all: '全部筆記', fav: '我的最愛', folders: state.folder ? state.folder.split('/').pop() : '分類' }[state.tab];
  $('home-title').textContent = title;
  $('sort').value = state.sort;
  $('order').textContent = state.order === 'asc' ? '↑ 遞增' : '↓ 遞減';
  renderFolders();
  // 分類的最上層只列分類，避免一次攤開全部筆記
  const topLevel = state.tab === 'folders' && !state.folder && !state.query.trim();
  state.shown = topLevel ? [] : filtered();
  state.rendered = 0;
  $('list').replaceChildren();
  $('count').textContent = topLevel ? '' : `${state.shown.length} 篇`;
  appendRows();
  if (!state.shown.length && !topLevel) {
    let text = '沒有符合的筆記。';
    if (!state.notes.length) text = '正在等待筆記清單…';
    else if (state.tab === 'fav' && !state.query.trim()) text = '還沒有我的最愛。打開文章按上方的愛心就會出現在這裡。';
    $('list').append(el('div', { className: 'empty', textContent: text }));
  }
  renderSearchButton();
}

function renderSearchButton() {
  const b = $('search-full');
  const need = state.query.trim() && !state.searchText && navigator.onLine !== false;
  b.hidden = !need;
  if (need) {
    const mb = state.searchSize ? `，約 ${Math.max(1, Math.round(state.searchSize / 1048576))} MB` : '';
    b.textContent = `也搜尋內文（第一次要下載${mb}）`;
  }
}

async function loadFullSearch() {
  const b = $('search-full');
  b.disabled = true;
  b.textContent = '下載中…';
  try {
    const found = await indexFiles();
    if (!found?.search) throw new Error('雲端還沒有全文資料，請在電腦同步一次。');
    await downloadSearch(found.search);
    renderHome();
  } catch (e) {
    if (e instanceof AuthError) showLoginBanner();
    else toast(e.message);
    renderSearchButton();
  } finally {
    b.disabled = false;
  }
}

function setTab(tab) {
  state.tab = tab;
  state.folder = '';
  pref('wiznote-tab', tab);
  history.replaceState({ view: 'home' }, '');
  renderHome();
  scrollTo(0, 0);
}

function openFolder(path) {
  state.folder = path;
  history.pushState({ view: 'home', folder: path }, '');
  renderHome();
  scrollTo(0, 0);
}

// ---- 閱讀畫面 ----

// 列出筆記資料夾內所有檔案（含 images、attachments 等子資料夾），路徑相對於筆記
async function walkNote(dir) {
  const out = [];
  const walk = async (id, rel) => {
    for (const f of await listFiles(`'${id}' in parents and trashed=false`)) {
      const child = rel ? `${rel}/${f.name}` : f.name;
      if (f.mimeType === FOLDER_MIME) await walk(f.id, child);
      else out.push({ rel: child, id: f.id, md5: f.md5Checksum, size: Number(f.size || 0) });
    }
  };
  await walk(dir, '');
  return out;
}

async function downloadNote(n) {
  const files = await walkNote(n.d);
  const mdName = `${n.id.split('/').pop()}.md`;
  const md = files.find((f) => f.rel === mdName);
  if (!md) throw new Error('雲端找不到這篇筆記，可能已被移動。請稍後更新清單。');
  const text = await (await media(md.id)).text();
  const saved = { h: n.h, md: text, files };
  await kvSet(`note:${n.d}`, saved);
  return saved;
}

// 和電腦版的切法完全相同，兩邊比對內文才會一致
function splitBody(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)(?:\r?\n)?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

const noteBody = (n, saved) => pendingBody(n.id) ?? splitBody(saved.md);

const safeDecode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

// 內容來自網頁剪藏，一律先消毒；禁止表單、樣式和內嵌頁面
function renderMarkup(html) {
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio', 'source'],
    FORBID_ATTR: ['style', 'class', 'id', 'width', 'height', 'srcset'],
  });
  const body = $('note-body');
  body.innerHTML = clean;
  groupTurns(body);
  for (const a of body.querySelectorAll('a')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}

async function imageBlob(file) {
  const key = `img:${file.id}:${file.md5}`;
  const cached = await kvGet(key);
  if (cached) return cached;
  const blob = await (await media(file.id)).blob();
  await kvSet(key, blob);
  return blob;
}

// 只把內文真正用到的圖片存到手機
function referencedImages(saved) {
  const byRel = new Map(saved.files.map((f) => [f.rel, f]));
  const out = [];
  for (const m of saved.md.matchAll(/!\[[^\]]*\]\(<?([^)>\s]+(?:\([^)]*\))?)/g)) {
    const f = byRel.get(safeDecode(m[1]));
    if (f) out.push(f);
  }
  return out;
}

async function downloadImages(saved) {
  for (const f of referencedImages(saved)) await imageBlob(f);
}

async function resolveImages(saved, noteId) {
  const byRel = new Map(saved.files.map((f) => [f.rel, f]));
  const images = [...$('note-body').querySelectorAll('img')];
  let next = 0;
  const run = async () => {
    while (next < images.length) {
      const img = images[next++];
      const src = img.getAttribute('src') || '';
      if (/^https:/i.test(src)) {
        img.loading = 'lazy';
        continue;
      }
      if (/^(data|blob):/i.test(src)) continue;
      const file = byRel.get(safeDecode(src));
      img.removeAttribute('src');
      try {
        if (!file) throw new Error('missing');
        const blob = await imageBlob(file);
        if (state.current?.id !== noteId) return;
        const url = URL.createObjectURL(blob);
        state.objectUrls.push(url);
        img.src = url;
      } catch {
        if (state.current?.id !== noteId) return;
        img.classList.add('missing');
        img.alt = img.alt && img.alt !== 'image' ? `［圖片無法顯示：${img.alt}］` : '［圖片無法顯示］';
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, run));
}

function releaseImages() {
  for (const u of state.objectUrls) URL.revokeObjectURL(u);
  state.objectUrls = [];
}

// 下載成檔案，型別固定成 octet-stream，附件裡的網頁或腳本才不會在這個網站的權限下執行
async function downloadAttachment(file, name, button) {
  const label = button.textContent;
  button.textContent = '下載中…';
  try {
    const blob = await (await media(file.id)).blob();
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    if (e instanceof AuthError) showNoteLogin();
    else toast(e.message);
  } finally {
    button.textContent = label;
  }
}

function showNoteLogin(text = '登入已過期，登入後才能下載這篇的內容。') {
  const b = $('note-banner');
  b.replaceChildren(el('span', { textContent: text }), loginButton());
  b.hidden = false;
}

function renderActions(n, saved) {
  const box = $('note-actions');
  box.replaceChildren();
  if (n.u && /^https?:\/\//i.test(n.u)) box.append(el('a', { href: n.u, target: '_blank', rel: 'noopener noreferrer', textContent: '原始網址' }));
  if (!saved) return;
  const stem = n.id.split('/').pop();
  const html = saved.files.find((f) => f.rel === `${stem}.html`);
  if (html) {
    const b = el('button', { type: 'button', textContent: '原始 HTML' });
    b.onclick = async () => {
      try {
        const text = await (await media(html.id)).text();
        if (state.current?.id !== n.id) return;
        releaseImages();
        renderMarkup(text);
        await resolveImages(saved, n.id);
        b.remove();
      } catch (e) {
        if (e instanceof AuthError) showNoteLogin();
        else toast(e.message);
      }
    };
    box.append(b);
  }
  for (const f of saved.files.filter((x) => x.rel.startsWith('attachments/'))) {
    const name = f.rel.split('/').pop();
    const b = el('button', { type: 'button', textContent: `📎 ${name}` });
    b.onclick = () => downloadAttachment(f, name, b);
    box.append(b);
  }
}

async function showNote(n) {
  exitEdit();
  releaseImages();
  state.current = n;
  state.currentSaved = null;
  $('note-edit').disabled = true;
  $('note-edit').hidden = !!n.r;
  $('home-view').hidden = true;
  $('note-view').hidden = false;
  $('note-title').textContent = n.t;
  renderNoteFav(n);
  $('note-meta').textContent = [n.f, `建立 ${fmtDate(n.c)}`, `修改 ${fmtDate(n.m)}`].filter(Boolean).join('　');
  $('note-banner').hidden = true;
  $('note-body').replaceChildren(el('p', { className: 'muted', textContent: '載入中…' }));
  renderActions(n, null);
  state.posReady = '';
  renderNav([]);
  scrollTo(0, 0);

  let saved = await kvGet(`note:${n.d}`);
  let stale = false;
  if (saved?.h !== n.h) {
    try {
      saved = await downloadNote(n);
    } catch (e) {
      if (state.current?.id !== n.id) return;
      if (!saved) {
        $('note-body').replaceChildren(el('p', { className: 'muted', textContent: e instanceof AuthError ? '這篇還沒存到手機上。' : e.message }));
        if (e instanceof AuthError) showNoteLogin();
        return;
      }
      stale = true;
      if (e instanceof AuthError) showNoteLogin('這是手機上的舊版本。登入後可以更新。');
    }
  }
  if (state.current?.id !== n.id) return;
  if (stale && $('note-banner').hidden) {
    const b = $('note-banner');
    b.replaceChildren(el('span', { textContent: '目前無法更新，顯示的是手機上的舊版本。' }));
    b.hidden = false;
  }
  if (n.k && $('note-banner').hidden) {
    const b = $('note-banner');
    b.replaceChildren(el('span', { textContent: '這篇有衝突檔：內文在別處也被改過，請在電腦版比對。' }));
    b.hidden = false;
  }
  state.currentSaved = saved;
  $('note-edit').disabled = false;
  renderMarkup(marked.parse(noteBody(n, saved), { gfm: true }));
  renderActions(n, saved);
  renderNav(findQuestions());
  const restored = restorePosition(n.id);
  await resolveImages(saved, n.id);
  // 圖片載入後高度會變；使用者還沒動過就再對一次位置
  if (restored && state.current?.id === n.id && scrollY === restored.at) restorePosition(n.id, false);
  if (state.current?.id === n.id) updateJump();
}

// ---- 長文章的閱讀輔助 ----

// AI 對話：每一段從「**🧑 我**」或「**🤖 …**」開頭，到下一段之前，包成一個區塊，才能把問題畫成對話框
function groupTurns(root) {
  const isHead = (n) => n?.tagName === 'P' && n.firstChild && n.firstChild === n.firstElementChild
    && n.firstChild.tagName === 'STRONG' && /^(🧑 我|🤖 )/.test(n.firstChild.textContent);
  let box = null;
  for (const node of [...root.children]) {
    if (isHead(node)) {
      box = document.createElement('div');
      box.className = node.firstChild.textContent.startsWith('🧑') ? 'turn turn-user' : 'turn turn-ai';
      node.classList.add('who');
      // 時間另外包起來，顯示得淡一點
      const when = document.createElement('span');
      when.className = 'when';
      when.append(...[...node.childNodes].slice(1));
      node.append(when);
      node.before(box);
      box.append(node);
    } else if (node.tagName === 'HR' && isHead(node.nextElementSibling)) {
      // 段與段之間的分隔線改由區塊本身表現
      node.remove();
    } else if (box) {
      box.append(node);
    }
  }
  return [...root.querySelectorAll('.turn-user')];
}

// 問題目錄：每個「我」的區塊
function findQuestions() {
  return [...$('note-body').querySelectorAll('.turn-user')].map((box) => {
    box.classList.add('turn-q');
    const when = box.querySelector('.who .when')?.textContent.trim() || '';
    const first = [...box.children].find((c) => !c.classList.contains('who') && c.textContent.trim());
    const text = (first?.textContent || '').trim().split('\n')[0];
    return { el: box, when, text: text.length > 60 ? `${text.slice(0, 60)}…` : text || '（空白）' };
  });
}

function renderNav(questions) {
  state.questions = questions;
  $('note-toc').hidden = questions.length < 2;
  updateJump();
}

// 文章超過約兩個畫面才顯示到頂端／到底部
function updateJump() {
  const long = !$('note-view').hidden && !state.editing && document.documentElement.scrollHeight > innerHeight * 2.2;
  $('jump').hidden = !long;
}

function openToc() {
  const list = $('toc-list');
  const cur = currentQuestion();
  list.replaceChildren(...state.questions.map((q, i) => {
    const b = el('button', { type: 'button', className: `toc-item${i === cur ? ' on' : ''}` },
      el('span', { className: 'toc-n', textContent: String(i + 1) }),
      el('span', { className: 'toc-t', textContent: q.text }),
      el('span', { className: 'toc-w', textContent: q.when }));
    b.onclick = () => {
      $('toc').hidden = true;
      q.el.scrollIntoView({ block: 'start' });
    };
    return b;
  }));
  $('toc-count').textContent = `共 ${state.questions.length} 題`;
  $('toc').hidden = false;
  list.children[cur]?.scrollIntoView({ block: 'center' });
}

// 畫面上方最接近的那一題
function currentQuestion() {
  let cur = 0;
  state.questions.forEach((q, i) => { if (q.el.getBoundingClientRect().top < 120) cur = i; });
  return cur;
}

// ---- 記住看到哪裡 ----

const POS_KEY = 'wiznote-positions';
const POS_KEEP = 300;

function positions() {
  try { return JSON.parse(pref(POS_KEY) || '{}'); } catch { return {}; }
}

function savePosition() {
  const n = state.current;
  if (!n || state.posReady !== n.id || state.editing) return;
  const all = positions();
  if (scrollY < innerHeight) delete all[n.id];
  else all[n.id] = { y: Math.round(scrollY), t: Date.now() };
  // 只留最近看過的幾百篇
  const keys = Object.keys(all);
  if (keys.length > POS_KEEP) keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - POS_KEEP).forEach((k) => delete all[k]);
  pref(POS_KEY, JSON.stringify(all));
}

function restorePosition(id, announce = true) {
  state.posReady = id;
  const p = positions()[id];
  if (!p || p.y >= document.documentElement.scrollHeight) return null;
  scrollTo(0, p.y);
  if (announce) toast('從上次看到的地方繼續', 2000);
  return { at: scrollY };
}

function renderNoteFav(n) {
  const b = $('note-fav');
  b.textContent = n.v ? '♥' : '♡';
  b.classList.toggle('on', !!n.v);
  b.setAttribute('aria-label', n.v ? '從我的最愛移除' : '加入我的最愛');
  b.setAttribute('aria-pressed', String(!!n.v));
}

async function toggleNoteFavorite() {
  const n = state.current;
  if (!n) return;
  const on = !n.v;
  await queueRequest('favorite', n.id, { on });
  state.current = state.byId.get(n.id) || n;
  renderNoteFav(state.current);
  toast(on ? '已加入我的最愛，電腦同步後也會更新' : '已從我的最愛移除，電腦同步後也會更新');
}

async function trashCurrentNote() {
  const n = state.current;
  if (!n) return;
  if (!confirm(`刪除「${n.t}」？\n\n電腦同步時會移到電腦版的回收桶，可以在電腦上還原。`)) return;
  await queueRequest('trash', n.id);
  history.back();
  toast('已刪除，電腦同步時會移到回收桶');
}

// ---- 修改內文 ----

const editDirty = () => !!state.editing && $('note-editor').value !== state.editing.initial;

function fitEditor() {
  const ta = $('note-editor');
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 4}px`;
}

function setEditMode(on) {
  for (const id of ['note-back', 'note-fav', 'note-edit', 'note-trash', 'note-body', 'note-actions']) $(id).hidden = on;
  // 自動產生的筆記（AI 對話）是唯讀的
  if (state.current?.r) $('note-edit').hidden = true;
  for (const id of ['edit-cancel', 'edit-save', 'note-editor', 'edit-hint']) $(id).hidden = !on;
  $('note-toc').hidden = on || (state.questions || []).length < 2;
  updateJump();
}

async function startEdit() {
  const n = state.current;
  const saved = state.currentSaved;
  if (!n || !saved) return;
  const text = noteBody(n, saved);
  const ta = $('note-editor');
  ta.value = text;
  state.editing = { id: n.id, initial: ta.value, base: await sha256(text) };
  setEditMode(true);
  fitEditor();
  scrollTo(0, 0);
}

function exitEdit() {
  if (!state.editing) return;
  state.editing = null;
  $('note-editor').value = '';
  setEditMode(false);
}

function cancelEdit() {
  if (editDirty() && !confirm('放棄這次的修改？')) return;
  exitEdit();
}

async function saveEdit() {
  const e = state.editing;
  if (!e) return;
  const changed = editDirty();
  // 電腦存檔時也會拿掉開頭的空行，兩邊才算同一份內文
  if (changed) await queueRequest('edit', e.id, { body: $('note-editor').value.replace(/^\s*\n/, ''), base: e.base });
  exitEdit();
  const n = state.byId.get(e.id);
  if (n && state.current?.id === e.id) await showNote(n);
  if (changed) toast('已儲存，電腦同步後也會更新');
}

function openNote(id) {
  const n = state.byId.get(id);
  if (!n) return;
  state.listScroll = scrollY;
  history.pushState({ view: 'note', id, folder: state.folder }, '');
  showNote(n);
}

function closeNoteView() {
  savePosition();
  releaseImages();
  state.current = null;
  state.posReady = '';
  $('jump').hidden = true;
  $('toc').hidden = true;
  $('note-body').replaceChildren();
  $('note-view').hidden = true;
  $('home-view').hidden = false;
}

// 用瀏覽器的上一頁處理返回，iPhone 邊緣滑動也能回去
window.addEventListener('popstate', (e) => {
  // 編輯中按返回或邊緣滑動：還有沒存的修改就先問
  if (state.editing) {
    if (editDirty() && !confirm('放棄這次的修改？')) {
      history.pushState({ view: 'note', id: state.editing.id, folder: state.folder }, '');
      return;
    }
    exitEdit();
  }
  const s = e.state || {};
  if (s.view === 'note' && state.byId.has(s.id)) {
    showNote(state.byId.get(s.id));
    return;
  }
  const wasNote = !$('note-view').hidden;
  closeNoteView();
  if (!wasNote || (s.folder || '') !== state.folder) {
    state.folder = s.folder || '';
    renderHome();
  }
  scrollTo(0, wasNote ? state.listScroll || 0 : 0);
});

// ---- 設定 ----

async function openSheet() {
  $('sheet-account').textContent = pref('wiznote-account') ? `帳號：${pref('wiznote-account')}` : '';
  $('sheet-storage').textContent = '';
  $('sheet-pending').textContent = pendingNote();
  $('sheet').hidden = false;
  try {
    const { usage } = await navigator.storage.estimate();
    $('sheet-storage').textContent = `手機上已存約 ${Math.round(usage / 1048576)} MB`;
  } catch { /* 有些瀏覽器不提供 */ }
}

async function rememberAccount() {
  if (pref('wiznote-account')) return;
  try {
    const data = await (await drive('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)')).json();
    if (data.user?.emailAddress) pref('wiznote-account', data.user.emailAddress);
  } catch { /* 只影響下次是否要選帳號 */ }
}

function bindEvents() {
  $('login').onclick = login;
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => setTab(t.dataset.tab);
  $('note-back').onclick = () => history.back();
  $('note-fav').onclick = toggleNoteFavorite;
  $('note-trash').onclick = trashCurrentNote;
  $('note-edit').onclick = startEdit;
  $('note-toc').onclick = openToc;
  $('toc-close').onclick = () => { $('toc').hidden = true; };
  $('toc').onclick = (e) => { if (e.target === $('toc')) $('toc').hidden = true; };
  $('jump-top').onclick = () => scrollTo({ top: 0 });
  $('jump-bottom').onclick = () => scrollTo({ top: document.documentElement.scrollHeight });
  let posTimer;
  addEventListener('scroll', () => {
    clearTimeout(posTimer);
    posTimer = setTimeout(savePosition, 400);
  }, { passive: true });
  addEventListener('resize', updateJump);
  // App 切到背景時也記一下
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });
  $('edit-cancel').onclick = cancelEdit;
  $('edit-save').onclick = saveEdit;
  $('note-editor').addEventListener('input', fitEditor);
  window.addEventListener('beforeunload', (e) => { if (editDirty()) e.preventDefault(); });
  $('folder-back').onclick = () => history.back();
  $('settings').onclick = openSheet;
  $('sheet-close').onclick = () => { $('sheet').hidden = true; };
  $('sheet').onclick = (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; };
  $('logout').onclick = logout;
  $('refresh').onclick = () => {
    $('sheet').hidden = true;
    if (!token()) login();
    else refreshIndex().then(() => toast('筆記清單已是最新'));
  };
  $('clear-cache').onclick = async () => {
    await kvClear();
    state.searchText = null;
    await savePending();
    await kvSet('list', state.raw);
    await kvSet('folder-order', state.folderOrder);
    $('sheet').hidden = true;
    toast('已清除離線內容');
    refreshIndex();
  };
  let searchTimer;
  $('search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.query = $('search').value;
      if (state.query.trim() && !state.searchText) {
        const text = await kvGet('search');
        if (text) state.searchText = text;
      }
      renderHome();
    }, 150);
  };
  $('search-full').onclick = loadFullSearch;
  $('sort').onchange = () => {
    state.sort = $('sort').value;
    pref('wiznote-sort', state.sort);
    renderHome();
  };
  $('order').onclick = () => {
    state.order = state.order === 'asc' ? 'desc' : 'asc';
    pref('wiznote-order', state.order);
    renderHome();
  };
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && state.rendered < state.shown.length) appendRows();
  }, { rootMargin: '400px' }).observe($('sentinel'));
  // 回到 App 時檢查更新
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.current) refreshIndex();
  });
}

async function start() {
  applyStyle();
  bindStyle();
  bindEvents();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  const oauthError = takeOauthResult();
  state.tab = pref('wiznote-tab') || 'all';
  state.sort = pref('wiznote-sort') || 'm';
  state.order = pref('wiznote-order') || 'desc';
  state.pending = (await kvGet('pending')) || [];
  const cached = await kvGet('list');
  if (cached) setNotes(cached);
  state.folderOrder = (await kvGet('folder-order')) || {};

  if (!cached && !token()) {
    $('login-view').hidden = false;
    if (oauthError) toast(oauthError, 6000);
    return;
  }
  $('home-view').hidden = false;
  history.replaceState({ view: 'home' }, '');
  renderHome();
  if (oauthError) toast(oauthError, 6000);
  if (!token()) showLoginBanner();
  else rememberAccount();

  const returnId = pref('wiznote-return-note');
  pref('wiznote-return-note', null);
  if (returnId && state.byId.has(returnId)) openNote(returnId);
  refreshIndex();
}

start();
