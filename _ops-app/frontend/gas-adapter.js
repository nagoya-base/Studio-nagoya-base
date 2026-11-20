/*
 * gas-adapter.js — 共通接続契約のGAS実アダプター（Issue #936）。
 *
 * GASのWebアプリ内（HtmlService配信）でだけ使う。google.script.run はここに閉じ込め、画面ロジック
 * （ops-client.js）は契約 { list, detail } だけに依存する。予約は読み取り専用の2関数のみ。
 * メモ（#941）は createGasTasksApi（一覧・保存・削除の3関数。保存先は専用スプレッドシートに固定）。
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
      detail: function (id, ok, ng) { call('opsGetReservation', id, ok, ng); },
      /* 鍵・案内の状況（#942）。読み取り専用。接続先・トークンは画面に渡らない。 */
      keyStatus: function (id, ok, ng) { call('opsGetKeyStatus', id, ok, ng); },
      /* 年商・月次の売上集計（#990 PR-B）。読み取り専用。 */
      revenue: function (params, ok, ng) { call('opsGetRevenue', params, ok, ng); },
      /* 運営枠の閲覧（#1003）。読み取り専用。読取先Calendarは引数で渡さない（サーバー側の設定に固定）。 */
      internalSlots: function (ok, ng) { call('opsListInternalSlots', {}, ok, ng); }
    };
  }

  /*
   * メモ（Issue #941）用のGASアダプター。保存・削除は端末の項目と版番号だけを渡し、保存先のID・範囲・
   * 権限は一切渡さない（サーバーが毎回、所有者認可して専用の保存先に固定して書く）。
   * 通信失敗は ng として通知する。成功か失敗かの判断（保存を確認できたか）は応答の ok だけに基づく。
   */
  function createGasTasksApi(runner) {
    function call(name, arg, ok, ng) {
      try {
        runner.withSuccessHandler(ok).withFailureHandler(ng)[name](arg);
      } catch (e) {
        ng(e);
      }
    }
    return {
      kind: 'gas',
      list: function (ok, ng) { call('opsListTasks', {}, ok, ng); },
      save: function (payload, ok, ng) { call('opsSaveTask', payload, ok, ng); },
      remove: function (payload, ok, ng) { call('opsDeleteTask', payload, ok, ng); }
    };
  }

  /*
   * SNBC売上・現地払い受領（Issue #995）用のGASアダプター。端末の項目と版番号だけを渡し、保存先のID・タブ名・範囲は一切渡さない
   * （サーバーが毎回、所有者認可して既存メモ保存先内の固定2タブに限って読み書きする）。
   */
  function createGasRecordsApi(runner) {
    function call(name, arg, ok, ng) {
      try {
        runner.withSuccessHandler(ok).withFailureHandler(ng)[name](arg);
      } catch (e) {
        ng(e);
      }
    }
    return {
      kind: 'gas',
      snbcList: function (ok, ng) { call('opsListSnbc', {}, ok, ng); },
      snbcSave: function (payload, ok, ng) { call('opsSaveSnbc', payload, ok, ng); },
      snbcDelete: function (payload, ok, ng) { call('opsDeleteSnbc', payload, ok, ng); },
      onsiteGet: function (bookingId, ok, ng) { call('opsGetOnsite', bookingId, ok, ng); },
      onsiteSave: function (payload, ok, ng) { call('opsSaveOnsite', payload, ok, ng); },
      onsiteDelete: function (payload, ok, ng) { call('opsDeleteOnsite', payload, ok, ng); }
    };
  }

  return { createGasApi: createGasApi, createGasTasksApi: createGasTasksApi, createGasRecordsApi: createGasRecordsApi };
});
