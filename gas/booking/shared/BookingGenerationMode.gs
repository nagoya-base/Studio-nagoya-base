/*
 * BookingGenerationMode.gs — SNB / SNB mensの料金世代（V1/V2）判定の一元化（Issue #559）。
 *
 * Issue #548 / PR #551 の「予約作成時刻（サーバー時刻）でV1/V2を分ける」判定（BookingPricing.generationAt。
 * SNB / mensは2026/12/1 0:00 JST）をラップし、本番投入前の11月プレ期間に管理者だけがV2（メールOTP）を試せる
 * TESTモードと、障害時の緊急停止を加える。**新規予約の世代を決める入口はすべてここを通す**（createBooking・
 * 月間空き状況・見積り・会員確認POST。フォームUIが見る priceGeneration も同じ判定）。
 *
 * 優先順位（Issue #559 追補1）:
 *   ① 明示的緊急停止（Script Property BOOKING_AUTH_EMERGENCY_LEGACY が「ENABLED」と完全一致）→ V1
 *   ② 2026/12/1 0:00 JSTより前だけ、モード設定（BOOKING_AUTH_MODE）が効く
 *        TEST … 検証済みテスト資格（BookingTestCredential。Web Appのみ）を持つリクエストだけV2。それ以外はV1
 *        LEGACY … 全員V1（時刻判定と同じ。明示的に「テストもしない」意思を残すための値）
 *   ③ サーバー時刻（BookingPricing.generationAt）。12/1以降はTEST / LEGACYの設定が残っていても必ずLIVE相当（V2）
 * - モード未設定・空値・不正値は LIVE（=現行mainと同じ時刻判定）。設定不備でV1へ倒さない。
 * - TESTの終了期限は BookingPricing.GENERATION_V2_START_MS に固定。Script Propertiesで延長できない。
 * - 対象はSNB / mensの2026/12/1境界だけ。Studio X（2026/10/26）・外部予約・保存済みpriceGenerationを使う既存予約の
 *   変更・再見積りは一切この判定を通さない（変更しない）。
 *
 * Booking Web AppとBooking Adminの両方へ配布する。Adminは**TEST資格を検証しない・署名鍵を持たない**（BookingTestCredential.gsは
 * Web App専用。Adminでは typeof BookingTestCredential === 'undefined' のため資格は常に無効）。Adminの世代判定は
 * 「緊急停止フラグ ＞ サーバー時刻」だけになる。Script Propertiesは両プロジェクトで別のため、緊急停止は両方へ設定する（README参照）。
 *
 * ログ・応答にメールアドレス・資格・鍵・OTPを出さない。
 */
'use strict';

var BookingGenerationMode = (function () {
  var EMERGENCY_PROPERTY = 'BOOKING_AUTH_EMERGENCY_LEGACY';
  var EMERGENCY_VALUE = 'ENABLED';
  var MODE_PROPERTY = 'BOOKING_AUTH_MODE';
  var MODE = { LEGACY: 'LEGACY', TEST: 'TEST', LIVE: 'LIVE' };
  /* 世代の決まり方（監査ログ用の固定識別子）。 */
  var SOURCE = { TIME: 'TIME', EMERGENCY_LEGACY: 'EMERGENCY_LEGACY', TEST_CREDENTIAL: 'TEST_CREDENTIAL' };
  /* テスト資格の扱い。NONE=資格なし／VALID=資格でV2／INVALID=資格を送ったがV2にならない（期限切れ・失効・メール不一致・モード変更・緊急停止等）／
     INACTIVE=資格を送ったが12/1以降（または対象外ブランド）で不要。 */
  var CREDENTIAL = { NONE: 'NONE', VALID: 'VALID', INVALID: 'INVALID', INACTIVE: 'INACTIVE' };

  function readProperty_(name) {
    try {
      var value = PropertiesService.getScriptProperties().getProperty(name);
      return typeof value === 'string' ? value : null;
    } catch (error) {
      return null;
    }
  }

  function isTargetBrand_(brand) {
    return brand === 'snb' || brand === 'mens';
  }

  /* 緊急停止は「ENABLED」の完全一致だけ有効（未設定・空文字・大小文字違い・前後の空白・その他の値は無効）。 */
  function isEmergencyLegacy() {
    return readProperty_(EMERGENCY_PROPERTY) === EMERGENCY_VALUE;
  }

  /* 未設定・空値・不正値はLIVE。TEST / LEGACYは大文字の完全一致だけ有効。 */
  function configuredMode() {
    var value = readProperty_(MODE_PROPERTY);
    return value === MODE.TEST || value === MODE.LEGACY ? value : MODE.LIVE;
  }

  function hasCredential_(context) {
    return !!context && typeof context.testCredential === 'string' && context.testCredential !== '';
  }

  /* Web Appだけが BookingTestCredential を持つ。Adminでは常に false（検証コード・署名鍵が存在しない）。 */
  function credentialValid_(context, now) {
    if (typeof BookingTestCredential === 'undefined') return false;
    try {
      return BookingTestCredential.verify(context.testCredential, context.email, now).ok === true;
    } catch (error) {
      return false;
    }
  }

  /*
   * 新規予約の料金世代を決める。now: サーバー時刻（Date）。brand: 'snb'|'mens'|'studio_x'等。
   * context（Web Appのみ。省略可）: { testCredential, email }。クライアントがモード値・世代値を指定する口は無い。
   * 戻り値: { generation:'V1'|'V2', source, mode, testCredential } — modeはSNB / mens以外ではnull。
   */
  function decide(now, brand, context) {
    var timeGeneration = BookingPricing.generationAt(now, brand);
    if (!isTargetBrand_(brand)) {
      return { generation: timeGeneration, source: SOURCE.TIME, mode: null, testCredential: hasCredential_(context) ? CREDENTIAL.INACTIVE : CREDENTIAL.NONE };
    }
    var mode = configuredMode();
    var supplied = hasCredential_(context);
    if (isEmergencyLegacy()) {
      return {
        generation: BookingPricing.GENERATION.V1,
        source: SOURCE.EMERGENCY_LEGACY,
        mode: mode,
        /* 12/1より前に資格でV2だった入力は、緊急停止でV1へ黙って変わらないよう拒否側（INVALID）に倒す。12/1以降は資格が元々不要。 */
        testCredential: supplied ? (timeGeneration === BookingPricing.GENERATION.V2 ? CREDENTIAL.INACTIVE : CREDENTIAL.INVALID) : CREDENTIAL.NONE
      };
    }
    if (timeGeneration === BookingPricing.GENERATION.V2) {
      /* 12/1 0:00 JST以降はTEST / LEGACYの設定が残っていても通常LIVE（V2）。 */
      return { generation: timeGeneration, source: SOURCE.TIME, mode: mode, testCredential: supplied ? CREDENTIAL.INACTIVE : CREDENTIAL.NONE };
    }
    if (!supplied) {
      return { generation: timeGeneration, source: SOURCE.TIME, mode: mode, testCredential: CREDENTIAL.NONE };
    }
    if (mode === MODE.TEST && credentialValid_(context, now)) {
      return { generation: BookingPricing.GENERATION.V2, source: SOURCE.TEST_CREDENTIAL, mode: mode, testCredential: CREDENTIAL.VALID };
    }
    return { generation: timeGeneration, source: SOURCE.TIME, mode: mode, testCredential: CREDENTIAL.INVALID };
  }

  function generationAt(now, brand, context) {
    return decide(now, brand, context).generation;
  }

  /* 監査用（エディタから実行するshowBookingAuthModeStatusが使う）。機密情報を含まない。 */
  function describe(now) {
    var at = now && typeof now.getTime === 'function' && !isNaN(now.getTime()) ? now : new Date();
    return {
      mode: configuredMode(),
      emergencyLegacy: isEmergencyLegacy(),
      testDeadline: new Date(BookingPricing.GENERATION_V2_START_MS).toISOString(),
      beforeSwitch: at.getTime() < BookingPricing.GENERATION_V2_START_MS,
      credentialVerifierPresent: typeof BookingTestCredential !== 'undefined',
      generalUser: {
        snb: decide(at, 'snb').generation,
        mens: decide(at, 'mens').generation,
        studio_x: decide(at, 'studio_x').generation
      }
    };
  }

  return {
    EMERGENCY_PROPERTY: EMERGENCY_PROPERTY,
    MODE_PROPERTY: MODE_PROPERTY,
    MODE: MODE,
    SOURCE: SOURCE,
    CREDENTIAL: CREDENTIAL,
    isEmergencyLegacy: isEmergencyLegacy,
    configuredMode: configuredMode,
    decide: decide,
    generationAt: generationAt,
    describe: describe
  };
})();

/*
 * GASエディタから権限者が手動実行する確認関数（Web App・Booking Adminの両プロジェクトで実行して設定を確認する）。
 * 現在のモード・緊急停止フラグ・切替期限（TESTの終了＝LIVE移行時刻）・一般利用者に対する各ブランドの世代を監査ログへ出す。機密情報は含まない。
 * doGet / doPostからは呼ばない。
 */
function showBookingAuthModeStatus() {
  var status = BookingGenerationMode.describe(new Date());
  Logger.log('BookingGenerationMode: ' + JSON.stringify(status));
  return status;
}
