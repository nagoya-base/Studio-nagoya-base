/*
 * BookingAdmin.gs — Spreadsheetのカスタムメニューからの予約確定（Issue #268）。
 *
 * 専用のWeb管理画面は作らない。SpreadsheetのカスタムメニューからbookingId単位で
 * confirmBooking(bookingId) を呼ぶことを正式な確定手順とする。statusセルの直接編集は
 * 正式運用にしない（このメニュー経由でのみCONFIRMEDへ遷移させる）。
 *
 * bookingIdの指定方法は2通り用意する:
 * 1. Bookings行を選択してから「アクティブ行を確定」を実行する（A列=bookingIdをそのまま読む）
 * 2. 「bookingIdを入力して確定」でダイアログに直接入力する
 *
 * 【重要・デプロイ先について】
 * Googleの仕様上、SpreadsheetApp.getUi()によるカスタムメニュー作成はコンテナバインド
 * スクリプト（対象Spreadsheetに直接紐付けたApps Scriptプロジェクト）からしか使えない。
 * スタンドアロンスクリプトからinstallable onOpenトリガーを作成しても、そのスクリプト自体が
 * bound scriptになるわけではなく、getUi()は利用できない（1回目レビューで採用した
 * installBookingAdminMenuTrigger()方式は、この理由により2回目レビューで撤回した）。
 *
 * そのため、このファイル（BookingAdmin.gs）と、これが依存する予約ロジック一式は、
 * Web App本体（Code.gs等。スタンドアロンのまま）とは別に、SPREADSHEET_ID の
 * Spreadsheetへコンテナバインドした専用のApps Scriptプロジェクト（Booking Admin）へ
 * デプロイすることを正式な運用手順とする。ファイル構成・セットアップ手順の詳細は
 * README.md「管理メニュー用GASプロジェクト（container-bound）のセットアップ」を参照。
 * コンテナバインドスクリプトでは単純トリガーの`onOpen()`がSpreadsheetを開くたびに
 * 自動発火するため、追加のトリガー作成作業は不要。
 *
 * 【重要・LockServiceについて】
 * confirmBooking（このBooking Adminプロジェクトで実行）とexpirePendingBookings
 * （Web App側のプロジェクトで時間主導トリガーにより実行）は別々のApps Scriptプロジェクトで
 * 動くため、LockService.getScriptLock()が提供する排他はプロジェクトごとに独立しており、
 * 両者の間では排他されない。BookingRepository.confirmBookingはCalendarを実際に
 * 変更する直前にもう一度Sheets上のstatusを読み直す再確認を行い、この競合windowを
 * 可能な限り小さくしているが、理論上のwindowを完全にゼロにはできない
 * （README「既知の制約」参照。「絶対に競合しない」とは書かないこと）。
 *
 * このファイルはSpreadsheetApp.getUi()に依存するため、GAS実行環境でのみ動作する。
 * node --testではonOpen/メニュー部分はスタブを使って配線のみ検証し、confirmBooking
 * 自体のロジックはBookingRepositoryのテストで担保する。
 */
'use strict';

/* 正式関数: confirmBooking(bookingId)（Issue #268本文どおりのグローバル関数名）。
   スクリプトエディタから直接実行することもできる。 */
function confirmBooking(bookingId) {
  return BookingRepository.confirmBooking(bookingId);
}

/* 単純トリガー。このファイルをSPREADSHEET_IDのSpreadsheetへコンテナバインドした
   Apps Scriptプロジェクトへデプロイしていれば、そのSpreadsheetを開くたびに
   自動発火し、追加のトリガー設定なしで「予約管理」メニューが表示される。 */
function onOpen() {
  addBookingAdminMenu();
}

/* メニュー構築本体（onOpenから呼ばれる）。 */
function addBookingAdminMenu() {
  SpreadsheetApp.getUi()
    .createMenu('予約管理')
    .addItem('アクティブ行のbookingIdを確定（confirmBooking）', 'confirmActiveRowBooking_')
    .addItem('bookingIdを入力して確定（confirmBooking）', 'confirmBookingByPrompt_')
    .addToUi();
}

function confirmActiveRowBooking_() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var activeRange = sheet.getActiveRange();
  if (!activeRange) {
    ui.alert('確定したい予約の行を選択してから実行してください。');
    return;
  }
  var row = activeRange.getRow();
  if (row <= 1) {
    ui.alert('見出し行ではなく、bookingIdの行を選択してください。');
    return;
  }
  var bookingId = sheet.getRange(row, 1).getValue();
  if (!bookingId) {
    ui.alert('選択した行にbookingIdがありません。');
    return;
  }
  runConfirmAndAlert_(bookingId);
}

function confirmBookingByPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('確定するbookingIdを入力してください', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var bookingId = (response.getResponseText() || '').trim();
  if (!bookingId) {
    ui.alert('bookingIdを入力してください。');
    return;
  }
  runConfirmAndAlert_(bookingId);
}

function runConfirmAndAlert_(bookingId) {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = confirmBooking(bookingId);
    if (result.success) {
      ui.alert(result.alreadyConfirmed ? 'すでに確定済みです: ' + bookingId : '確定しました: ' + bookingId);
    } else {
      ui.alert('確定できませんでした（' + bookingId + '）: ' + (result.error && result.error.message));
    }
  } catch (e) {
    ui.alert('エラーが発生しました（' + bookingId + '）: ' + (e && e.message));
  }
}
