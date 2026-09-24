/*
 * BookingAdmin.gs — Spreadsheetのカスタムメニューからの予約確定・キャンセル
 * （Issue #268 / Issue #272）。
 *
 * 専用のWeb管理画面は作らない。SpreadsheetのカスタムメニューからbookingId単位で
 * confirmBooking(bookingId) / cancelBookingAdmin(bookingId) を呼ぶことを正式な
 * 確定・キャンセル手順とする。statusセルの直接編集は正式運用にしない（このメニュー
 * 経由でのみCONFIRMED/CANCELLEDへ遷移させる）。cancelBookingAdminはBooking Admin側の
 * みで公開し、公開Web App（Code.gs）にはキャンセル用エンドポイントを一切追加しない
 * （利用者自身のキャンセルURLは#272の非対象）。
 *
 * bookingIdの指定方法は確定・キャンセルともそれぞれ2通り用意する:
 * 1. Bookings行を選択してから「アクティブ行を確定/キャンセル」を実行する
 *    （A列=bookingIdをそのまま読む）
 * 2. 「bookingIdを入力して確定/キャンセル」でダイアログに直接入力する
 *
 * キャンセルのみ、実行直前にYES/NO確認ダイアログを必須にする（誤操作防止。
 * NOなら何も変更しない。confirmBookingにはこの確認を追加していない＝既存挙動のまま）。
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

/* 正式関数: cancelBookingAdmin(bookingId)（Issue #272本文どおりのグローバル関数名）。
   Booking Admin側のみで公開する（公開Web AppにはcancelBookingAdminを一切追加しない）。
   スクリプトエディタから直接実行することもできる。 */
function cancelBookingAdmin(bookingId) {
  return BookingRepository.cancelBookingAdmin(bookingId);
}

/* 正式関数: reviveExpiredBooking(bookingId)（Issue #334本文どおりのグローバル関数名）。
   EXPIRED予約の手動復活。Booking Admin側のみで公開する（Booking Web Appには追加しない）。
   スクリプトエディタから直接実行することもできる。now引数は省略可能（テストから固定時刻で
   「利用開始時刻を過ぎているか」を検証するためだけの引数。メニュー・Web UIからは渡さない）。 */
function reviveExpiredBooking(bookingId, now) {
  return BookingRepository.reviveExpiredBooking(bookingId, now);
}

/* 正式関数: sendCardPaymentLinkMail(bookingId, paymentLinkUrl, options)（Issue #334 PR-C）。
   カード決済PENDING予約者へ、管理者がBooking Adminで入力したStripe決済リンクをメール
   送信する。Booking Admin側のみで公開する（Booking Web Appには追加しない）。
   options.forceは管理者の明示的な再送のみで渡すこと（Web UI側でも同様に扱う）。
   スクリプトエディタから直接実行することもできる。 */
function sendCardPaymentLinkMail(bookingId, paymentLinkUrl, options) {
  return BookingMailer.sendPaymentLinkMailForBooking(bookingId, paymentLinkUrl, options);
}

/* 正式関数: resolveCardPaymentLinkMetadataInconsistency(bookingId, confirmedSendCount)
   （第3回PRレビュー対応）。paymentLinkMetadataInconsistentAtが記録された予約の送信履歴
   （paymentLinkSendCount）を、管理者が確認した正しい値へ明示的に補正する。Booking Admin
   側のみで公開する（Booking Web Appには追加しない）。メール送信・Calendar操作は行わない。
   スクリプトエディタから直接実行することもできる。 */
function resolveCardPaymentLinkMetadataInconsistency(bookingId, confirmedSendCount) {
  return BookingMailer.resolvePaymentLinkMetadataInconsistency(bookingId, confirmedSendCount);
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
    .addItem('アクティブ行のbookingIdをキャンセル（cancelBookingAdmin）', 'cancelActiveRowBooking_')
    .addItem('bookingIdを入力してキャンセル（cancelBookingAdmin）', 'cancelBookingByPrompt_')
    .addItem('アクティブ行のbookingIdを復活（reviveExpiredBooking）', 'reviveActiveRowBooking_')
    .addItem('bookingIdを入力して復活（reviveExpiredBooking）', 'reviveBookingByPrompt_')
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
 * キャンセル導線（Issue #272）。confirmと対称に、アクティブ行選択とbookingId直接入力の
 * 2通りを用意する。statusセルの直接編集は案内しない。誤操作防止のため、実行直前に
 * 必ずYES/NO確認を挟み、NOなら何も変更しない。
 */
function cancelActiveRowBooking_() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var activeRange = sheet.getActiveRange();
  if (!activeRange) {
    ui.alert('キャンセルしたい予約の行を選択してから実行してください。');
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
  confirmAndRunCancel_(bookingId);
}

function cancelBookingByPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('キャンセルするbookingIdを入力してください', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var bookingId = (response.getResponseText() || '').trim();
  if (!bookingId) {
    ui.alert('bookingIdを入力してください。');
    return;
  }
  confirmAndRunCancel_(bookingId);
}

/* 実行直前の誤操作防止確認。NOならcancelBookingAdmin自体を呼ばない。 */
function confirmAndRunCancel_(bookingId) {
  var ui = SpreadsheetApp.getUi();
  var confirmed = ui.alert(
    '予約 ' + bookingId + ' をキャンセルします。\n' +
      'Calendarから予約枠を削除し、利用者へキャンセルメールを送信します。\n' +
      'よろしいですか？',
    ui.ButtonSet.YES_NO
  );
  if (confirmed !== ui.Button.YES) return;
  runCancelAndAlert_(bookingId);
}

function runCancelAndAlert_(bookingId) {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = cancelBookingAdmin(bookingId);
    if (result.success) {
      if (result.alreadyCancelled) {
        ui.alert('すでにキャンセル済みです: ' + bookingId);
      } else if (result.calendarAlreadyMissing) {
        ui.alert('キャンセルしました。Calendarイベントは既に存在しなかったためRecoveryへ記録しました: ' + bookingId);
      } else {
        ui.alert('キャンセルしました: ' + bookingId);
      }
    } else {
      ui.alert('キャンセルできませんでした（' + bookingId + '）: ' + (result.error && result.error.message));
    }
  } catch (e) {
    ui.alert('エラーが発生しました（' + bookingId + '）: ' + (e && e.message));
  }
}

/*
 * 復活導線（Issue #334）。confirm/cancelと対称に、アクティブ行選択とbookingId直接入力の
 * 2通りを用意する。実行直前に必ずYES/NO確認を挟み、NOなら何も変更しない
 * （誤操作防止。confirmBookingにこの確認を追加していないのと同じ整理で、復活は
 * キャンセルと同じく元に戻しにくい操作のため確認を必須にする）。
 */
function reviveActiveRowBooking_() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var activeRange = sheet.getActiveRange();
  if (!activeRange) {
    ui.alert('復活したい予約の行を選択してから実行してください。');
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
  confirmAndRunRevive_(bookingId);
}

function reviveBookingByPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('復活するbookingIdを入力してください', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var bookingId = (response.getResponseText() || '').trim();
  if (!bookingId) {
    ui.alert('bookingIdを入力してください。');
    return;
  }
  confirmAndRunRevive_(bookingId);
}

/* 実行直前の誤操作防止確認。NOならreviveExpiredBooking自体を呼ばない。 */
function confirmAndRunRevive_(bookingId) {
  var ui = SpreadsheetApp.getUi();
  var confirmed = ui.alert(
    '予約 ' + bookingId + ' をEXPIREDからCONFIRMEDへ復活します。\n' +
      '枠の空きを再確認したうえでCalendarへ確定予定を作成し、利用者へ予約確定メールを送信します。\n' +
      'よろしいですか？',
    ui.ButtonSet.YES_NO
  );
  if (confirmed !== ui.Button.YES) return;
  runReviveAndAlert_(bookingId);
}

function runReviveAndAlert_(bookingId) {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = reviveExpiredBooking(bookingId);
    if (result.success) {
      ui.alert('復活しました: ' + bookingId);
    } else {
      ui.alert('復活できませんでした（' + bookingId + '）: ' + (result.error && result.error.message));
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
  REMINDER: function (bookingId, options) { return BookingMailer.sendReminderMailForBooking(bookingId, options); },
  /* Issue #334: カード決済PENDING失効通知の個別再送・手動送信に使う。 */
  EXPIRED: function (bookingId, options) { return BookingMailer.sendExpiredMailForBooking(bookingId, options); }
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
    '再送するメール種別を入力してください（PENDING / CONFIRMED / CANCELLED / REMINDER / EXPIRED）',
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
    ui.alert('未知のメール種別です: ' + mailType + '（PENDING / CONFIRMED / CANCELLED / REMINDER / EXPIREDのいずれかを指定してください）');
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
