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
 * 【重要】このGASプロジェクトはスタンドアロンのWeb Appとして運用する（README.md
 * 「デプロイ設定」参照）。スタンドアロンスクリプトに単純トリガーの`onOpen()`を書いても、
 * SPREADSHEET_IDで指定した対象Spreadsheetを開いたときには自動発火しない
 * （単純トリガーのonOpenは、このスクリプト自身が対象Spreadsheetにコンテナバインド
 * されている場合のみ有効なため）。
 *
 * そのため、このスクリプトの権限で対象Spreadsheetに対するinstallable onOpenトリガーを
 * 明示的に作成する方式を正式な運用手順とする。運用開始時に、スクリプトエディタで
 * installBookingAdminMenuTrigger() を一度だけ手動実行すること（README.md参照）。
 * これにより、SPREADSHEET_IDのSpreadsheetを開くたびに addBookingAdminMenu が
 * 呼ばれ、「予約管理」メニューが追加される。
 *
 * （このスクリプトを将来コンテナバインドスクリプトへ移行・分離する場合に備え、
 * 単純トリガーのonOpen()もフォールバックとして残しているが、スタンドアロン運用時は
 * 発火しないため、installBookingAdminMenuTrigger()の実行が必須）。
 *
 * このファイルはSpreadsheetApp.getUi()に依存するため、GAS実行環境でのみ動作する。
 * node --testではonOpen/メニュー部分はスタブを使って配線のみ検証し、confirmBooking
 * 自体のロジックはBookingRepositoryのテストで担保する。
 */
'use strict';

/* 正式関数: confirmBooking(bookingId)（Issue #268本文どおりのグローバル関数名）。
   Spreadsheetのスクリプトエディタから直接実行することもできる。 */
function confirmBooking(bookingId) {
  return BookingRepository.confirmBooking(bookingId);
}

/* 単純トリガー用フォールバック。このスクリプトを対象Spreadsheetへ
   コンテナバインドした場合のみ自動発火する（スタンドアロン運用時は発火しない）。 */
function onOpen() {
  addBookingAdminMenu();
}

/* installable onOpenトリガーのハンドラ本体。単純トリガーからも
   installBookingAdminMenuTrigger()で作成したinstallableトリガーからも
   同じこの関数が呼ばれる。 */
function addBookingAdminMenu() {
  SpreadsheetApp.getUi()
    .createMenu('予約管理')
    .addItem('アクティブ行のbookingIdを確定（confirmBooking）', 'confirmActiveRowBooking_')
    .addItem('bookingIdを入力して確定（confirmBooking）', 'confirmBookingByPrompt_')
    .addToUi();
}

/*
 * 運用開始時にスクリプトエディタから一度だけ手動実行する補助関数。
 * SPREADSHEET_IDで指定したSpreadsheetに対するinstallable onOpenトリガーを作成する
 * （このスクリプト自身をそのSpreadsheetへコンテナバインドしなくても、
 * このスクリプトを認可したアカウントの権限でトリガーが動くようになる）。
 * 同一Spreadsheet・同一ハンドラのトリガーが既に存在する場合は重複作成しない。
 * 実行にはSPREADSHEET_IDのSpreadsheetへの編集権限が必要。
 */
function installBookingAdminMenuTrigger() {
  var FUNCTION_NAME = 'addBookingAdminMenu';
  var spreadsheet = SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  var spreadsheetId = spreadsheet.getId();

  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === FUNCTION_NAME && trigger.getTriggerSourceId() === spreadsheetId;
  });
  if (existing.length > 0) {
    Logger.log('トリガーは既に存在します: ' + FUNCTION_NAME + ' (spreadsheet=' + spreadsheetId + ')');
    return existing[0];
  }

  return ScriptApp.newTrigger(FUNCTION_NAME).forSpreadsheet(spreadsheet).onOpen().create();
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
