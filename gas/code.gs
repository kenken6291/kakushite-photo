/**
 * code.gs — かくしてフォト（画像マスキング）バックエンド
 *
 * ■ スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   GEMINI_API_KEY   : 必須。Gemini APIキー
 *   GEMINI_MODEL     : 任意。検出用モデル（既定: gemini-2.5-flash）
 *   TTS_MODEL        : 任意。音声合成モデル（既定: gemini-2.5-flash-preview-tts）
 *   TTS_VOICE        : 任意。音声名（既定: Kore）
 *   SPREADSHEET_ID   : 任意。未設定ならバインド先 or 自動作成
 *   DRIVE_FOLDER_ID  : 任意。未設定なら「かくしてフォト」フォルダを自動作成
 *   APP_URL          : 任意。メール本文に載せるアプリURL
 *
 * ■ デプロイ
 *   デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *   実行ユーザー: 自分 / アクセスできるユーザー: 全員
 */

const VERSION = 'v1.0.0';
const APP_NAME = 'かくしてフォト';

const SHEET_USERS = 'Users';
const SHEET_SESSIONS = 'Sessions';
const SHEET_IMAGES = 'Images';

const USER_HEADERS = ['email', 'passwordHash', 'salt', 'status', 'createdAt', 'updatedAt', 'failCount', 'lockedUntil', 'lastLogin'];
const SESSION_HEADERS = ['token', 'email', 'createdAt', 'expiresAt'];
const IMAGE_HEADERS = ['savedAt', 'email', 'maskedFileId', 'maskedUrl', 'originalFileId', 'originalUrl', 'fileName'];

const STATUS_PENDING = '初回ログイン待ち';
const STATUS_ACTIVE = '有効';
const STATUS_SUSPENDED = '停止';

const SESSION_HOURS = 24 * 7;
const MAX_FAIL = 5;
const LOCK_MINUTES = 15;
const HASH_ROUNDS = 300;
const TTS_MAX_CHARS = 400;

/* =========================================================
 * ルーティング
 * ========================================================= */
function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません' });
  }
  try {
    switch (req.action) {
      case 'ping':           return json_({ ok: true, message: 'pong', version: VERSION });
      case 'register':       return json_(register_(req));
      case 'login':          return json_(login_(req));
      case 'verify':         return json_(verify_(req));
      case 'logout':         return json_(logout_(req));
      case 'changePassword': return json_(changePassword_(req));
      case 'resetPassword':  return json_(resetPassword_(req));
      case 'detect':         return json_(detect_(req));
      case 'tts':            return json_(tts_(req));
      case 'saveImage':      return json_(saveImage_(req));
      default:               return json_({ ok: false, error: '不明な操作です: ' + req.action });
    }
  } catch (err) {
    if (err && err.code) return json_({ ok: false, code: err.code, error: err.message });
    console.error(err);
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet() {
  return json_({ ok: true, app: APP_NAME, version: VERSION });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function appError_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* =========================================================
 * 会員認証
 * ========================================================= */
function register_(req) {
  const email = normalizeEmail_(req.email);
  if (!isValidEmail_(email)) return { ok: false, error: 'メールアドレスの形式が正しくありません' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet_(SHEET_USERS, USER_HEADERS);
    if (findUser_(sh, email)) {
      return { ok: false, error: 'このメールアドレスは登録済みです。「パスワードを忘れた方」から仮パスワードを再発行してください' };
    }
    const temp = generateTempPassword_();
    // 先にメール送信（失敗したら登録しない）
    sendTempPasswordMail_(email, temp, '会員登録');

    const salt = Utilities.getUuid();
    const now = new Date();
    sh.appendRow([email, hashPassword_(temp, salt), salt, STATUS_PENDING, now, now, 0, '', '']);
    return { ok: true, message: '仮パスワードを ' + email + ' に送信しました。メールを確認してログインしてください' };
  } finally {
    lock.releaseLock();
  }
}

function login_(req) {
  const email = normalizeEmail_(req.email);
  const password = String(req.password || '');
  const generic = 'メールアドレスまたはパスワードが違います';
  if (!email || !password) return { ok: false, error: generic };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet_(SHEET_USERS, USER_HEADERS);
    const u = findUser_(sh, email);
    if (!u) return { ok: false, error: generic };

    const now = new Date();
    if (u.lockedUntil && new Date(u.lockedUntil) > now) {
      const mins = Math.ceil((new Date(u.lockedUntil) - now) / 60000);
      return { ok: false, error: 'ログインに' + MAX_FAIL + '回失敗したためロック中です。約' + mins + '分後にお試しいただくか、パスワードを再発行してください' };
    }
    if (u.status === STATUS_SUSPENDED) return { ok: false, error: 'このアカウントは利用停止中です' };

    if (hashPassword_(password, u.salt) !== u.passwordHash) {
      const fail = Number(u.failCount || 0) + 1;
      setUserFields_(sh, u.row, { failCount: fail, lockedUntil: fail >= MAX_FAIL ? new Date(now.getTime() + LOCK_MINUTES * 60000) : '' });
      if (fail >= MAX_FAIL) return { ok: false, error: 'ログインに' + MAX_FAIL + '回失敗したため' + LOCK_MINUTES + '分間ロックしました' };
      return { ok: false, error: generic + '（残り' + (MAX_FAIL - fail) + '回でロック）' };
    }

    setUserFields_(sh, u.row, { failCount: 0, lockedUntil: '', lastLogin: now });
    const token = createSession_(email);
    return { ok: true, token: token, email: email, mustChange: u.status === STATUS_PENDING };
  } finally {
    lock.releaseLock();
  }
}

function verify_(req) {
  const s = requireSession_(req.token, true);
  return { ok: true, email: s.email, mustChange: s.user.status === STATUS_PENDING };
}

function logout_(req) {
  if (!req.token) return { ok: true };
  const sh = getSheet_(SHEET_SESSIONS, SESSION_HEADERS);
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][0] === req.token) sh.deleteRow(i + 1);
  }
  return { ok: true };
}

function changePassword_(req) {
  const s = requireSession_(req.token, true);
  const current = String(req.currentPassword || '');
  const next = String(req.newPassword || '');

  const v = validatePassword_(next);
  if (v) return { ok: false, error: v };
  if (current === next) return { ok: false, error: '新しいパスワードは現在のパスワードと別のものにしてください' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet_(SHEET_USERS, USER_HEADERS);
    const u = findUser_(sh, s.email);
    if (!u) throw appError_('AUTH', 'アカウントが見つかりません。再度ログインしてください');
    if (hashPassword_(current, u.salt) !== u.passwordHash) {
      return { ok: false, error: '現在のパスワード（仮パスワード）が違います' };
    }
    const salt = Utilities.getUuid();
    setUserFields_(sh, u.row, {
      passwordHash: hashPassword_(next, salt),
      salt: salt,
      status: STATUS_ACTIVE,
      updatedAt: new Date()
    });
    return { ok: true, mustChange: false, message: 'パスワードを変更しました' };
  } finally {
    lock.releaseLock();
  }
}

function resetPassword_(req) {
  const email = normalizeEmail_(req.email);
  const generic = { ok: true, message: '登録済みのメールアドレスであれば、新しい仮パスワードを送信しました。メールを確認してください' };
  if (!isValidEmail_(email)) return { ok: false, error: 'メールアドレスの形式が正しくありません' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet_(SHEET_USERS, USER_HEADERS);
    const u = findUser_(sh, email);
    if (!u || u.status === STATUS_SUSPENDED) return generic;

    const temp = generateTempPassword_();
    sendTempPasswordMail_(email, temp, 'パスワード再発行');

    const salt = Utilities.getUuid();
    setUserFields_(sh, u.row, {
      passwordHash: hashPassword_(temp, salt),
      salt: salt,
      status: STATUS_PENDING,
      failCount: 0,
      lockedUntil: '',
      updatedAt: new Date()
    });
    deleteSessionsFor_(email);
    return generic;
  } finally {
    lock.releaseLock();
  }
}

/** セッション確認。allowMustChange=false の場合、初回パスワード変更前は拒否 */
function requireSession_(token, allowMustChange) {
  if (!token) throw appError_('AUTH', 'ログインしてください');
  const sh = getSheet_(SHEET_SESSIONS, SESSION_HEADERS);
  const values = sh.getDataRange().getValues();
  let found = null;
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === token) { found = { email: values[i][1], expiresAt: values[i][3], row: i + 1 }; break; }
  }
  if (!found) throw appError_('AUTH', 'セッションが無効です。再度ログインしてください');
  if (new Date(found.expiresAt) < new Date()) {
    sh.deleteRow(found.row);
    throw appError_('AUTH', 'セッションの有効期限が切れました。再度ログインしてください');
  }
  const user = findUser_(getSheet_(SHEET_USERS, USER_HEADERS), found.email);
  if (!user || user.status === STATUS_SUSPENDED) throw appError_('AUTH', 'このアカウントは利用できません');
  if (!allowMustChange && user.status === STATUS_PENDING) {
    throw appError_('MUST_CHANGE', '先にパスワードを変更してください');
  }
  return { email: found.email, user: user };
}

function createSession_(email) {
  const sh = getSheet_(SHEET_SESSIONS, SESSION_HEADERS);
  // 期限切れセッションの掃除
  const values = sh.getDataRange().getValues();
  const now = new Date();
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][3] && new Date(values[i][3]) < now) sh.deleteRow(i + 1);
  }
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  sh.appendRow([token, email, now, new Date(now.getTime() + SESSION_HOURS * 3600000)]);
  return token;
}

function deleteSessionsFor_(email) {
  const sh = getSheet_(SHEET_SESSIONS, SESSION_HEADERS);
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][1] === email) sh.deleteRow(i + 1);
  }
}

/* =========================================================
 * Gemini：顔・文字の自動検出
 * ========================================================= */
function detect_(req) {
  requireSession_(req.token, false);
  const mode = req.mode === 'text' ? 'text' : 'face';
  const b64 = String(req.imageBase64 || '');
  const mime = String(req.mimeType || 'image/jpeg');
  if (!b64) return { ok: false, error: '画像データがありません' };

  const prompt = mode === 'face'
    ? 'Detect every human face in this image, including small, partially hidden, turned-away or blurry faces. ' +
      'Return ONLY a JSON array. Each element must be {"box_2d":[ymin,xmin,ymax,xmax],"label":"face"} ' +
      'with integer coordinates normalized to 0-1000. Return [] if there are no faces.'
    : 'Detect every region of readable text in this image: signs, name tags, license plates, documents, screens, ' +
      'addresses, phone numbers, handwriting, Japanese and other languages. Group words on the same line into one box. ' +
      'Return ONLY a JSON array. Each element must be {"box_2d":[ymin,xmin,ymax,xmax],"label":"<the text>"} ' +
      'with integer coordinates normalized to 0-1000. Return [] if there is no text.';

  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 }
  };
  const model = prop_('GEMINI_MODEL') || 'gemini-2.5-flash';
  const data = callGemini_(model, body);
  const text = extractText_(data);

  let arr;
  try {
    arr = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    throw new Error('検出結果を読み取れませんでした。もう一度お試しください');
  }
  if (!Array.isArray(arr)) arr = (arr && Array.isArray(arr.items)) ? arr.items : [];

  const items = [];
  arr.forEach(function (it) {
    const b = it && (it.box_2d || it.box || it.bbox);
    if (!Array.isArray(b) || b.length !== 4) return;
    const n = b.map(function (v) { return Math.max(0, Math.min(1000, Number(v) || 0)); });
    if (n[2] <= n[0] || n[3] <= n[1]) return;
    items.push({ box_2d: n, label: String(it.label || (mode === 'face' ? 'face' : '')).slice(0, 80) });
  });
  return { ok: true, mode: mode, items: items };
}

/* =========================================================
 * Gemini TTS：音声案内
 * ========================================================= */
function tts_(req) {
  requireSession_(req.token, true);
  const text = String(req.text || '').trim().slice(0, TTS_MAX_CHARS);
  if (!text) return { ok: false, error: '読み上げる文章がありません' };

  const body = {
    contents: [{ parts: [{ text: '落ち着いた明るい声で、ゆっくり読み上げてください：' + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: prop_('TTS_VOICE') || 'Kore' } } }
    }
  };
  const model = prop_('TTS_MODEL') || 'gemini-2.5-flash-preview-tts';
  const data = callGemini_(model, body);
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const audioPart = parts.filter(function (p) { return p.inlineData || p.inline_data; })[0];
  if (!audioPart) throw new Error('音声を生成できませんでした');
  const inline = audioPart.inlineData || audioPart.inline_data;
  return { ok: true, audio: inline.data, mimeType: inline.mimeType || inline.mime_type || 'audio/L16;codec=pcm;rate=24000' };
}

function callGemini_(model, body) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY がスクリプトプロパティに設定されていません');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const txt = res.getContentText();
  if (code !== 200) {
    console.error('Gemini error', code, txt);
    let msg = 'Gemini APIエラー (' + code + ')';
    try { msg += ': ' + JSON.parse(txt).error.message; } catch (e) { /* noop */ }
    throw new Error(msg);
  }
  return JSON.parse(txt);
}

function extractText_(data) {
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(function (p) { return p.text || ''; }).join('');
}

/* =========================================================
 * Googleドライブ保存
 * ========================================================= */
function saveImage_(req) {
  const s = requireSession_(req.token, false);
  const masked = String(req.maskedBase64 || '');
  if (!masked) return { ok: false, error: '保存する画像がありません' };

  const baseName = sanitizeName_(req.fileName || 'image');
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const folder = getUserFolder_(s.email);

  const maskedMime = req.maskedMime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const maskedExt = maskedMime === 'image/jpeg' ? 'jpg' : 'png';
  const maskedFile = folder.createFile(
    Utilities.newBlob(Utilities.base64Decode(masked), maskedMime, baseName + '_' + stamp + '_masked.' + maskedExt)
  );

  let originalFile = null;
  if (req.originalBase64) {
    const om = String(req.originalMime || 'image/jpeg');
    const ext = (om.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
    originalFile = folder.createFile(
      Utilities.newBlob(Utilities.base64Decode(req.originalBase64), om, baseName + '_' + stamp + '_original.' + ext)
    );
  }

  getSheet_(SHEET_IMAGES, IMAGE_HEADERS).appendRow([
    new Date(), s.email,
    maskedFile.getId(), maskedFile.getUrl(),
    originalFile ? originalFile.getId() : '', originalFile ? originalFile.getUrl() : '',
    baseName
  ]);

  return {
    ok: true,
    message: 'Googleドライブに保存しました',
    maskedUrl: maskedFile.getUrl(),
    originalUrl: originalFile ? originalFile.getUrl() : ''
  };
}

function getRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DRIVE_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 再作成 */ }
  }
  const folder = DriveApp.createFolder(APP_NAME);
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function getUserFolder_(email) {
  const root = getRootFolder_();
  const it = root.getFoldersByName(email);
  return it.hasNext() ? it.next() : root.createFolder(email);
}

/* =========================================================
 * スプレッドシート（DB）操作
 * ========================================================= */
function getDb_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const ss = SpreadsheetApp.create(APP_NAME + '_DB');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function getSheet_(name, headers) {
  const ss = getDb_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function findUser_(sh, email) {
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).toLowerCase() === email) {
      const u = { row: i + 1 };
      USER_HEADERS.forEach(function (h, j) { u[h] = values[i][j]; });
      return u;
    }
  }
  return null;
}

function setUserFields_(sh, row, fields) {
  Object.keys(fields).forEach(function (k) {
    const col = USER_HEADERS.indexOf(k);
    if (col >= 0) sh.getRange(row, col + 1).setValue(fields[k]);
  });
}

/* =========================================================
 * ユーティリティ
 * ========================================================= */
function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword_(pw) {
  if (pw.length < 8) return 'パスワードは8文字以上にしてください';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'パスワードには英字と数字の両方を含めてください';
  return '';
}

function hashPassword_(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function toHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function generateTempPassword_() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  let pw = '';
  while (!(/[A-Za-z]/.test(pw) && /[0-9]/.test(pw))) {
    pw = '';
    for (let i = 0; i < 10; i++) pw += all.charAt(Math.floor(Math.random() * all.length));
  }
  return pw;
}

function sendTempPasswordMail_(email, temp, purpose) {
  const appUrl = prop_('APP_URL');
  const body =
    APP_NAME + ' をご利用いただきありがとうございます。\n\n' +
    '【' + purpose + '】仮パスワードを発行しました。\n\n' +
    '仮パスワード：' + temp + '\n\n' +
    'このパスワードでログインすると、本パスワードへの変更画面が表示されます。\n' +
    (appUrl ? 'ログインはこちら：' + appUrl + '\n' : '') +
    '\n心当たりのない場合は、このメールを破棄してください。\n';
  try {
    MailApp.sendEmail({ to: email, subject: '【' + APP_NAME + '】仮パスワードのお知らせ', body: body, name: APP_NAME });
  } catch (err) {
    console.error(err);
    throw new Error('メールを送信できませんでした。時間をおいて再度お試しください');
  }
}

function sanitizeName_(name) {
  return String(name).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'image';
}

/** 初回セットアップ用：エディタから一度実行して権限承認とシート作成を行う */
function setup() {
  getSheet_(SHEET_USERS, USER_HEADERS);
  getSheet_(SHEET_SESSIONS, SESSION_HEADERS);
  getSheet_(SHEET_IMAGES, IMAGE_HEADERS);
  getRootFolder_();
  console.log('セットアップ完了: DB=' + getDb_().getUrl());
}
