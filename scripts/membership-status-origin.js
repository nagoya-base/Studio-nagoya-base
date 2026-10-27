/*
 * scripts/membership-status-origin.js — 会員資格確認ページ（/membership/status/）の戻り先をブランド別に保つ（Issue #555）。
 * - 遷移元は ?from=mens|studio-x（SNBは指定なし）で受け取る。許可済みの2値だけを採用し、それ以外（未知・不正・URL風の値）はSNBへ。
 * - 戻り先のURL・文言はページ（includeが描画したデータ属性）から取り、URLパラメータの値はhrefに一切使わない（open redirect不可）。
 * - メールのワンタイムリンクは別タブ・別アプリから開かれて ?from を持たないため、?from付きで開かれたときだけ遷移元の「ブランド名」を
 *   localStorageに短時間（2時間）保存し、#t= 経路のときに限って引き継ぐ。保存するのはブランド名のみで、トークン・メールアドレスは含めない。
 *   ストレージが使えない・期限切れ・保存値が不正なときはSNBへ戻す。本人確認・レート制限・解約の処理（membership-status.js）には触れない。
 */
(function (root) {
  'use strict';

  var ALLOWED = ['mens', 'studio-x'];
  var STORAGE_KEY = 'snb_membership_status_from';
  var TTL_MS = 2 * 60 * 60 * 1000;

  function parseFrom(search) {
    var match = /(?:^\?|&)from=([^&#]*)/.exec(search || '');
    if (!match) return null;
    var value;
    try { value = decodeURIComponent(match[1]); } catch (e) { return null; }
    return ALLOWED.indexOf(value) !== -1 ? value : null;
  }

  function loadStored(storage, nowMs) {
    try {
      var raw = storage && storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || ALLOWED.indexOf(data.brand) === -1) return null;
      if (typeof data.savedAt !== 'number' || nowMs - data.savedAt < 0 || nowMs - data.savedAt > TTL_MS) return null;
      return data.brand;
    } catch (e) { return null; }
  }

  function save(storage, brand, nowMs) {
    try {
      if (!storage) return;
      if (brand) storage.setItem(STORAGE_KEY, JSON.stringify({ brand: brand, savedAt: nowMs }));
      else storage.removeItem(STORAGE_KEY);
    } catch (e) { /* ストレージ不可でもSNB既定で動く */ }
  }

  /* 表示するブランドを決める。?from があればそれを最優先して保存し、なければ #t= 経路（メール再訪）のときだけ保存値を使う。 */
  function resolveBrand(search, hash, storage, nowMs) {
    var fromParam = parseFrom(search);
    if (fromParam) { save(storage, fromParam, nowMs); return fromParam; }
    if (/(?:^#|&)t=/.test(hash || '')) return loadStored(storage, nowMs);
    save(storage, null, nowMs);
    return null;
  }

  function applyBacklink(link, brand) {
    if (!link || !brand) return;
    var href = link.getAttribute('data-href-' + brand);
    var label = link.getAttribute('data-label-' + brand);
    if (!href || !label) return;
    link.setAttribute('href', href);
    link.textContent = label;
  }

  var api = { parseFrom: parseFrom, resolveBrand: resolveBrand, applyBacklink: applyBacklink };
  root.MembershipStatusOrigin = api;

  if (typeof document === 'undefined' || !root.location) return;
  var storage = null;
  try { storage = root.localStorage; } catch (e) { storage = null; }
  var brand = resolveBrand(root.location.search, root.location.hash, storage, Date.now());
  applyBacklink(document.getElementById('membership-status-backlink'), brand);
})(typeof window !== 'undefined' ? window : this);
