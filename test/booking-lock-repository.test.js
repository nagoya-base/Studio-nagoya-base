/*
 * BookingLockRepository.gs の単体テスト（Issue #341 PR-Cレビュー対応・2回目で新設、
 * 3回目でチケット行の取り違え・TTL経過後の古い保持者による書き込みという2件の実装
 * バグを修正した際に追加・更新）。
 *
 * このロックは、独立したBooking Webhook・Booking Adminの両プロジェクトが共有する
 * Bookings台帳と同じSpreadsheet上の「BookingLocks」シートへのappendRow＋直後の全件
 * 読み直しで実現する（BookingLockRepository.gs冒頭コメント参照。ただしこのファイル自体が
 * 「Sheetsのappend順序整列は公式に保証された契約ではない」と明記しているとおり、
 * ここでの検証はあくまでこの実装がその想定どおりに動くことの確認であり、Sheets自体の
 * 契約を証明するものではない）。
 *
 * 3回目レビュー対応で特に追加したテスト:
 * - 「同時に2件がappendする」ケースを、sheet.appendRowを実際に差し替えて割り込ませる
 *   ことで再現する（acquireの内部で自分がappendした直後・読み直す前に、別の実行が
 *   本当にappendする状況）。
 * - 異なるGASプロジェクト（別々のBookingLockRepositoryモジュールインスタンス）からの
 *   並行取得を、上記と同じ割り込み手法で再現する。
 * - TTL経過後、古い保持者自身がisHeldでfalseと判定されること（他者が再取得している・
 *   いない、いずれの場合も）。
 * - release時のholderId不一致・二重解放・存在しない行番号の扱い。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = ['Config.gs', 'BookingLockRepository.gs'];
var SPREADSHEET_ID = 'ss1';

function makeGlobals(spreadsheetsById) {
  return {
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    Utilities: stubs.createUtilitiesStub(),
    Logger: stubs.createLoggerStub(),
    PropertiesService: stubs.createPropertiesServiceStub({
      SPREADSHEET_ID: SPREADSHEET_ID,
      CALENDAR_ID: 'cal1'
    })
  };
}

function setup() {
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var sandbox = loadBookingSandbox(FILES, makeGlobals(spreadsheetsById));
  return { sandbox: sandbox, spreadsheetsById: spreadsheetsById };
}

test('acquire: 誰も保持していないbookingIdは即座に取得できる', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var result = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'webhook', now);
  assert.strictEqual(result.acquired, true);
  assert.strictEqual(typeof result.rowNumber, 'number');
  assert.strictEqual(result.holderId, 'holder-A');
});

test('acquire: 有効な他者のチケットが存在する間は取得できない（別プロジェクトからの競合を模擬）', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-admin', 'admin-expire', now);
  assert.strictEqual(first.acquired, true);

  var second = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-webhook', 'webhook', now);
  assert.strictEqual(second.acquired, false, '既に有効なチケットを持つ別のholderがいる間は取得できてはならない');
});

test('acquire: 無関係な別のbookingIdには影響しない', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now);
  assert.strictEqual(first.acquired, true);

  var other = ctx.sandbox.BookingLockRepository.acquire('bk-2', 'holder-B', 'webhook', now);
  assert.strictEqual(other.acquired, true, '別のbookingIdは無関係に取得できる必要がある');
});

test('release後は同じbookingIdを別のholderが取得できる', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now);
  assert.strictEqual(first.acquired, true);

  var blocked = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-B', 'webhook', now);
  assert.strictEqual(blocked.acquired, false);

  ctx.sandbox.BookingLockRepository.release(first.rowNumber, first.holderId, now);

  var afterRelease = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-C', 'webhook', now);
  assert.strictEqual(afterRelease.acquired, true, 'releaseされた後は新しいholderが取得できる必要がある');
});

test('取得に失敗したholder自身のチケットは自動的に解放され、後続の取得を無用にブロックしない', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now);
  assert.strictEqual(first.acquired, true);

  var blocked = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-B', 'webhook', now);
  assert.strictEqual(blocked.acquired, false);

  /* holder-Aが解放すれば、blockedになったholder-B自身の失敗チケットが残っていても
     新しいholder-Cは正しく取得できる（失敗したholder-Bのチケットが誤ってholder-Cを
     ブロックしないことを確認する）。 */
  ctx.sandbox.BookingLockRepository.release(first.rowNumber, first.holderId, now);
  var third = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-C', 'webhook', now);
  assert.strictEqual(third.acquired, true);
});

test('TTL経過後は解放されていないチケットも自動的に失効し、他のholderが取得できる（クラッシュ復旧）', function () {
  var ctx = setup();
  var acquiredAt = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', acquiredAt, 1000);
  assert.strictEqual(first.acquired, true);

  var stillWithinTtl = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-B', 'webhook', new Date(acquiredAt.getTime() + 500));
  assert.strictEqual(stillWithinTtl.acquired, false, 'TTL内はholder-Aのチケットがまだ有効なため取得できてはならない');

  var afterTtl = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-C', 'webhook', new Date(acquiredAt.getTime() + 1500));
  assert.strictEqual(afterTtl.acquired, true, 'TTL経過後はholder-Aが解放していなくても取得できる必要がある（クラッシュ復旧）');
});

test('acquire: bookingId未指定は例外を投げる', function () {
  var ctx = setup();
  assert.throws(function () {
    ctx.sandbox.BookingLockRepository.acquire('', 'holder-A', 'webhook', new Date());
  });
});

test('acquire: holderId未指定は例外を投げる', function () {
  var ctx = setup();
  assert.throws(function () {
    ctx.sandbox.BookingLockRepository.acquire('bk-1', '', 'webhook', new Date());
  });
});

/*
 * ============================================================================
 * 3回目レビュー対応・項目1: チケット行の取り違え
 *
 * sheet.appendRowの直後にsheet.getLastRow()を呼ぶ旧実装は、並行実行が別の行を追加して
 * いれば自分の行番号を取得できなかった。修正後はholderIdで自分の行を検索するため、
 * 以下のテストは実際にappendRowへ割り込ませて自分の行が別の行と取り違えられないことを
 * 検証する。sheet.appendRow自体を差し替え、「自分がappendした直後・読み直す前に、
 * 別の実行が本当にappendする」という状況を再現する（同期的なテストランナーでは真の
 * 並行実行を起こせないため、この割り込みによって同じ結果を再現する）。
 * ============================================================================
 */

test('acquire: 自分のappendRowの直後・読み直し前に別の実行が本当に割り込んでappendしても、自分の行を正しく識別する（同時に2件がappendするケースの再現）', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');

  /* シートを実際に作成させておく（ensureSheet_を経由させるため）。 */
  var warmup = ctx.sandbox.BookingLockRepository.acquire('bk-warmup', 'warmup-holder', 'test', now);
  ctx.sandbox.BookingLockRepository.release(warmup.rowNumber, warmup.holderId, now);

  var sheet = ctx.sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('BookingLocks');
  var originalAppendRow = sheet.appendRow;
  var injected = false;
  /*
   * holder-Aのacquire内部でappendRowが呼ばれた瞬間（＝holder-Aが自分の行を追加した
   * まさにその直後、holder-Aがまだ読み直していない間）に、別の実行（holder-B）が
   * 本当にappendする状況を再現する。
   */
  sheet.appendRow = function (row) {
    originalAppendRow.call(sheet, row);
    if (!injected && row[0] === 'bk-race') {
      injected = true;
      originalAppendRow.call(sheet, ['bk-race', 'holder-B-interloper', 'webhook', now, new Date(now.getTime() + 60000), '']);
    }
  };

  var resultA = ctx.sandbox.BookingLockRepository.acquire('bk-race', 'holder-A', 'admin-expire', now);

  /*
   * holder-Aは自分より先にappendされているため取得できるはずだが、旧実装
   * （sheet.getLastRow()を「自分の行番号」とみなす）であれば、割り込んだholder-B-
   * interloperの行番号を誤って自分の行だと思い込んでいた（getLastRow()はholder-B-
   * interloperのappend後に呼ばれるため）。修正後はholderIdで検索するため、返された
   * rowNumberが実際にholder-A自身の行を指していることを直接検証する。
   */
  assert.strictEqual(resultA.acquired, true, 'holder-Aが先にappendしたため取得できるはず');
  var sheetValues = sheet.getDataRange().getValues();
  var myRow = sheetValues[resultA.rowNumber - 1];
  assert.strictEqual(myRow[1], 'holder-A', 'acquireが返したrowNumberは、割り込みが発生しても必ずholder-A自身の行を指さなければならない（取り違えの再現・回帰テスト）');

  /* 割り込んだholder-B-interloperは、holder-Aより後に追加されたチケットを持つ別の
     試行として、改めて取得を試みても失敗する（holder-Aが取得中のため）。 */
  var resultBRetry = ctx.sandbox.BookingLockRepository.acquire('bk-race', 'holder-B-retry', 'webhook', now);
  assert.strictEqual(resultBRetry.acquired, false);
});

test('acquire: 異なるGASプロジェクト（別々のBookingLockRepositoryモジュールインスタンス）からの並行取得でも、自分のチケットを正しく識別し取り違えない', function () {
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var admin = loadBookingSandbox(FILES, makeGlobals(spreadsheetsById));
  var webhook = loadBookingSandbox(FILES, makeGlobals(spreadsheetsById));

  var now = new Date('2026-10-01T10:00:00+09:00');
  var warmup = admin.BookingLockRepository.acquire('bk-warmup', 'warmup-holder', 'admin-expire', now);
  admin.BookingLockRepository.release(warmup.rowNumber, warmup.holderId, now);

  /* adminサンドボックスから見えるシートオブジェクトは、webhookサンドボックスとも
     同じspreadsheetsById参照を共有しているため同一の裏側データを指す
     （setupCompetitionPairと同じ、実際のアーキテクチャの再現）。 */
  var sheet = admin.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('BookingLocks');
  var originalAppendRow = sheet.appendRow;
  var injected = false;
  sheet.appendRow = function (row) {
    originalAppendRow.call(sheet, row);
    if (!injected && row[0] === 'bk-cross-project') {
      injected = true;
      /* Booking Adminがappendした直後・読み直す前に、独立したBooking Webhook
         プロジェクトが本当に割り込んでこの予約のロックを取得しようとする。 */
      webhook.BookingLockRepository.acquire('bk-cross-project', 'holder-webhook', 'webhook', now);
    }
  };

  var resultAdmin = admin.BookingLockRepository.acquire('bk-cross-project', 'holder-admin', 'admin-expire', now);
  assert.strictEqual(resultAdmin.acquired, true, 'Booking Admin側が先にappendしたため取得できるはず');

  var values = sheet.getDataRange().getValues();
  var adminRow = values[resultAdmin.rowNumber - 1];
  assert.strictEqual(adminRow[1], 'holder-admin', 'Admin側のrowNumberは自分自身の行を指さなければならない');

  var webhookRow = values.filter(function (r) { return r[1] === 'holder-webhook'; })[0];
  assert.ok(webhookRow, 'webhook側のチケット行が見つかるはず');
  assert.ok(webhookRow[5], 'webhook側は取得に失敗し、自分のチケットを自動的に解放しているはず（releasedAtが設定されている）');
});

/*
 * ============================================================================
 * 3回目レビュー対応・項目2: ロック期限切れ中の書き込み
 *
 * isHeldは、実際に破壊的な書き込みを行う直前に呼び出し元が必ず再検証すべきAPIである。
 * TTL経過後は、たとえ元の保持者が解放していなくても（＝クラッシュ・異常終了していても、
 * あるいは単に処理が長引いているだけでも）、isHeldはfalseを返し、それ以上の書き込みを
 * 防がなければならない。
 * ============================================================================
 */

test('isHeld: TTL内は有効、TTL経過後は元の保持者自身に対してもfalseを返す', function () {
  var ctx = setup();
  var acquiredAt = new Date('2026-10-01T10:00:00+09:00');
  var result = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', acquiredAt, 1000);
  assert.strictEqual(result.acquired, true);

  assert.strictEqual(
    ctx.sandbox.BookingLockRepository.isHeld(result.rowNumber, 'holder-A', new Date(acquiredAt.getTime() + 500)),
    true,
    'TTL内は元の保持者もまだ有効と判定されるはず'
  );
  assert.strictEqual(
    ctx.sandbox.BookingLockRepository.isHeld(result.rowNumber, 'holder-A', new Date(acquiredAt.getTime() + 1500)),
    false,
    'TTL経過後は元の保持者であってもfalseを返し、それ以降の書き込みを許可してはならない（古い保持者による遅延書き込みの防止）'
  );
});

test('isHeld: TTL経過後に別のholderが正当に取得していても、古い保持者はisHeldでfalseのまま（古い保持者による遅延書き込みの防止）', function () {
  var ctx = setup();
  var acquiredAt = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', acquiredAt, 1000);
  assert.strictEqual(first.acquired, true);

  var afterTtl = new Date(acquiredAt.getTime() + 1500);
  var second = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-B', 'webhook', afterTtl);
  assert.strictEqual(second.acquired, true, 'TTL経過後は別のholderが正当に取得できる');

  /* holder-A（古い保持者）が、TTL切れに気づかずCalendar/Bookingsへの書き込みを続けよう
     としても、isHeldはfalseを返しその書き込みを防ぐ。呼び出し元（StripeWebhookHandler.gs・
     BookingRepository.gs）はこの戻り値を実際の書き込み直前に必ず確認する契約になっている。 */
  assert.strictEqual(
    ctx.sandbox.BookingLockRepository.isHeld(first.rowNumber, 'holder-A', afterTtl),
    false
  );
  assert.strictEqual(
    ctx.sandbox.BookingLockRepository.isHeld(second.rowNumber, 'holder-B', afterTtl),
    true
  );
});

test('isHeld: 解放済みの行はholderIdが一致してもfalseを返す', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var result = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now);
  ctx.sandbox.BookingLockRepository.release(result.rowNumber, result.holderId, now);

  assert.strictEqual(ctx.sandbox.BookingLockRepository.isHeld(result.rowNumber, 'holder-A', now), false);
});

/*
 * ============================================================================
 * 3回目レビュー対応: 解放処理の競合
 * ============================================================================
 */

test('release: 誤ったholderIdでの解放は例外を投げ、他者のチケットを解放しない', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var result = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now);
  assert.strictEqual(result.acquired, true);

  assert.throws(function () {
    ctx.sandbox.BookingLockRepository.release(result.rowNumber, 'holder-B-wrong', now);
  }, /holderId/);

  /* holder-Aのチケットは誤って解放されておらず、まだ有効なまま。 */
  assert.strictEqual(ctx.sandbox.BookingLockRepository.isHeld(result.rowNumber, 'holder-A', now), true);
});

test('release: 同じholderIdでの二重呼び出しは冪等（例外を投げない）', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var result = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now);
  ctx.sandbox.BookingLockRepository.release(result.rowNumber, 'holder-A', now);
  assert.doesNotThrow(function () {
    ctx.sandbox.BookingLockRepository.release(result.rowNumber, 'holder-A', now);
  });
});

test('release: 存在しない行番号の解放は例外を投げる', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now); /* シートを作成させる */
  assert.throws(function () {
    ctx.sandbox.BookingLockRepository.release(9999, 'holder-A', now);
  });
});
