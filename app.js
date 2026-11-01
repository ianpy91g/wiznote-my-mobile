'use strict';
// 只驗證兩件事：這個網頁用戶端讀得到電腦版上傳的檔案嗎？iPhone 主畫面 App 能完成 Google 登入嗎？
// 存取權杖只放在記憶體，畫面也不顯示檔名或內容。
const CLIENT_ID = '77837898411-r25e1qo9igtg0ib314ccr5ud77l7uv70.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';
const STATE_KEY = 'wiznote-oauth-state';

const $ = (id) => document.getElementById(id);
const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
$('mode').textContent = standalone ? '主畫面 App' : 'Safari／瀏覽器分頁';

function report(ok, text) {
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'bad';
  li.textContent = `${ok ? '✓' : '✗'} ${text}`;
  $('results').append(li);
  $('note').hidden = false;
}

function storage(action) {
  try {
    return action(localStorage);
  } catch {
    return null;
  }
}

function login() {
  const state = crypto.randomUUID();
  storage((s) => s.setItem(STATE_KEY, state));
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: location.origin + location.pathname,
    response_type: 'token',
    scope: SCOPE,
    state,
    prompt: 'select_account',
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
}

async function listFiles(token, query, fields, pageSize) {
  const q = new URLSearchParams({ q: query, spaces: 'drive', pageSize: String(pageSize), fields });
  const res = await fetch(`${API}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`列出檔案失敗（HTTP ${res.status}）`);
  return (await res.json()).files;
}

async function runTest(token) {
  try {
    const roots = await listFiles(token, "name='WizNote My' and mimeType='application/vnd.google-apps.folder' and trashed=false", 'files(id)', 10);
    report(roots.length > 0, roots.length ? '找得到「WizNote My」資料夾' : '找不到「WizNote My」資料夾（可能是權限不足）');
    const notes = await listFiles(token, "name contains '.md' and trashed=false", 'files(id,size)', 100);
    report(notes.length > 0, notes.length ? `列得出筆記檔（這次取樣 ${notes.length} 個）` : '列不出任何筆記檔');
    if (notes.length) {
      const res = await fetch(`${API}/${encodeURIComponent(notes[0].id)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`下載筆記失敗（HTTP ${res.status}）`);
      const size = (await res.arrayBuffer()).byteLength;
      report(true, `成功下載一篇筆記（${size} 位元組）`);
    }
  } catch (e) {
    report(false, e.message);
  }
}

$('login').onclick = login;

const back = new URLSearchParams(location.hash.slice(1));
if (back.has('access_token') || back.has('error')) {
  history.replaceState(null, '', location.pathname);
  const expected = storage((s) => s.getItem(STATE_KEY));
  storage((s) => s.removeItem(STATE_KEY));
  if (back.has('error')) {
    report(false, `Google 登入失敗：${back.get('error')}`);
  } else if (!expected || expected !== back.get('state')) {
    report(false, `登入回來後無法驗證（${expected ? '狀態不符' : '讀不到登入前的狀態'}），沒有使用這次的授權`);
  } else {
    report(true, `Google 登入成功，並回到${standalone ? '主畫面 App' : 'Safari／瀏覽器分頁'}`);
    runTest(back.get('access_token'));
  }
}
