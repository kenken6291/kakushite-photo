/**
 * config.js — 画像マスキング 設定
 * ここの値は「既定値」です。画面右上の歯車アイコンから変更した値（localStorage）が優先されます。
 */
window.APP_CONFIG = {
  APP_NAME: 'かくしてフォト',
  VERSION: 'v1.0.0',
  BUILD_DATE: '2026-10-22',

  // GAS WebアプリのURL（デプロイ後の https://script.google.com/macros/s/xxxx/exec）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbznXUmWK94AI39h2VAAeCxAcFyPsuYS2XP5aQT7E59gfspT6aSOxt3I-gQfmCF-Acj7oA/exec',

  // Google Earth Studio で書き出した動画（mp4/webm）のURL。ログイン画面の背景に使います。
  // 例: 'assets/earth-intro.mp4'（リポジトリに置いた場合）
  EARTH_STUDIO_VIDEO_URL: '',

  // 自動検出時にGeminiへ送る画像の長辺(px)
  DETECT_MAX_SIDE: 1536,
  // 作業用キャンバスの最大長辺(px)。これより大きい画像は縮小して読み込みます
  WORK_MAX_SIDE: 3200,
  // 元に戻すの最大回数
  HISTORY_LIMIT: 20,

  CHANGELOG: [
    {
      version: 'v1.0.0',
      date: '2026-10-22',
      notes: [
        '初版リリース',
        '顔・文字の自動検出（Gemini API）',
        '矩形・ブラシ・消しゴムによる手動マスク',
        'モザイク／ぼかしの切り替えと強さ調整',
        'PNG/JPEGダウンロード、Googleドライブ保存',
        '音声案内（Gemini TTS、失敗時はブラウザ読み上げ）',
        '会員登録・仮パスワード・初回パスワード変更・再発行'
      ]
    }
  ]
};

/** 設定の読み書き（localStorage優先、なければ APP_CONFIG の既定値） */
window.Config = (() => {
  const PREFIX = 'kakushite.cfg.';
  function get(key) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      if (v !== null) return v;
    } catch (e) { /* localStorage不可の環境 */ }
    const d = window.APP_CONFIG[key];
    return d === undefined || d === null ? '' : d;
  }
  function set(key, value) {
    try {
      if (value === '' || value === null || value === undefined) {
        localStorage.removeItem(PREFIX + key);
      } else {
        localStorage.setItem(PREFIX + key, String(value));
      }
    } catch (e) { /* noop */ }
  }
  function reset(keys) {
    keys.forEach(k => { try { localStorage.removeItem(PREFIX + k); } catch (e) { /* noop */ } });
  }
  return { get, set, reset };
})();
