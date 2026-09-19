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
 * このファイルはSpreadsheetApp.getUi()に依存するため、GAS実行環境（Spreadsheetに
 *紐付けたコンテナバインドスクリプト、またはSpreadsheetを開いた状態でのスタンドアロン
 * スクリプト）でのみ動作する。node --testではonOpen/メニュー部分はスタブを使って
 * 配線のみ検証し、confirmBooking自体のロジックはBookingRepositoryのテストで担保する。
 */
'use strict';

/* 正式関数: confirmBooking(bookingId)（Issue #268本文どおりのグローバル関数名）。
   Spreadsheetのスクリプトエディタから直接実行することもできる。 */
function confirmBooking(bookingId) {
  return BookingRepository.confirmBooking(bookingId);
}

function onOpen() {
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
