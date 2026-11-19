/*
 * OpsAuth.gs — 所有者認可（Issue #936）。通信方式に依存しない「認証器（authenticator）」の形で定義する。
 *
 * 認証器: function () → { ok: true } | { ok: false, code: 'UNAUTHENTICATED' | 'FORBIDDEN' }
 * 認可の判定材料は「サーバーが検証した利用者本人」だけで、ブラウザーが申告したメール・パラメーター・
 * ヘッダーは使わない。バックエンドは全要求で毎回この認証器を通す。
 *
 * 現在の認証器（GAS Session）: Session.getActiveUser().getEmail() を Script Properties の OPS_OWNER_EMAIL と照合。
 * - 本人が確認できない（空・例外）→ UNAUTHENTICATED（予約情報は返さない）
 * - 所有者設定が無い／不一致 → FORBIDDEN（fail-closed）
 * これは Web App が「自分のみ」(MYSELF) でデプロイされた GAS 経由の呼び出し用。外部のSitesフロントから
 * 呼ぶ認証付き経路は未確定（docs/ops-reservations-936.md §7）。別の認証器（例: 検証済みIDトークン）は、
 * 同じ形で追加して OpsApi.handle の ctx.authenticate に渡す。
 */
'use strict';

var OpsAuth = (function () {
  function normalize_(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
  }

  /* deps: { getOwnerEmail(): string|null, getActiveEmail(): string } を注入可能にして、通信方式と切り離す。 */
  function createOwnerAuthenticator(deps) {
    return function authenticate() {
      var owner = normalize_(deps.getOwnerEmail());
      var active = '';
      try { active = normalize_(deps.getActiveEmail()); } catch (e) { active = ''; }
      if (!active) return { ok: false, code: 'UNAUTHENTICATED' };
      if (!owner || owner !== active) return { ok: false, code: 'FORBIDDEN' };
      return { ok: true };
    };
  }

  /* GAS実行環境用（Session / PropertiesService はこのGAS専用アダプター内でのみ参照する）。 */
  function createGasSessionAuthenticator() {
    return createOwnerAuthenticator({
      getOwnerEmail: function () { return PropertiesService.getScriptProperties().getProperty('OPS_OWNER_EMAIL'); },
      getActiveEmail: function () { return Session.getActiveUser().getEmail(); }
    });
  }

  /*
   * 時間主導トリガー専用（#971 Phase 2）。トリガー実行では getActiveUser() が空になり得るため、
   * 実行主体（トリガーを登録した所有者）を表す getEffectiveUser() を OPS_OWNER_EMAIL と照合する。
   * 保存用の自動実行入口（opsSaveKeyFinalStatusesScheduled）だけが使う。画面・手動実行の認証器は変更しない。
   */
  function createGasTriggerAuthenticator() {
    return createOwnerAuthenticator({
      getOwnerEmail: function () { return PropertiesService.getScriptProperties().getProperty('OPS_OWNER_EMAIL'); },
      getActiveEmail: function () { return Session.getEffectiveUser().getEmail(); }
    });
  }

  return { createOwnerAuthenticator: createOwnerAuthenticator, createGasSessionAuthenticator: createGasSessionAuthenticator, createGasTriggerAuthenticator: createGasTriggerAuthenticator };
})();
