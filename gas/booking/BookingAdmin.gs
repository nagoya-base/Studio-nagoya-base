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
 * 【重要・BookingTriggers.gsも同じプロジェクトへ】
 * PENDING TTL失効（`expirePendingBookings`）もこのBooking Adminプロジェクトへ
 * デプロイし、その時間主導トリガーもここで作成する（BookingTriggers.gs参照）。
 * confirmBookingとexpirePendingBookingsを同一プロジェクトに置くことで、両者が同じ
 * LockService.getScriptLock()を共有し、PENDING→CONFIRMEDとPENDING→EXPIREDが
 * 同時に進んでCalendar/Sheetsが不整合になる競合を排除している（3回目レビュー指摘対応。
 * 当初はexpirePendingBookingsをWeb App側に置く設計だったが、LockServiceがプロジェクト
 * ごとに独立しているため確定/失効間の排他が効かず、指摘を受けてBooking Adminへ統合した）。
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
    .addItem('予約メールを再送（予約ID指定・強制再送）', 'resendBookingMailByPrompt_')
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

/*
 * 予約メールの個別再送（Issue #271「19. 管理者の個別再送」）。
 * bookingIdとmail typeをそれぞれ別のダイアログで入力させ、明示的なforce resend
 * （{ force: true }）としてBookingMailer.send*ForBookingを呼ぶ。SentAtを先に消す方式は
 * 使わない。ただし状態条件（PENDING mail→PENDINGのみ、等）はforceでも無視しない
 * （BookingMailer.gs側で必ず再確認する）。
 */
var RESEND_MAIL_HANDLERS_ = {
  PENDING: function (bookingId, options) { return BookingMailer.sendPendingMailForBooking(bookingId, options); },
  CONFIRMED: function (bookingId, options) { return BookingMailer.sendConfirmedMailForBooking(bookingId, options); },
  CANCELLED: function (bookingId, options) { return BookingMailer.sendCancelledMailForBooking(bookingId, options); },
  REMINDER: function (bookingId, options) { return BookingMailer.sendReminderMailForBooking(bookingId, options); }
};

function resendBookingMailByPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var idResponse = ui.prompt('再送するbookingIdを入力してください', ui.ButtonSet.OK_CANCEL);
  if (idResponse.getSelectedButton() !== ui.Button.OK) return;
  var bookingId = (idResponse.getResponseText() || '').trim();
  if (!bookingId) {
    ui.alert('bookingIdを入力してください。');
    return;
  }

  var typeResponse = ui.prompt(
    '再送するメール種別を入力してください（PENDING / CONFIRMED / CANCELLED / REMINDER）',
    ui.ButtonSet.OK_CANCEL
  );
  if (typeResponse.getSelectedButton() !== ui.Button.OK) return;
  var mailType = (typeResponse.getResponseText() || '').trim().toUpperCase();

  runResendMailAndAlert_(bookingId, mailType);
}

function runResendMailAndAlert_(bookingId, mailType) {
  var ui = SpreadsheetApp.getUi();
  var sendFn = RESEND_MAIL_HANDLERS_[mailType];
  if (!sendFn) {
    ui.alert('未知のメール種別です: ' + mailType + '（PENDING / CONFIRMED / CANCELLED / REMINDERのいずれかを指定してください）');
    return;
  }
  try {
    var result = sendFn(bookingId, { force: true });
    if (result.success && !result.skipped) {
      ui.alert('再送しました（' + mailType + '）: ' + bookingId);
    } else if (result.skipped) {
      ui.alert(
        '送信条件を満たさないためスキップしました（' + mailType + '）: ' + bookingId + ' / ' + (result.error && result.error.message)
      );
    } else {
      ui.alert('再送に失敗しました（' + mailType + '）: ' + bookingId + ' / ' + (result.error && result.error.message));
    }
  } catch (e) {
    ui.alert('エラーが発生しました（' + bookingId + '）: ' + (e && e.message));
  }
}
