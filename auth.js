/**
 * auth.js — 会員登録・ログイン・仮パスワード・パスワード変更・GAS通信
 */
window.Auth = (() => {
  'use strict';

  const SESSION_KEY = 'kakushite.session';
  let session = null; // { token, email, mustChange }
  const listeners = [];

  const $ = (s) => document.querySelector(s);

  /* ---------- セッション保存 ---------- */
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      session = raw ? JSON.parse(raw) : null;
    } catch (e) { session = null; }
  }
  function saveSession() {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* noop */ }
  }
  function clearSession() {
    session = null;
    saveSession();
  }

  /* ---------- GAS 通信 ---------- */
  async function call(action, payload = {}) {
    const url = String(Config.get('GAS_URL') || '').trim();
    if (!url) throw new Error('サーバーのURLが未設定です。歯車アイコンの「設定」から登録してください');

    const body = Object.assign({ action }, payload);
    if (session && session.token && !body.token) body.token = session.token;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        // text/plain にすることで CORS のプリフライトを回避
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error('サーバーに接続できません。通信環境と設定のURLを確認してください');
    }
    if (!res.ok) throw new Error('サーバーエラー（' + res.status + '）');

    let data;
    try { data = await res.json(); }
    catch (e) { throw new Error('サーバーの応答を読み取れません。GASのデプロイ設定（アクセス：全員）を確認してください'); }

    if (!data.ok) {
      if (data.code === 'AUTH') {
        clearSession();
        notify();
      } else if (data.code === 'MUST_CHANGE' && session) {
        session.mustChange = true;
        saveSession();
        notify();
      }
      throw new Error(data.error || 'エラーが発生しました');
    }
    return data;
  }

  /* ---------- 状態通知 ---------- */
  function onChange(fn) { listeners.push(fn); }
  function notify() { listeners.forEach(fn => { try { fn(getState()); } catch (e) { console.error(e); } }); }
  function getState() {
    if (!session) return 'loggedOut';
    return session.mustChange ? 'mustChange' : 'active';
  }
  function isActive() { return getState() === 'active'; }
  function isLoggedIn() { return !!session; }
  function email() { return session ? session.email : ''; }

  /* ---------- API ---------- */
  async function login(emailAddr, password) {
    const r = await call('login', { email: emailAddr, password });
    session = { token: r.token, email: r.email, mustChange: !!r.mustChange };
    saveSession();
    notify();
    return r;
  }
  async function register(emailAddr) { return call('register', { email: emailAddr }); }
  async function resetPassword(emailAddr) { return call('resetPassword', { email: emailAddr }); }
  async function changePassword(currentPassword, newPassword) {
    const r = await call('changePassword', { currentPassword, newPassword });
    if (session) { session.mustChange = false; saveSession(); }
    notify();
    return r;
  }
  async function verify() {
    if (!session) { notify(); return false; }
    try {
      const r = await call('verify');
      session.mustChange = !!r.mustChange;
      session.email = r.email;
      saveSession();
      notify();
      return true;
    } catch (e) {
      // 通信失敗時はセッションを保持（URL未設定などで勝手にログアウトさせない）
      notify();
      return false;
    }
  }
  async function logout() {
    try { if (session) await call('logout'); } catch (e) { /* 失敗してもローカルは消す */ }
    clearSession();
    notify();
  }

  /* ---------- 入力チェック ---------- */
  function validateEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()); }
  function validatePassword(pw) {
    if (pw.length < 8) return 'パスワードは8文字以上にしてください';
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'パスワードには英字と数字の両方を含めてください';
    return '';
  }

  /* =========================================================
   * 画面（ログイン／登録／再発行／パスワード変更）
   * ========================================================= */
  function setMsg(el, text, type) {
    el.textContent = text || '';
    el.dataset.type = type || '';
    el.hidden = !text;
  }

  async function withBusy(btn, fn) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>処理中…</span>';
    try { return await fn(); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  }

  function switchTab(name) {
    document.querySelectorAll('[data-auth-tab]').forEach(t => {
      const on = t.dataset.authTab === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.classList.toggle('is-active', on);
    });
    document.querySelectorAll('[data-auth-panel]').forEach(p => { p.hidden = p.dataset.authPanel !== name; });
    document.querySelectorAll('.auth-msg').forEach(m => setMsg(m, ''));
  }

  function bindPasswordToggles() {
    document.querySelectorAll('[data-toggle-pw]').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.togglePw);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
        btn.querySelector('.eye-open').hidden = show;
        btn.querySelector('.eye-closed').hidden = !show;
      });
    });
  }

  function bindForms() {
    document.querySelectorAll('[data-auth-tab]').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.authTab)));
    document.querySelectorAll('[data-goto-tab]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); switchTab(a.dataset.gotoTab); }));

    // ログイン
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#loginMsg');
      const em = $('#loginEmail').value.trim();
      const pw = $('#loginPassword').value;
      if (!validateEmail(em)) return setMsg(msg, 'メールアドレスの形式が正しくありません', 'error');
      if (!pw) return setMsg(msg, 'パスワードを入力してください', 'error');
      await withBusy($('#loginBtn'), async () => {
        try {
          await login(em, pw);
          $('#loginPassword').value = '';
          setMsg(msg, '');
        } catch (err) { setMsg(msg, err.message, 'error'); }
      });
    });

    // 新規登録
    $('#registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#registerMsg');
      const em = $('#registerEmail').value.trim();
      if (!validateEmail(em)) return setMsg(msg, 'メールアドレスの形式が正しくありません', 'error');
      await withBusy($('#registerBtn'), async () => {
        try {
          const r = await register(em);
          setMsg(msg, r.message, 'success');
          $('#loginEmail').value = em;
        } catch (err) { setMsg(msg, err.message, 'error'); }
      });
    });

    // パスワード再発行
    $('#forgotForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#forgotMsg');
      const em = $('#forgotEmail').value.trim();
      if (!validateEmail(em)) return setMsg(msg, 'メールアドレスの形式が正しくありません', 'error');
      await withBusy($('#forgotBtn'), async () => {
        try {
          const r = await resetPassword(em);
          setMsg(msg, r.message, 'success');
          $('#loginEmail').value = em;
        } catch (err) { setMsg(msg, err.message, 'error'); }
      });
    });

    // パスワード変更（初回強制／任意）
    $('#pwChangeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#pwChangeMsg');
      const cur = $('#pwCurrent').value;
      const next = $('#pwNew').value;
      const conf = $('#pwConfirm').value;
      if (!cur) return setMsg(msg, '現在のパスワード（仮パスワード）を入力してください', 'error');
      const v = validatePassword(next);
      if (v) return setMsg(msg, v, 'error');
      if (next !== conf) return setMsg(msg, '確認用パスワードが一致しません', 'error');
      if (cur === next) return setMsg(msg, '新しいパスワードは現在のものと別にしてください', 'error');
      await withBusy($('#pwChangeBtn'), async () => {
        try {
          await changePassword(cur, next);
          ['#pwCurrent', '#pwNew', '#pwConfirm'].forEach(s => { $(s).value = ''; });
          setMsg(msg, '');
          closePasswordModal(true);
          if (window.App && App.toast) App.toast('パスワードを変更しました', 'success');
        } catch (err) { setMsg(msg, err.message, 'error'); }
      });
    });

    $('#pwChangeCancel').addEventListener('click', () => closePasswordModal(false));

    // パスワード強度表示
    $('#pwNew').addEventListener('input', () => {
      const pw = $('#pwNew').value;
      let score = 0;
      if (pw.length >= 8) score++;
      if (pw.length >= 12) score++;
      if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) score++;
      if (/[^A-Za-z0-9]/.test(pw)) score++;
      const meter = $('#pwStrength');
      meter.dataset.level = String(pw ? score : 0);
      $('#pwStrengthLabel').textContent = pw ? ['弱い', '弱い', 'ふつう', '強い', 'とても強い'][score] : '';
    });

    $('#logoutBtn').addEventListener('click', async () => {
      if (!confirm('ログアウトしますか？')) return;
      await logout();
    });
    $('#changePwBtn').addEventListener('click', () => openPasswordModal(false));
  }

  /** forced=true の場合は閉じられない（初回ログイン時） */
  function openPasswordModal(forced) {
    const modal = $('#pwChangeModal');
    modal.dataset.forced = forced ? 'true' : 'false';
    $('#pwChangeTitle').textContent = forced ? '本パスワードを設定してください' : 'パスワードを変更';
    $('#pwChangeLead').textContent = forced
      ? 'メールで届いた仮パスワードでログインしました。続けるには、ご自身で決めたパスワードに変更してください。'
      : '現在のパスワードと、新しいパスワードを入力してください。';
    $('#pwCurrentLabel').textContent = forced ? '仮パスワード' : '現在のパスワード';
    $('#pwChangeCancel').hidden = !!forced;
    modal.hidden = false;
    setTimeout(() => $('#pwCurrent').focus(), 50);
  }
  function closePasswordModal(forceClose) {
    const modal = $('#pwChangeModal');
    if (modal.dataset.forced === 'true' && !forceClose) return;
    modal.hidden = true;
  }

  function render(state) {
    const authScreen = $('#authScreen');
    const mainScreen = $('#mainScreen');
    if (state === 'loggedOut') {
      authScreen.hidden = false;
      mainScreen.hidden = true;
      mainScreen.inert = false;
      $('#pwChangeModal').hidden = true;
      switchTab('login');
      return;
    }
    authScreen.hidden = true;
    mainScreen.hidden = false;
    $('#userEmail').textContent = email();
    if (state === 'mustChange') {
      mainScreen.inert = true; // パスワード変更までメイン機能をロック
      mainScreen.classList.add('is-locked');
      openPasswordModal(true);
    } else {
      mainScreen.inert = false;
      mainScreen.classList.remove('is-locked');
      if ($('#pwChangeModal').dataset.forced === 'true') closePasswordModal(true);
    }
  }

  function init() {
    loadSession();
    bindPasswordToggles();
    bindForms();
    onChange(render);
    render(getState());
    if (session) verify();
  }

  return {
    init, call, login, register, resetPassword, changePassword, logout, verify,
    onChange, getState, isActive, isLoggedIn, email, openPasswordModal
  };
})();
