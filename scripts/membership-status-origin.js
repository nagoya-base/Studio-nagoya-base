/*
 * scripts/membership-status-origin.js — 会員資格確認ページ（/membership/status/）の戻り先をブランド別に保つ（Issue #555）。
 * - 遷移元は ?from=mens|studio-x（SNBは指定なし）で受け取る。許可済みの2値だけを採用し、それ以外（未知・不正・URL風の値）はSNBへ。
 * - 戻り先のURL・文言はページ（includeが描画したデータ属性）から取り、URLパラメータの値はhrefに一切使わない（open redirect不可）。
 * - メールのワンタイムリンクは別タブ・別アプリから開かれて ?from を持たないため、?from付きで開かれたときだけ遷移元の「ブランド名」を
 *   ブランドごとに localStorage へ短時間（2時間）保存し、#t= 経路のときに限って引き継ぐ。保存するのはブランド名と時刻のみで、
 *   トークン・メールアドレスは含めない。メールとブランドの対応は分からないため、有効な保存が複数ブランドにまたがる（別ブランドから
 *   続けて確認を始めた）ときは誤誘導を避けてSNBへ戻す。#t= を使った時点で保存は破棄する。
 *   ストレージが使えない・期限切れ・保存値が不正なときもSNBへ戻す。本人確認・レート制限・解約の処理（membership-status.js）には触れない。
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

  function readMap(storage) {
    try {
      var raw = storage && storage.getItem(STORAGE_KEY);
      var data = raw ? JSON.parse(raw) : null;
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) { return {}; }
  }

  function writeMap(storage, map) {
    try {
      if (!storage) return;
      if (Object.keys(map).length) storage.setItem(STORAGE_KEY, JSON.stringify(map));
      else storage.removeItem(STORAGE_KEY);
    } catch (e) { /* ストレージ不可でもSNB既定で動く */ }
  }

  /* 期限内で許可済みブランドの保存だけを残す。 */
  function liveMap(storage, nowMs) {
    var raw = readMap(storage);
    var map = {};
    ALLOWED.forEach(function (brand) {
      var savedAt = raw[brand];
      if (typeof savedAt === 'number' && nowMs - savedAt >= 0 && nowMs - savedAt <= TTL_MS) map[brand] = savedAt;
    });
    return map;
  }

  /* 表示するブランドを決める。?from があればそれを最優先して保存し、なければ #t= 経路（メール再訪）のときだけ保存値を使う。 */
  function resolveBrand(search, hash, storage, nowMs) {
    var fromParam = parseFrom(search);
    if (fromParam) {
      var map = liveMap(storage, nowMs);
      map[fromParam] = nowMs;
      writeMap(storage, map);
      return fromParam;
    }
    if (/(?:^#|&)t=/.test(hash || '')) {
      var brands = Object.keys(liveMap(storage, nowMs));
      writeMap(storage, {});
      return brands.length === 1 ? brands[0] : null;
    }
    writeMap(storage, {});
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
