/*
 * gas-adapter.js — 共通接続契約のGAS実アダプター（Issue #936）。
 *
 * GASのWebアプリ内（HtmlService配信）でだけ使う。google.script.run はここに閉じ込め、画面ロジック
 * （ops-client.js）は契約 { list, detail } だけに依存する。呼ぶのは読み取り専用の2関数のみ。
 * 失敗ハンドラは通信失敗を「取得に失敗」として扱う（0件・正常にはしない）。応答の中身は検証せず
 * バックエンドの応答をそのまま渡す（権限判定はサーバー側）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpsGasAdapter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* runner は google.script.run 相当（テストでは差し替える）。 */
  function createGasApi(runner) {
    function call(name, arg, ok, ng) {
      try {
        runner.withSuccessHandler(ok).withFailureHandler(ng)[name](arg);
      } catch (e) {
        ng(e);
      }
    }
    return {
      kind: 'gas',
      list: function (params, ok, ng) { call('opsListReservations', params, ok, ng); },
      detail: function (id, ok, ng) { call('opsGetReservation', id, ok, ng); }
    };
  }

  return { createGasApi: createGasApi };
});
