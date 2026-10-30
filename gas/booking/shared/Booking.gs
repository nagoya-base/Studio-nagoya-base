/*
 * Booking.gs — createBooking（Issue #268）の予約状態・入力検証・bookingId・TTLに関する
 * 純粋なロジック本体。CalendarApp / PropertiesService / LockService等のGAS組み込み
 * サービスには一切依存せず、vmでそのまま実行してテストできる（Availability.gsと同方針）。
 *
 * ここではBookingAvailability（同じくGASサービス非依存）の時刻ユーティリティのみを使う。
 * GAS実行時は全.gsファイルが同一グローバルスコープにコンパイルされるため、
 * Availability.gsを先に読み込む前提で参照できる（Code.gs等の既存の依存順と同じ）。
 *
 * 固定仕様（Issue #268/#269。実装中に変更しない）:
 * - 予約状態は PENDING / CONFIRMED / CANCELLED / EXPIRED の4つ
 * - 利用者からの送信は必ずPENDING（送信即CONFIRMEDは禁止）
 * - 予約作成を許可するbrandは snb / mens / studio_x の3つ（Issue #269でstudio_x限定から
 *   拡張。3ブランドとも同一室・同一Calendarのため、空き判定ロジックはbrandで分岐させない。
 *   ブランド一覧・bookingId prefix・表示名はいずれも運用値ではなく仕様であるため、
 *   Script Propertiesではなくこの定数で一元管理する。他ファイル（CalendarRepository.gs /
 *   AdminNotifier.gs等）はbrand文字列やラベルを直接持たず、必ずBooking.getBrandLabel等
 *   ここの定義を経由する）
 *
 * Issue #270で追加した当日利用ルール:
 * - 「会員かどうか」ではなく「利用区分（customerType。初回利用/利用経験あり）」で
 *   当日予約可否を判定する。CUSTOMER_TYPES/isAllowedCustomerType参照。
 * - 当日判定は必ずavailabilityConfig.timezone（既定Asia/Tokyo）基準で行い、
 *   ブラウザのローカルtimezoneには依存しない（formatDateInTimezone参照。実体は
 *   BookingAvailability.formatDateInTimezone）。
 * - Issue #407: 初回利用の当日予約を解禁した。代わりに初回利用の支払方法はオンライン
 *   クレジットカード決済のみとし、サーバー側で検証する（FIRST_TIME_CARD_PAYMENT_REQUIRED）。
 * - 当日（isSameDayBooking）は、開始時刻が現在時刻より後であることも必須とする
 *   （レビュー対応で追加。SAME_DAY_START_TIME_PASSED。現在時刻の判定は
 *   BookingAvailability.getCurrentMinutesInTimezoneを使う）。
 * - brandでこのルールを分岐させない（snb/mens/studio_xは同一施設という前提はIssue #269と同じ）。
 */
'use strict';

var Booking = (function () {
  var STATUS = {
    PENDING: 'PENDING',
    CONFIRMED: 'CONFIRMED',
    CANCELLED: 'CANCELLED',
    EXPIRED: 'EXPIRED'
  };

  /*
   * 決済状態（Issue #341。既存paymentStatus列を転用）。予約状態（STATUS）とは完全に
   * 独立したフィールドであり、互いを直接書き換えない（Issue #341本文「決済の成功・失敗・
   * 返金が既存予約の状態を不正に変更しない構造にする」）。実際にこの状態機械を遷移させる
   * のはカード決済のみ。現金・PayPayの予約は作成時のNOT_STARTEDのまま変化しない
   * （現地払いは従来どおりstatus側のconfirmBooking/cancelBookingAdminのみで管理し、
   * この状態機械には一切関与しない）。
   *
   * - NOT_STARTED: 決済フロー未着手（現金・PayPayは常にこのまま。カードもCheckout
   *   Session発行前はこの状態）。
   * - CHECKOUT_PENDING: Stripe Checkout Sessionを発行済み・決済結果待ち（PR-B）。
   * - PAID: 署名検証済みWebhookでStripeの決済成功を確認済み（PR-C）。
   * - REFUND_PENDING: 返金APIを呼び出し済み・完了確認待ち。Issue #341本文「枠解放と
   *   Calendar/台帳のCANCELLED更新は返金APIの成功を待たずに行う」ため、予約側のstatus
   *   更新とこの遷移は非同期に進み得る（PR-D）。
   * - REFUNDED: 返金完了を確認済み（終端状態）。
   * - FAILED: 決済が成立しなかった（カード拒否・Checkout Session期限切れ等）。新しい
   *   paymentAttemptIdでの再試行時のみCHECKOUT_PENDINGへ戻れる。
   *
   * 旧定義（Issue #314で追加。Issue #334時点では'unpaid'固定のまま未使用で、'paid'は
   * どこからも書き込まれていなかった。BookingRepository.gs/SpreadsheetRepository.gs
   * ともに現状の書き込み・参照箇所はcreateBooking内の1箇所のみとPR-A調査で確認済み）
   * から値を差し替える。既存本番行はすべて'unpaid'のまま保存されているため、
   * 読み取り側は必ずnormalizePaymentStatus経由で正規化すること（このファイルを直接
   * 経由しない古いコードが万一'unpaid'/'paid'をそのまま比較しても、'paid'の文字列表現は
   * 新定義のPAIDと一致するため実害はない）。
   */
  var PAYMENT_STATUS = {
    NOT_STARTED: 'not_started',
    CHECKOUT_PENDING: 'checkout_pending',
    PAID: 'paid',
    REFUND_PENDING: 'refund_pending',
    REFUNDED: 'refunded',
    FAILED: 'failed'
  };

  /* Issue #314〜Issue #334時点でBookings台帳に実際に書き込まれていた固定値。
     normalizePaymentStatusの後方互換分岐でのみ参照する（新規コードはこの値を書き込まない）。 */
  var LEGACY_PAYMENT_STATUS_UNPAID_ = 'unpaid';

  /*
   * Bookings台帳から読み取ったpaymentStatusの生値を正規化する。
   *
   * - 既に上記PAYMENT_STATUSのいずれかの値であれば、そのまま返す（旧'paid'は実際に
   *   書き込まれた実績はないが、新定義のPAIDと文字列表現が一致するためこの分岐で
   *   自然に通る）。
   * - 空文字・null・undefined・旧'unpaid'（Issue #314〜#334時点の固定値。既存本番行は
   *   全てこれ）は後方互換のためNOT_STARTEDへ正規化する。
   * - **上記のいずれにも一致しない値（未知の文字列・型）はnullを返す。**
   *   Issue #341 PR-Aレビュー対応：「読み取れない値だから決済フロー未着手だろう」と
   *   決めつけてNOT_STARTEDへ丸めると、実際には決済処理の途中で想定外の値が書き込まれた
   *   （バグ・手動編集・複合障害等）可能性を握りつぶしてしまい、二重決済や誤った自動確定
   *   につながりかねない。空欄・既知の旧値と、正体不明の値を同じ既定値へ丸めないのが
   *   この関数の主眼であり、呼び出し側（特にBookingRepository.applyPaymentStateUpdate等の
   *   決済処理系）はnullを検知したら必ず処理を停止し、要復旧として扱うこと。
   */
  function normalizePaymentStatus(rawValue) {
    var known = [
      PAYMENT_STATUS.NOT_STARTED, PAYMENT_STATUS.CHECKOUT_PENDING, PAYMENT_STATUS.PAID,
      PAYMENT_STATUS.REFUND_PENDING, PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.FAILED
    ];
    if (known.indexOf(rawValue) !== -1) return rawValue;
    if (rawValue === '' || rawValue === null || rawValue === undefined || rawValue === LEGACY_PAYMENT_STATUS_UNPAID_) {
      return PAYMENT_STATUS.NOT_STARTED;
    }
    return null;
  }

  /*
   * PAYMENT_STATUSの許可された遷移（Issue #341）。STATUSのALLOWED_TRANSITIONS/
   * canTransitionと同じ設計方針を踏襲する：この表は「制度として存在する遷移」の一覧で
   * あり、実際にどの関数がその遷移を実行してよいかは呼び出し側（PR-B/C/D）が個別に
   * 絞り込む。返金失敗はこの表では遷移として表現しない（REFUND_PENDINGに留まり続ける
   * ことが「未解決」を表し、失敗の記録は専用のエラー列で行う想定。confirmBookingの
   * EXPIRED拒否ガードと同じく、表がその遷移を許すことと、ある関数が実際にそれを実行する
   * ことは別問題として扱う）。
   *
   * キーはPAYMENT_STATUSの識別子名ではなく**値**（'not_started'等）にすること。
   * STATUS/ALLOWED_TRANSITIONSは値と識別子名がどちらも同じ大文字表記だったため
   * この違いが問題にならなかったが、PAYMENT_STATUSは値がsnake_caseのため、裸の
   * 識別子（NOT_STARTED:等）で書くとcanTransitionPaymentStatusの引数（実際の値
   * 'not_started'等）と一致せずルックアップが常に失敗する。計算されたプロパティ名
   * （[PAYMENT_STATUS.NOT_STARTED]:のように角括弧で値を明示）で定義する。
   *
   * NOT_STARTED→FAILED（Issue #341 PR-Bで判明し追加）: Stripe Checkout Session
   * 作成そのものがStripe側に明確に拒否された場合（不正なリクエスト等。CHECKOUT_PENDING
   * へは一度も到達していない）に必要な遷移。この場合でも、次回の決済試行が同じ
   * Idempotency-Key（paymentAttemptId）を無条件に再利用し続けて同じエラーを繰り返さない
   * よう、FAILEDへ進めて新しい決済試行IDの発行を可能にする
   * （BookingRepository.reservePaymentAttempt_参照）。
   *
   * FAILED→PAID（Issue #341 PR-Cレビュー対応・1回目で追加）: 仮押さえ失効
   * （expirePendingBookings）や確定的なStripeエラーでいったんFAILEDへ進めた直後に、
   * 実際には（例えば失効判定の直前に）決済が成立していたとStripe側の照会・Webhookで
   * 判明する場合がある。expirePendingBookingsとWebhook処理（Booking Webhookプロジェクト）は
   * 別々のGASプロジェクト・別々のLockServiceで動くため、「絶対にこの順序では起きない」とは
   * 言い切れない（README「Webhookと失効処理の競合（再設計）」参照）。この遷移が無いと、
   * 実際には入金が完了しているにもかかわらずpaymentStatusをpaidへ更新する手段が無く、
   * 「入金済みの事実を記録できない」という事故になる。FAILED→PAIDはあくまで
   * paymentStatus列のみを更新するものであり、予約の`status`（EXPIRED等）には一切影響
   * しない。実際にこの遷移を使う場合は、予約の自動確定（confirmBooking）を許可する
   * ものではなく、`status`が確定に適さない状態（EXPIRED/CANCELLED等）であれば
   * confirmBooking自身がそれを拒否し、Recoveryへの記録・運営者の確認へつなげる
   * （StripeWebhookHandler.gs参照）。
   */
  var PAYMENT_STATUS_TRANSITIONS_ = {};
  PAYMENT_STATUS_TRANSITIONS_[PAYMENT_STATUS.NOT_STARTED] = [PAYMENT_STATUS.CHECKOUT_PENDING, PAYMENT_STATUS.FAILED];
  PAYMENT_STATUS_TRANSITIONS_[PAYMENT_STATUS.CHECKOUT_PENDING] = [PAYMENT_STATUS.PAID, PAYMENT_STATUS.FAILED];
  PAYMENT_STATUS_TRANSITIONS_[PAYMENT_STATUS.FAILED] = [PAYMENT_STATUS.CHECKOUT_PENDING, PAYMENT_STATUS.PAID];
  PAYMENT_STATUS_TRANSITIONS_[PAYMENT_STATUS.PAID] = [PAYMENT_STATUS.REFUND_PENDING];
  PAYMENT_STATUS_TRANSITIONS_[PAYMENT_STATUS.REFUND_PENDING] = [PAYMENT_STATUS.REFUNDED];
  PAYMENT_STATUS_TRANSITIONS_[PAYMENT_STATUS.REFUNDED] = [];

  function canTransitionPaymentStatus(fromPaymentStatus, toPaymentStatus) {
    var allowedTargets = PAYMENT_STATUS_TRANSITIONS_[fromPaymentStatus];
    return !!allowedTargets && allowedTargets.indexOf(toPaymentStatus) !== -1;
  }

  /* 予約作成できるbrandはこの3つのみ（Issue #269）。brand偽装で未知のbrandから
     予約を作れないよう、フロントの表示に関わらずサーバー側でこの一覧のみ許可する。 */
  var ALLOWED_BOOKING_BRANDS = ['snb', 'mens', 'studio_x'];

  /*
   * 利用区分（Issue #270）。「会員かどうか」ではなく、SNB / SNB mens / Studio X という
   * 同一施設を過去に利用した経験があるかどうかで当日予約可否を判定する。
   * brandをまたいで自己申告する値であり、DB照合はしない（Issue #270本文の非対象）。
   * 表示文言と内部値を混同しないよう、内部値はfirst_time/returningの2値のみで固定する
   * （既存にこの区分の正式名称が無かったため、Issue #270本文の例示どおり採用した）。
   */
  var CUSTOMER_TYPES = { FIRST_TIME: 'first_time', RETURNING: 'returning' };
  var ALLOWED_CUSTOMER_TYPES = [CUSTOMER_TYPES.FIRST_TIME, CUSTOMER_TYPES.RETURNING];

  /* Sheets台帳・管理者向け表示にのみ使う。判定ロジックはCUSTOMER_TYPESの内部値のみで行う。 */
  var CUSTOMER_TYPE_LABELS_ = { first_time: '初回利用', returning: '利用経験あり' };

  function isAllowedCustomerType(value) {
    return ALLOWED_CUSTOMER_TYPES.indexOf(value) !== -1;
  }

  function getCustomerTypeLabel(value) {
    return CUSTOMER_TYPE_LABELS_[value] || String(value || '');
  }

  /* bookingIdの接頭辞。studio_xの'SX'はIssue #268から変更しない
     （既発行のbookingId・運用ドキュメントとの整合のため）。 */
  var BRAND_ID_PREFIX_ = { snb: 'SNB', mens: 'MENS', studio_x: 'SX' };

  /*
   * カード決済まわりの固定仕様値（Issue #334）。Script Propertiesではなくこの定数で
   * 一元管理する（Issue #334本文「Script Propertiesは変更しない」「しきい値は定数1か所で
   * 管理する」に従う）。
   * - PAYMENT_METHOD_CARD: 予約フォームのpaymentMethod値と一致させる唯一の正
   *   （_includes/booking_app_ja.htmlのvalue="オンラインクレジットカード"と一致させること）。
   * - CARD_TTL_HOURS: カード予約のみに適用するPENDING TTL（受付から72時間）。
   *   現金/PayPay/未定の基本TTL（Script PropertiesのPENDING_TTL_HOURS。既定24時間）は
   *   このIssueでは変更しない。
   * （旧CARD_MIN_HOURS_BEFORE_STARTによるカード96時間受付制限はIssue #407で撤廃した）
   */
  var PAYMENT_METHOD_CARD = 'オンラインクレジットカード';
  var CARD_TTL_HOURS = 72;

  function isCardPaymentMethod(paymentMethod) {
    return String(paymentMethod || '').trim() === PAYMENT_METHOD_CARD;
  }

  /*
   * Stripe決済リンクURLの検証（Issue #334 PR-C）。GASには`URL`クラスがないため、
   * 正規表現による厳密な完全一致（`^...$`）で判定する。email検証（EMAIL_PATTERN_）と
   * 同じ方針で、前後の空白・クエリ・フラグメント・ポート・userinfo・他ホストは
   * 一切許可しない。呼び出し側（BookingMailer.sendPaymentLinkMailForBooking）は
   * email検証と同じく、渡された値をtrimせずそのままここへ通す（trimしてから緩く
   * 検証すると、前後に空白を含む入力を誤って受理してしまうため）。
   */
  var STRIPE_PAYMENT_LINK_URL_PATTERN_ = /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_-]+$/;

  function isValidStripePaymentLinkUrl(url) {
    return typeof url === 'string' && STRIPE_PAYMENT_LINK_URL_PATTERN_.test(url);
  }

  /* Calendarタイトル・管理者通知メール等、人が読む表示にのみ使うブランド名。
     空き判定・状態判定のロジックはこのラベルに一切依存しない。 */
  var BRAND_LABELS_ = { snb: 'SNB', mens: 'SNB mens', studio_x: 'Studio X' };

  function getBrandLabel(brand) {
    return BRAND_LABELS_[brand] || String(brand || '');
  }

  /*
   * ブランド（導線）別の案内設定（Issue #422）。SNB / SNB mens / Studio Xの案内メール・
   * Stripe Checkoutの戻り先を分離するための唯一の定義。予約日時・料金・予約ID等の共通情報は
   * 各テンプレートで共通ロジックのまま、ここにはブランド固有の「表示名・案内先URL・署名・
   * 注意事項・戻り先パス」だけを持つ。
   * - brand判定は既存予約データのbrand列（snb / mens / studio_x）を正とする。mensを
   *   SNBへ丸めない。brandが空・未知の過去データはSNBとして扱う（後方互換）。
   * - Studio Xの文面にはSNB・緊縛向けの表現やリンクを一切含めない。
   * - successPath / cancelPathはサイトルートからの相対パス。実際のURLは
   *   resolveCheckoutReturnUrlsがScript Properties由来のSNB用URLから導出する。
   */
  var SITE_BASE_URL_ = 'https://nagoya-base.github.io/Studio-nagoya-base';
  var BRAND_PROFILES_ = {
    snb: {
      key: 'snb',
      signature: 'Studio Nagoya Base',
      siteUrl: SITE_BASE_URL_ + '/',
      bookingUrl: SITE_BASE_URL_ + '/booking/',
      guideUrl: SITE_BASE_URL_ + '/how-to/',
      pathPrefix: '',
      notes: []
    },
    mens: {
      key: 'mens',
      signature: 'SNB mens（Studio Nagoya Base）',
      siteUrl: SITE_BASE_URL_ + '/mens/',
      bookingUrl: SITE_BASE_URL_ + '/mens/booking/',
      guideUrl: SITE_BASE_URL_ + '/mens/how-to/',
      pathPrefix: '/mens',
      notes: []
    },
    studio_x: {
      key: 'studio_x',
      signature: 'Studio X',
      siteUrl: SITE_BASE_URL_ + '/studio-x/',
      bookingUrl: SITE_BASE_URL_ + '/studio-x/booking/',
      guideUrl: SITE_BASE_URL_ + '/studio-x/how-to/',
      pathPrefix: '/studio-x',
      notes: []
    }
  };

  function getBrandProfile(brand) {
    return BRAND_PROFILES_[brand] || BRAND_PROFILES_.snb;
  }

  /* SNB用の戻り先URL（既存のScript Properties値）の末尾パスを、ブランド別パスへ差し替える。
     クエリ・フラグメント（例: ?session_id={CHECKOUT_SESSION_ID}）は保持する。
     末尾パスが想定と異なり導出できない場合はnullを返す。 */
  function swapBrandPath_(url, snbSuffix, prefix) {
    var match = /^([^?#]*)([?#].*)?$/.exec(String(url || ''));
    if (!match) return null;
    var path = match[1];
    if (path.length < snbSuffix.length || path.slice(-snbSuffix.length) !== snbSuffix) return null;
    return path.slice(0, path.length - snbSuffix.length) + prefix + snbSuffix + (match[2] || '');
  }

  /*
   * Stripe Checkoutのsuccess_url / cancel_urlをブランド別に解決する（Issue #422）。
   * - snb（brand空・未知の過去データを含む）: 既存のSTRIPE_CHECKOUT_SUCCESS_URL / CANCEL_URLをそのまま使う。
   * - mens / studio_x: ブランド別Script Property（stripeConfig.successUrls / cancelUrls[brand]）→
   *   なければSNB用URLの末尾'/booking/payment-complete.html' / '/booking/'をブランド別パスへ
   *   差し替えて導出。導出できない場合はSNB用URLへ黙ってフォールバックせず、ok:falseを返す
   *   （呼び出し側は設定不足としてCheckout生成前にfail-closedにする。ブランド混在の防止）。
   * 決済の成立条件・金額・有効期限には一切関与しない（戻り先URLのみ）。
   */
  var SUCCESS_PATH_SUFFIX_ = '/booking/payment-complete.html';
  var CANCEL_PATH_SUFFIX_ = '/booking/';

  function resolveCheckoutReturnUrls(brand, stripeConfig) {
    var config = stripeConfig || {};
    var profile = getBrandProfile(brand);
    var successUrl = config.successUrl || '';
    var cancelUrl = config.cancelUrl || '';
    if (profile.key !== 'snb') {
      var successOverride = config.successUrls && config.successUrls[profile.key];
      var cancelOverride = config.cancelUrls && config.cancelUrls[profile.key];
      successUrl = successOverride || swapBrandPath_(successUrl, SUCCESS_PATH_SUFFIX_, profile.pathPrefix) || '';
      cancelUrl = cancelOverride || swapBrandPath_(cancelUrl, CANCEL_PATH_SUFFIX_, profile.pathPrefix) || '';
    }
    return { ok: !!successUrl && !!cancelUrl, successUrl: successUrl, cancelUrl: cancelUrl };
  }

  /*
   * SNB MEMBER入会Checkoutの戻り先をブランド別に解決する（Issue #504）。
   * - 受け取るのはブランドコード（snb / mens / studio_x）のみ。URLはクライアントから受け取らず、
   *   Script Properties由来の値、またはSNB用入会URLの末尾パス差し替えでサーバー側だけが決める（open redirect防止）。
   * - snb: 既存のSTRIPE_MEMBERSHIP_SUCCESS_URL / CANCEL_URLをそのまま使う（後方互換）。
   * - mens / studio_x: stripeConfig.membershipSuccessUrls / membershipCancelUrls[brand] → なければSNB用URLの
   *   末尾'/membership/complete.html' / '/membership/'をブランド別パスへ差し替えて導出。導出できない場合は
   *   SNB用URLへ黙ってフォールバックせずok:falseを返す（ブランド混在の防止）。
   * 会員資格・金額・有効期限には関与しない（戻り先URLのみ）。
   */
  var MEMBERSHIP_SUCCESS_PATH_SUFFIX_ = '/membership/complete.html';
  var MEMBERSHIP_CANCEL_PATH_SUFFIX_ = '/membership/';

  function resolveMembershipReturnUrls(brand, stripeConfig) {
    var config = stripeConfig || {};
    if (!BRAND_PROFILES_.hasOwnProperty(brand)) return { ok: false, successUrl: '', cancelUrl: '' };
    var profile = BRAND_PROFILES_[brand];
    var successUrl = config.membershipSuccessUrl || '';
    var cancelUrl = config.membershipCancelUrl || '';
    if (profile.key !== 'snb') {
      var successOverride = config.membershipSuccessUrls && config.membershipSuccessUrls[profile.key];
      var cancelOverride = config.membershipCancelUrls && config.membershipCancelUrls[profile.key];
      successUrl = successOverride || swapBrandPath_(successUrl, MEMBERSHIP_SUCCESS_PATH_SUFFIX_, profile.pathPrefix) || '';
      cancelUrl = cancelOverride || swapBrandPath_(cancelUrl, MEMBERSHIP_CANCEL_PATH_SUFFIX_, profile.pathPrefix) || '';
    }
    return { ok: !!successUrl && !!cancelUrl, successUrl: successUrl, cancelUrl: cancelUrl };
  }

  /*
   * PENDINGからCONFIRMED/CANCELLED/EXPIREDへ、CONFIRMEDからCANCELLEDへの遷移のみを許可する
   * （Issue #272で管理者キャンセルを追加し、CONFIRMEDを終端状態から外した）。
   * CANCELLED/EXPIREDはいずれも終端状態のまま（CANCELLED→CANCELLEDの二重実行は
   * この関数ではなくcancelBookingAdmin側でalreadyCancelledとして冪等に処理する）。
   */
  /*
   * EXPIRED→CONFIRMED（Issue #334の手動復活）はここに追加するが、実際にこの遷移を
   * 実行できるのは専用のBookingRepository.reviveExpiredBookingのみとする。
   * 既存のconfirmBooking（confirmBookingLocked_）はEXPIREDを拒否し続ける
   * （canTransitionが一般に「その遷移が制度として存在するか」を表す表であるのに対し、
   * confirmBookingは「その関数が実際に受け付ける遷移」をさらに絞り込む別の関数だと
   * 整理する。confirmBookingLocked_側に明示ガードを追加している理由はそこにある）。
   */
  var ALLOWED_TRANSITIONS = {
    PENDING: [STATUS.CONFIRMED, STATUS.CANCELLED, STATUS.EXPIRED],
    CONFIRMED: [STATUS.CANCELLED],
    EXPIRED: [STATUS.CONFIRMED]
  };

  function canTransition(fromStatus, toStatus) {
    var allowedTargets = ALLOWED_TRANSITIONS[fromStatus];
    return !!allowedTargets && allowedTargets.indexOf(toStatus) !== -1;
  }

  function isAllowedBrand(brand) {
    return ALLOWED_BOOKING_BRANDS.indexOf(brand) !== -1;
  }

  function isNonEmptyString_(value, maxLength) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
  }

  var EMAIL_PATTERN_ = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function isValidEmail_(value) {
    return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN_.test(value);
  }

  var PHONE_PATTERN_ = /^[0-9()+\-\s]+$/;

  function isValidPhone_(value) {
    if (value === undefined || value === null || value === '') return true; /* 任意項目 */
    return typeof value === 'string' && value.length <= 20 && PHONE_PATTERN_.test(value);
  }

  function err_(code, message) {
    return { code: code, message: message };
  }

  /* instanceof Dateではなくダックタイピングで判定する（別realm・vmサンドボックスを
     またぐテストでinstanceof Dateが偽陰性になるため。BookingRepository.gs/
     scripts/booking-logic.jsのisDateLike_と同じ方針）。 */
  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  /*
   * dateオブジェクトを指定timezoneの暦日として'YYYY-MM-DD'へ変換する（Issue #270）。
   * 実体はBookingAvailability.formatDateInTimezone（Availability.gs）で、getAvailabilityと
   * createBookingの両方が同じタイムゾーン変換ロジックを共有する（レビュー対応で
   * getCurrentMinutesInTimezoneと合わせてAvailability.gs側に一元化した）。
   * ここではBooking.gs内部の呼び出し・Booking.formatDateInTimezoneとしての
   * 後方互換エクスポートのために薄いエイリアスを用意する。
   */
  function formatDateInTimezone(date, timezone) {
    return BookingAvailability.formatDateInTimezone(date, timezone);
  }

  /*
   * rawInput: createBooking APIが受け取る生のリクエストボディ相当。
   * availabilityConfig: BookingConfig.getAvailabilityConfig()の戻り値
   *   （openTime/closeTime/minBookingMinutes/slotStepMinutes/bufferMinutes/timezone）。
   * now: 受付時刻（Date）。省略時は現在時刻。当日判定（Asia/Tokyo基準）に使う（Issue #270）。
   *
   * 戻り値: { valid: true, normalized: {...} } または { valid: false, error: {code, message} }。
   * normalizedはtrim済み・型を揃えた値のみを含み、以降の処理（bookingId発行・Calendar/Sheets保存）は
   * すべてこのnormalizedを使う（生入力を直接使わない）。
   */
  function validateCreateBookingInput(rawInput, availabilityConfig, now, windowTier) {
    var input = rawInput || {};
    var receivedAt = isDateLike_(now) ? now : new Date();

    if (!isAllowedBrand(input.brand)) {
      return { valid: false, error: err_('INVALID_BRAND', 'このブランドではオンライン予約を受け付けていません。') };
    }

    /*
     * 利用区分（初回利用/利用経験あり）はIssue #270で必須項目とした。未指定・未知の値は
     * fail-closedで拒否する（フロントを書き換えてcustomerTypeを省略・改ざんしても
     * 当日予約制限を回避できないようにするための、サーバー側の必須検証）。
     */
    if (!isAllowedCustomerType(input.customerType)) {
      return { valid: false, error: err_('INVALID_CUSTOMER_TYPE', '利用区分（初回利用／利用経験あり）を選択してください。') };
    }

    /*
     * 日付・利用時間・Availability設定全体（営業時間/最低利用時間/バッファ分/開始刻み）を、
     * getAvailabilityと全く同じ判定（BookingAvailability.validateInput）でfail-closedに
     * 検証する。ここを素通りさせると、例えばBUFFER_MINUTES=abc（NaN）のまま後続の
     * isStartTimeBookableへ渡ってしまい、既存予約との競合を見落とす恐れがある
     * （NaNを含む比較は常にfalseになるため）。openTime/closeTime/slotStepMinutesの
     * 形式・整合性もここで保証されるため、これより後のstartMinutes計算は安全に行える
     * （レビュー指摘対応）。
     */
    var baseError = BookingAvailability.validateInput(input.date, input.durationMinutes, availabilityConfig);
    if (baseError) {
      return { valid: false, error: baseError };
    }
    var durationMinutes = input.durationMinutes;

    /*
     * 当日判定はブラウザのローカルtimezoneを正としない。受付時刻(receivedAt)を
     * availabilityConfig.timezone（既定Asia/Tokyo）基準の暦日へ変換し、入力された
     * 利用日(input.date)と文字列比較する（'YYYY-MM-DD'は辞書順=日付順に一致する）。
     * - 過去日は初回/利用経験ありを問わず拒否する
     * - 当日 + 初回利用は、Issue #407以降は拒否しない（初回利用はオンラインクレジットカード決済
     *   のみ可とし、その条件を下のFIRST_TIME_CARD_PAYMENT_REQUIREDで検証する）
     * - 当日 + 利用経験ありはここでは拒否せず、以降の通常フローへ進む
     * - 翌日以降は初回/利用経験ありのどちらも通常フローへ進む
     * timezoneの設定自体が不正でIntlが解釈できない場合はfail-closedにINVALID_CONFIGとする
     * （BUFFER_MINUTES等の誤設定と同じ扱い。isValidConfig_はtimezoneの妥当性まで検証しないため、
     * ここで別途フォールバックする）。
     */
    var todayString = formatDateInTimezone(receivedAt, availabilityConfig.timezone);
    if (!todayString) {
      return { valid: false, error: err_('INVALID_CONFIG', '営業時間・予約ルールの設定が正しくありません。') };
    }
    if (input.date < todayString) {
      return { valid: false, error: err_('INVALID_DATE', '過去の日付は指定できません。') };
    }
    /*
     * 予約可能期間の絶対上限（Issue #480）。会員先行枠を含む90日を超える日は、公開経路では誰も予約できない
     * （管理者の上限解除は、認証済みのBooking Admin経路だけが渡すwindowTier=ADMINのときのみ）。31〜90日先の会員資格は
     * BookingRepository.createBookingがメールアドレスで確認する。
     */
    if (windowTier !== BookingWindow.TIER.ADMIN && BookingWindow.classifyDate(input.date, todayString) === BookingWindow.BAND.OUT_OF_RANGE) {
      return { valid: false, error: err_('DATE_OUT_OF_RANGE', '予約できるのは' + BookingWindow.MEMBER_DAYS + '日先までです。') };
    }
    var isSameDayBooking = input.date === todayString;

    if (!BookingAvailability.isValidTimeString(input.startTime)) {
      return { valid: false, error: err_('INVALID_START_TIME', '開始時刻の形式が正しくありません（HH:mm）。') };
    }
    var startMinutes = BookingAvailability.parseTimeToMinutes(input.startTime);
    var openMinutes = BookingAvailability.parseTimeToMinutes(availabilityConfig.openTime);
    var closeMinutes = BookingAvailability.parseTimeToMinutes(availabilityConfig.closeTime);
    if (startMinutes < openMinutes || startMinutes + durationMinutes > closeMinutes) {
      return { valid: false, error: err_('INVALID_START_TIME', '営業時間（' + availabilityConfig.openTime + '〜' + availabilityConfig.closeTime + '）の範囲外です。') };
    }
    /*
     * #265/#266固定仕様: 開始時刻はslotStepMinutes（既定15分）刻みのみ許可する
     * （例: 10:00/10:15/10:30/10:45は可、10:07は不可）。getAvailabilityが提示する
     * 候補開始時刻と、実際にcreateBookingできる開始時刻を一致させるサーバー側の
     * ハード制約であり、フロントのUI都合ではない（レビュー指摘対応）。
     * baseErrorのチェックによりslotStepMinutesは正の整数であることが保証済みのため、
     * 剰余演算がNaN・0除算になることはない。
     */
    if ((startMinutes - openMinutes) % availabilityConfig.slotStepMinutes !== 0) {
      return {
        valid: false,
        error: err_('START_TIME_NOT_ALIGNED', '開始時刻は' + availabilityConfig.slotStepMinutes + '分刻みで指定してください。')
      };
    }

    /*
     * 当日（isSameDayBooking）は、開始時刻が現在時刻より後であることを必須とする
     * （Issue #270レビュー対応）。現在時刻ちょうども不可（「後」であることを要求する）。
     * Issue #407以降は初回利用+当日（カード決済のみ）もここへ到達する。フロントの
     * getAvailabilityが過去時刻を候補から除外していても、フロント改変・タイミングのずれ
     * （空き取得後に時間が経過した等）でここまで来る可能性があるため、Calendar書き込み前に
     * 必ずここで再検証する。
     */
    if (isSameDayBooking) {
      var currentMinutes = BookingAvailability.getCurrentMinutesInTimezone(receivedAt, availabilityConfig.timezone);
      if (currentMinutes === null) {
        return { valid: false, error: err_('INVALID_CONFIG', '営業時間・予約ルールの設定が正しくありません。') };
      }
      if (startMinutes <= currentMinutes) {
        return {
          valid: false,
          error: err_(
            'SAME_DAY_START_TIME_PASSED',
            '指定した開始時刻はすでに過ぎています。現在時刻より後の開始時刻を選択してください。'
          )
        };
      }
    }

    if (!isNonEmptyString_(input.name, 100)) {
      return { valid: false, error: err_('INVALID_NAME', 'お名前を入力してください。') };
    }
    if (!isValidEmail_(input.email)) {
      return { valid: false, error: err_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。') };
    }
    if (!isValidPhone_(input.phone)) {
      return { valid: false, error: err_('INVALID_PHONE', '電話番号の形式が正しくありません。') };
    }
    if (!isNonEmptyString_(input.people, 50)) {
      return { valid: false, error: err_('INVALID_PEOPLE', '利用人数を入力してください。') };
    }
    if (!isNonEmptyString_(input.purpose, 200)) {
      return { valid: false, error: err_('INVALID_PURPOSE', '利用目的を入力してください。') };
    }
    if (!isNonEmptyString_(input.paymentMethod, 50)) {
      return { valid: false, error: err_('INVALID_PAYMENT_METHOD', '支払方法を選択してください。') };
    }

    /*
     * Issue #407: 初回利用はオンラインクレジットカード決済のみ。フロントの選択肢制御に依存せず、
     * APIを直接呼んでも初回利用+現金/PayPay/未定は受理しない（当日・翌日以降を問わない）。
     * 利用経験あり（リピーター・会員）の支払方法は従来どおり。
     */
    if (input.customerType === CUSTOMER_TYPES.FIRST_TIME && !isCardPaymentMethod(input.paymentMethod)) {
      return {
        valid: false,
        error: err_(
          'FIRST_TIME_CARD_PAYMENT_REQUIRED',
          '初回利用の方のお支払いはオンラインクレジットカード決済のみとなります。'
        )
      };
    }

    /*
     * Issue #407: カード決済の「利用開始96時間前まで」の受付制限（旧CARD_PAYMENT_TOO_CLOSE_TO_START。
     * Issue #334）は全面撤廃した。Stripe Checkoutによる決済自動化により、当日を含め日程にかかわらず
     * カードを受け付ける。未決済の予約は、PENDING TTL（CARD_TTL_HOURS・利用開始の
     * minHoursBeforeStart前を上限。当日はminHoldHoursのgrace）とCheckout Sessionの
     * paymentHoldExpiresAtで従来どおり失効する。
     */

    if (input.note !== undefined && input.note !== null && (typeof input.note !== 'string' || input.note.length > 1000)) {
      return { valid: false, error: err_('INVALID_NOTE', '連絡事項は1000文字以内で入力してください。') };
    }
    if (input.source !== undefined && input.source !== null && (typeof input.source !== 'string' || input.source.length > 100)) {
      return { valid: false, error: err_('INVALID_SOURCE', '流入元の形式が正しくありません。') };
    }

    return {
      valid: true,
      normalized: {
        brand: input.brand,
        customerType: input.customerType,
        /*
         * 会員区分の自己申告（Issue #342）。任意項目・fail-closedでデフォルトfalse
         * （未指定・不正値は「会員ではない」＝一般料金側へ倒す。会員特典を誤って
         * 適用しないための方向）。実際に適用されるtier（studio_x/mensではこの値を
         * 無視して固定される）はBookingPricing.computeBookingPriceの責務であり、
         * ここでは入力をそのまま真偽値へ正規化するだけ。
         */
        isMember: input.isMember === true,
        /* Issue #478: 独立プラン識別子（'member_pair_3h'）。値の検証・会員資格の確認は
           BookingRepository.createBooking（BookingPricing.normalizePlan＋MembershipRules.verifyActualMembership）。 */
        plan: input.plan === undefined || input.plan === null ? '' : String(input.plan).trim().slice(0, 50),
        /* Issue #667: 作品撮りサポートプランのスタッフ対応種別（'SETUP'|'CLEANUP'|'BOTH'）。値の検証・必須判定は
           BookingPricing.normalizeSupportServices（BookingRepository.createBooking）。他のプランでは使わない。 */
        /* Issue #667: 作品撮りサポートに付ける有料機材 { 機材コード: 数量 }。形式・在庫・料金は BookingOptions.computeSupportEquipment が検証する。 */
        supportEquipment: input.supportEquipment !== null && typeof input.supportEquipment === 'object' && !Array.isArray(input.supportEquipment) ? input.supportEquipment : undefined,
        supportServices: input.supportServices === undefined || input.supportServices === null ? '' : String(input.supportServices).trim().slice(0, 20),
        date: input.date,
        startTime: input.startTime,
        durationMinutes: durationMinutes,
        name: input.name.trim(),
        email: input.email.trim(),
        phone: input.phone ? String(input.phone).trim() : '',
        people: String(input.people).trim(),
        purpose: input.purpose.trim(),
        paymentMethod: input.paymentMethod.trim(),
        note: input.note ? String(input.note).trim() : '',
        source: input.source ? String(input.source).trim() : 'unknown'
      }
    };
  }

  /*
   * brand・dateString（'YYYY-MM-DD'）・uuid（Utilities.getUuid()相当）からbookingIdを発行する。
   * 例: 'SX-20261001-3F2A9B1C'
   * - 連番だけに依存しない（uuidの一部を混ぜることで、同時発行時の衝突可能性を下げる）
   * - 日付を含むため人が見て追跡しやすい
   * - Calendar / Sheets / recoveryのいずれでも同じ文字列で照合できる
   */
  function generateBookingId(brand, dateString, uuid) {
    var prefix = BRAND_ID_PREFIX_[brand] || 'XX';
    var compactDate = String(dateString).replace(/-/g, '');
    var uuidPart = String(uuid || '').replace(/-/g, '').slice(0, 8).toUpperCase();
    return prefix + '-' + compactDate + '-' + uuidPart;
  }

  /*
   * PENDING TTLの失効時刻（ミリ秒epoch）を計算する。
   * 通常TTL（#268固定仕様。翌日以降の予約はこの式のみで決まる）:
   *   normalExpiry = min(受付+ttlHours, 利用開始-minHoursBeforeStart)
   *
   * minHoldHours（Issue #270レビュー対応で再設計。省略時0＝#268時点と完全に同じ挙動）:
   * 通常TTLの「利用開始-minHoursBeforeStart」が受付時刻以前になる場合（＝利用開始まで
   * minHoursBeforeStart未満しかない直前の当日予約）に限り、grace（猶予）を使う。
   * 「受付から少なくともminHoldHours時間は保持する」という単純な下限ではなく、
   * **利用開始時刻(startAtMillis)を必ず上限とする**（expiry <= startAt を保証する。
   * 当日PENDINGが利用開始後までCalendar/Sheets上に残ってしまう事故を防ぐため）。
   * 通常TTLが受付時刻より後になる場合（＝開始まで十分な余裕がある）はgraceを使わず、
   * 通常TTLをそのまま返す＝#268時点とビット単位で同じ値になる。
   */
  function computeTtlExpiryMillis(createdAtMillis, startAtMillis, ttlHours, minHoursBeforeStart, minHoldHours) {
    var ttlExpiry = createdAtMillis + ttlHours * 3600000;
    var normalStartLimit = startAtMillis - minHoursBeforeStart * 3600000;
    var normalExpiry = Math.min(ttlExpiry, normalStartLimit);

    if (!minHoldHours || minHoldHours <= 0 || normalExpiry > createdAtMillis) {
      return normalExpiry;
    }

    var graceExpiry = createdAtMillis + minHoldHours * 3600000;

    return Math.min(ttlExpiry, graceExpiry, startAtMillis);
  }


  /*
   * Issue #667: 作品撮りサポートプラン（mens）の申込段階。予約状態（STATUS）・決済状態（PAYMENT_STATUS）とは別の、運営承認の軸。
   * 「申込受付＝承認待ち（仮押さえ中）」→「承認済み＝支払い待ち（承認後24時間）」→ 支払い完了で予約確定（CONFIRMED）。
   * 承認の事実はsupportApprovedAt（空＝未承認）、支払い期限はsupportPaymentDueAt。管理画面・メール・決済ゲートはすべてこの1関数で段階を決める。
   * 戻り値: '' （作品撮りサポートではない）| 'AWAITING_APPROVAL' | 'AWAITING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED'
   */
  var PHOTO_SUPPORT_PLAN_CODE = 'mens_photo_support';

  function photoSupportStage(record) {
    var r = record || {};
    if (r.planCode !== PHOTO_SUPPORT_PLAN_CODE) return '';
    if (r.status === STATUS.CONFIRMED) return 'CONFIRMED';
    if (r.status === STATUS.CANCELLED) return 'CANCELLED';
    if (r.status === STATUS.EXPIRED) return 'EXPIRED';
    return isDateLike_(r.supportApprovedAt) ? 'AWAITING_PAYMENT' : 'AWAITING_APPROVAL';
  }

  /*
   * 作品撮りサポートの決済可否（承認前は決済不可・承認後24時間が支払い期限）。beginCardCheckoutの最終ガード。
   * 戻り値: null（決済に進めてよい／作品撮りサポートではない） | { code, message }
   */
  function photoSupportPaymentGate(record, nowMillis) {
    var stage = photoSupportStage(record);
    if (!stage) return null;
    if (stage === 'AWAITING_APPROVAL') {
      return { code: 'SUPPORT_NOT_APPROVED', message: '作品撮りサポートプランは運営の承認後にお支払いいただけます。承認のご連絡をお待ちください。' };
    }
    if (stage !== 'AWAITING_PAYMENT') {
      return { code: 'BOOKING_NOT_PENDING', message: 'この予約は決済待ちの状態ではありません。' };
    }
    var due = isDateLike_(record.supportPaymentDueAt) ? record.supportPaymentDueAt.getTime() : NaN;
    if (!(nowMillis < due)) {
      return { code: 'SUPPORT_PAYMENT_EXPIRED', message: 'お支払い期限（承認後24時間）を過ぎたため、お支払いいただけません。' };
    }
    return null;
  }

  /*
   * 作品撮りサポートのPENDING失効時刻（ミリ秒epoch）。承認後は支払い期限（supportPaymentDueAt。承認から24時間）。
   * 承認前は24時間・72時間のTTLを使わず（運営の確認を待つ）、利用開始のminHoursBeforeStart前を上限とする。
   * 期限情報が不正な承認済みレコードは即時失効側（0）へ倒さず、承認前と同じ上限で扱う（誤って枠を即解放しない）。
   */
  function computePhotoSupportExpiryMillis(record, startAtMillis, minHoursBeforeStart) {
    var r = record || {};
    if (isDateLike_(r.supportApprovedAt) && isDateLike_(r.supportPaymentDueAt)) return r.supportPaymentDueAt.getTime();
    return startAtMillis - minHoursBeforeStart * 3600000;
  }

  function isExpired(createdAtMillis, startAtMillis, ttlHours, minHoursBeforeStart, nowMillis, minHoldHours) {
    return nowMillis >= computeTtlExpiryMillis(createdAtMillis, startAtMillis, ttlHours, minHoursBeforeStart, minHoldHours);
  }

  /*
   * カード予約の支払期限（＝PENDING TTL失効時刻）をミリ秒epochで返す（Issue #334）。
   * expirePendingBookings（失効判定）とBooking Admin表示（支払期限表示）の両方が
   * 必ずこの1関数だけを経由する（表示用と判定用で別計算・別定数を持たない）。
   * 内部はcomputeTtlExpiryMillisをCARD_TTL_HOURS固定で呼び出すだけの薄いラッパー。
   * minHoldHoursは省略時0（翌日以降のカード予約。Issue #406で当日カードを解禁するまでは
   * 常に0）。当日予約のカードのみ、呼び出し側がcardMinHoldHoursの値を渡す。minHoursBeforeStartは既存のPENDING_TTL_MIN_HOURS_BEFORE_START
   * （既定2時間。Script Properties経由。Issue #334で変更しない）をそのまま渡す。
   */
  function computeCardPaymentDueMillis(createdAtMillis, startAtMillis, minHoursBeforeStart, minHoldHours) {
    return computeTtlExpiryMillis(createdAtMillis, startAtMillis, CARD_TTL_HOURS, minHoursBeforeStart, minHoldHours || 0);
  }

  /*
   * Issue #406: カード予約に適用するPENDING TTLのgrace（minHoldHours）。当日予約のカードは
   * 利用開始まで2時間未満で受け付けることがあり、grace無しだと通常TTL（利用開始-2時間）が
   * 受付時刻以前になって作成直後に失効してしまう。当日予約に限り、現金・PayPayと同じ
   * ttlConfig.minHoldHours（利用開始時刻を上限とする猶予）を使う。翌日以降は0のまま
   * （従来の72時間TTLと完全に同じ値）。当日判定はisSameDayBookingRecord（受付日=利用日）。
   */
  function cardMinHoldHours(record, timezone, minHoldHours) {
    return isSameDayBookingRecord(record, timezone) ? (minHoldHours || 0) : 0;
  }

  /*
   * 予約の「実際に案内すべき利用料金」（Issue #342）。管理者が確定前に金額を修正して
   * いれば（priceOverrideAtが空でない）その修正値（priceOverrideAmount）を優先し、
   * なければ予約時にBookingPricingで自動計算した値（priceAmount）を返す。
   * 「上書きの有無」の判定はpriceOverrideAtの有無（他のSentAt系列と同じ、空文字=未実施の
   * 慣習）で行う。金額そのもの（priceOverrideAmountの値）で判定しないのは、0円という
   * 有効な上書き値と「上書きなし」を区別できるようにするため。
   * 呼び出し側（Booking Admin表示等）は必ずこの関数経由で「案内する金額」を決め、
   * priceAmount/priceOverrideAmountを個別に参照して食い違う事故を防ぐ。
   * 料金データを持たない過去の予約（列が空）ではnullを返す（例外を投げない）。
   */
  function getEffectivePriceAmount(record) {
    var r = record || {};
    var hasOverride = r.priceOverrideAt !== '' && r.priceOverrideAt !== null && r.priceOverrideAt !== undefined;
    var raw = hasOverride ? r.priceOverrideAmount : r.priceAmount;
    if (raw === '' || raw === null || raw === undefined) return null;
    var amount = Number(raw);
    return Number.isFinite(amount) ? amount : null;
  }

  /*
   * 最新の金額修正が利用者へ案内済みかを共通判定する。
   * Sheetsの日時は通常Dateだが、過去データ等で不正な日時があれば未案内側へ倒す。
   */
  function needsPriceUpdateNotice(record) {
    var r = record || {};
    if (!r.priceOverrideAt) return false;
    if (!r.priceUpdateMailSentAt) return true;
    var changedAt = new Date(r.priceOverrideAt).getTime();
    var sentAt = new Date(r.priceUpdateMailSentAt).getTime();
    return !Number.isFinite(changedAt) || !Number.isFinite(sentAt) || changedAt > sentAt;
  }

  /*
   * Issue #341 PR-D: この予約がStripe Checkout（PR-B/PR-C）の決済フローに一度でも
   * 入ったかどうか。決済試行ID・Session・PaymentIntentのいずれかが記録されているか、
   * paymentStatusがnot_started以外であればtrue。paymentStatusが未知の値（normalize結果
   * null）の場合もtrueにする（fail-closed。鍵情報を誤って送る側へ倒さない）。
   *
   * 旧Payment Link方式（Issue #334）のカード予約・現金・PayPayはこれらの列がすべて空で
   * paymentStatusも既定値のままのためfalseになり、PR-Dの来場案内の決済ゲート・返金操作の対象外
   * （従来どおりの運用）になる。
   */
  function isStripeCheckoutBooking(record, now) {
    var r = record || {};
    var normalized = normalizePaymentStatus(r.paymentStatus);
    if (normalized !== PAYMENT_STATUS.NOT_STARTED) return true;
    if (r.stripeCheckoutSessionId || r.stripePaymentIntentId) return true;
    if (r.paymentAttemptId) return !isExpiredUnstartedCheckoutReservation_(r, now);
    return false;
  }

  /*
   * Issue #398: 決済試行IDだけが予約済み（reservePaymentAttempt_が書いた状態）で、
   * Checkout Sessionの証跡（Session ID・PaymentIntent）が無く
   * paymentStatusもnot_startedのままの予約が、Sessionの有効期限（paymentHoldExpiresAt。
   * Stripeのexpires_atと同じ値）を十分に過ぎているか。
   *
   * この状態はSession作成APIの結果が不明のまま止まった、または作成前に中断した予約で、
   * Sessionが仮に存在しても期限切れで支払えない。この間は二重決済の恐れがあるため
   * Checkout方式として扱い（旧Payment Link送信UIを出さない）、期限＋猶予を過ぎたら
   * 旧Payment Link方式として扱って運用を復旧させる。
   * 期限を読み取れない・要復旧が立っている場合は常にfalse（fail-closed）。
   */
  var CHECKOUT_RESERVATION_GRACE_MS_ = 60 * 60 * 1000;

  function isExpiredUnstartedCheckoutReservation_(record, now) {
    if (record.paymentRecoveryRequiredAt) return false;
    if (!isDateLike_(record.paymentHoldExpiresAt)) return false;
    var current = isDateLike_(now) ? new Date(now).getTime() : Date.now();
    return current > new Date(record.paymentHoldExpiresAt).getTime() + CHECKOUT_RESERVATION_GRACE_MS_;
  }

  /*
   * Issue #396: 旧Payment Link方式（Issue #334）のカード予約か。カード決済で、かつ
   * Stripe Checkoutの決済フローに入っていない（isStripeCheckoutBookingがfalse）予約。
   * STRIPE_CHECKOUT_ENABLEDが有効になるまで、本番のカード予約はすべてこちらになる。
   */
  function isLegacyPaymentLinkBooking(record, now) {
    var r = record || {};
    return isCardPaymentMethod(r.paymentMethod) && !isStripeCheckoutBooking(r, now);
  }

  /*
   * Issue #396: 決済リンクが少なくとも1回送信済みか（paymentLinkSentAtまたは送信回数）。
   * 送信結果が未確認（paymentLinkSendUnconfirmedAtのみ）の予約は送信済みとみなさない。
   */
  function hasPaymentLinkBeenSent(record) {
    var r = record || {};
    return !!r.paymentLinkSentAt || Number(r.paymentLinkSendCount) > 0;
  }

  /*
   * Issue #341 PR-D: 当日予約（受付日と利用日がtimezone基準で同じ日）かどうか。
   * createBooking時のisSameDayBooking（validateCreateBookingInput）・expirePendingBookings
   * の判定（createdAtの日付とrecord.dateの比較）と同じ定義。createdAtまたはdateを
   * 解釈できない場合はfalse（当日予約ではない側。fail-closed）。
   */
  function isSameDayBookingRecord(record, timezone) {
    var r = record || {};
    if (!isDateLike_(r.createdAt)) return false;
    var createdDate = formatDateInTimezone(r.createdAt, timezone);
    var bookingDate = isDateLike_(r.date) ? formatDateInTimezone(r.date, timezone) : String(r.date || '');
    return !!createdDate && createdDate === bookingDate;
  }

  var ACCESS_GATE_REASON_CODES = {
    PAYMENT_RECOVERY_REQUIRED: 'PAYMENT_RECOVERY_REQUIRED',
    PAYMENT_NOT_SETTLED: 'PAYMENT_NOT_SETTLED'
  };

  /*
   * 鍵・来場案内（前日リマインド／当日即時送信）を送ってよいかの決済ゲート判定
   * （Issue #341 PR-D、Issue #414で鍵承認を廃止）。前日リマインドの自動送信・管理者の再送・
   * 当日即時送信のすべてが、Lock取得後に再読込した最新レコードに対してこの1関数を呼ぶ
   * （判定を複製しない）。管理者の鍵承認（accessApprovedAt）は判定に使わない。
   *
   * Stripe Checkoutの決済フローに入っていない予約（現地払い・旧Payment Link）は
   * 常に{required:false, ok:true}。Stripe Checkout予約は、上から順に次のいずれかに
   * 該当すると送信不可（ok:false。fail-closed）:
   * - PAYMENT_RECOVERY_REQUIRED: 決済の要復旧ゲート（paymentRecoveryRequiredAt）が未解消。
   * - PAYMENT_NOT_SETTLED: 入金済み（paid）でない、または返金の判断・手続きが始まっている
   *   （refundDecision/refundAttemptIdが記録済みで、返金試行が失敗で終わっていない）。
   * 当日予約も同じ判定（当日かどうかで条件を変えない）。
   */
  function evaluateAccessGate(record) {
    var r = record || {};
    if (!isStripeCheckoutBooking(r)) {
      return { required: false, ok: true, reasonCode: '', message: '' };
    }
    if (r.paymentRecoveryRequiredAt) {
      return {
        required: true, ok: false, reasonCode: ACCESS_GATE_REASON_CODES.PAYMENT_RECOVERY_REQUIRED,
        message: 'この予約は決済の要対応（Recovery）が未解消のため、鍵情報を含む来場案内を送信できません。'
      };
    }
    var refundStarted = !!r.refundDecision || (!!r.refundAttemptId && r.refundAttemptState !== 'FAILED');
    if (normalizePaymentStatus(r.paymentStatus) !== PAYMENT_STATUS.PAID || refundStarted) {
      return {
        required: true, ok: false, reasonCode: ACCESS_GATE_REASON_CODES.PAYMENT_NOT_SETTLED,
        message: 'この予約は入金済みの状態ではない（未入金・返金手続き中・返金済み等）ため、鍵情報を含む来場案内を送信できません。'
      };
    }
    return { required: true, ok: true, reasonCode: '', message: '' };
  }

  return {
    STATUS: STATUS,
    PAYMENT_STATUS: PAYMENT_STATUS,
    ACCESS_GATE_REASON_CODES: ACCESS_GATE_REASON_CODES,
    evaluateAccessGate: evaluateAccessGate,
    isStripeCheckoutBooking: isStripeCheckoutBooking,
    isLegacyPaymentLinkBooking: isLegacyPaymentLinkBooking,
    hasPaymentLinkBeenSent: hasPaymentLinkBeenSent,
    isSameDayBookingRecord: isSameDayBookingRecord,
    normalizePaymentStatus: normalizePaymentStatus,
    canTransitionPaymentStatus: canTransitionPaymentStatus,
    ALLOWED_BOOKING_BRANDS: ALLOWED_BOOKING_BRANDS,
    CUSTOMER_TYPES: CUSTOMER_TYPES,
    ALLOWED_CUSTOMER_TYPES: ALLOWED_CUSTOMER_TYPES,
    PAYMENT_METHOD_CARD: PAYMENT_METHOD_CARD,
    CARD_TTL_HOURS: CARD_TTL_HOURS,
    isCardPaymentMethod: isCardPaymentMethod,
    isValidStripePaymentLinkUrl: isValidStripePaymentLinkUrl,
    /* PR #337レビュー対応（5回目）: resolvePaymentLinkMetadataInconsistencyが
       確認済みの送信先メールアドレス（confirmedSentTo）を検証する際、
       validateCreateBookingInputと同じ形式検証を再利用するための公開API。 */
    isValidEmail: isValidEmail_,
    getBrandLabel: getBrandLabel,
    getBrandProfile: getBrandProfile,
    resolveCheckoutReturnUrls: resolveCheckoutReturnUrls,
    resolveMembershipReturnUrls: resolveMembershipReturnUrls,
    getCustomerTypeLabel: getCustomerTypeLabel,
    canTransition: canTransition,
    isAllowedBrand: isAllowedBrand,
    isAllowedCustomerType: isAllowedCustomerType,
    formatDateInTimezone: formatDateInTimezone,
    validateCreateBookingInput: validateCreateBookingInput,
    generateBookingId: generateBookingId,
    computeTtlExpiryMillis: computeTtlExpiryMillis,
    computeCardPaymentDueMillis: computeCardPaymentDueMillis,
    cardMinHoldHours: cardMinHoldHours,
    isExpired: isExpired,
    PHOTO_SUPPORT_PLAN_CODE: PHOTO_SUPPORT_PLAN_CODE,
    photoSupportStage: photoSupportStage,
    photoSupportPaymentGate: photoSupportPaymentGate,
    computePhotoSupportExpiryMillis: computePhotoSupportExpiryMillis,
    getEffectivePriceAmount: getEffectivePriceAmount,
    needsPriceUpdateNotice: needsPriceUpdateNotice
  };
})();
