/*
 * FeeCalculator.gs — 料金差額の自動計算エンジン（Issue #344追記。PR #345レビュー対応で
 * BookingPricing.gs/JapaneseHolidays.gsを単一の正本として再設計）。
 *
 * 当初（PR #345初版）はここに独自の料金表・祝日判定（FeeMasterRepository.gs/
 * JapanHolidays.gs）を持っていたが、PR #345レビューで以下を指摘され、廃止した:
 * - 料金表の二重管理（BookingPricing.gsが「料金表はここ1箇所のみに定義する」と
 *   明記しているのに、日程変更用に別の表を持つと改定時の食い違いリスクがある）。
 * - FeeMasterRepositoryのeffectiveAt='2020-01-01'は根拠のない偽装だった
 *   （実際にいつから有効だったか確認できないのに2020年からとしていた）。
 * このファイルは、料金の正本をBookingPricing.gs（Issue #342/#343）・祝日判定の正本を
 * JapaneseHolidays.gs（Issue #346/#347）に一本化し、日程変更特有の「30分刻みへの丸め」
 * 「差額の判定」「キャンセル規定との突合」だけをここに置く。
 *
 * 30分刻み料金の扱い（承認済み方針とレビュー指摘の反映）:
 *   承認済みの方針は「30分単位で計算する」「変更確定時点の最新料金表を適用する」の2点。
 *   ただし、2.5時間・3.5時間等（30分刻みの丸め後の時間が整数時間にならないケース）の
 *   具体的な金額を隣接する整数時間からどう補間するかは**未承認**（PR #345レビュー
 *   「2.5時間・3.5時間の具体的な料金を線形補間すること…は未承認」）。そのため、
 *   このモジュールは以下の2ケースだけを扱う:
 *   - 丸め後の時間が整数時間（2h/3h/4h、または4hを超える整数時間）に一致する場合のみ、
 *     BookingPricing.computeBookingPrice（唯一の正本）へそのまま委譲して金額を返す
 *     （二重管理なし。祝日判定も含めてBookingPricing.gs内部で一貫して行われる）。
 *   - 丸め後の時間が半端な30分単位（2.5h/3.5h等）の場合は、金額を一切自動算出せず
 *     `supported:false`（reason: 'HALF_HOUR_RATE_UNCONFIRMED'）を返す。呼び出し側
 *     （BookingReschedule.gs）は、管理者が金額と理由を明示的に入力しない限り確定
 *     できないfail-closedな扱いにする（未承認の事業ルールを実装で決めない）。
 *
 * キャンセル規定との関係（承認済みの運用方針）:
 *   既存のキャンセル規定は「2日前まで無料／前日50%／当日100%」と「日程変更は前日まで
 *   1回無料、2回目以降はキャンセル扱い」。しかし「一部時間短縮をキャンセルと同一視するか」
 *   「差額のどの部分にキャンセル料を掛けるか」は規約に明記が無く、issue本文が
 *   「実装で決めず管理者承認または規約改定を待つ」と明示しているため、このモジュールは
 *   以下の2ケースだけを自動確定し、それ以外はPENDING_POLICY_DECISIONとして返す
 *   （返金額を一切自動算出しない。要管理者確認）:
 *   1. 新料金が旧料金以上（差額>=0）: 単純な追加請求（ADDITIONAL_CHARGE_REQUIRED）。
 *      キャンセル規定は関係ない。
 *   2. 新料金が旧料金未満（差額<0）で、かつ「今回がこの予約で初めての日程変更」かつ
 *      「変更前の利用日の前日までの申し出」: 規約の「前日まで1回無料」に該当するため、
 *      キャンセル料を掛けずに差額全額を返金候補とする（CANDIDATE）。
 *   上記以外の減額（2回目以降、または当日の変更）はPENDING_POLICY_DECISION。このモジュールは
 *   金額を一切自動算出しない。管理者が個別に金額と理由を判断して確定する処理は
 *   BookingReschedule.gs側の責務とする（このモジュールは「規約上どちらとも決められない」
 *   ことを検出するだけに留める）。
 */
'use strict';

var FeeCalculator = (function () {
  var STEP_MINUTES_ = 30;

  function roundUpToStepMinutes_(minutes, step) {
    return Math.ceil(minutes / step) * step;
  }

  /*
   * dateStringの曜日区分（'WEEKDAY'|'WEEKEND_HOLIDAY'）を判定する。BookingPricing.gsの
   * resolveDayType_と全く同じ順序・ロジック（PR #347レビュー対応: 対応年範囲外の
   * 土日だけがJapaneseHolidays.classifyの検証を経由せず「たまたま」成功する非対称な
   * fail-closedを避けるため、必ず先にclassifyの成否を確認する）。
   * 戻り値: { ok: true, dayType } または { ok: false, error }。
   */
  function resolveDayType_(dateString) {
    var classified = JapaneseHolidays.classify(dateString);
    if (!classified.ok) return { ok: false, error: classified.error };
    var parts = dateString.split('-');
    var weekday = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10))).getUTCDay();
    var isWeekendOrHoliday = weekday === 0 || weekday === 6 || classified.isHoliday;
    return { ok: true, dayType: isWeekendOrHoliday ? BookingPricing.DAY_TYPE.WEEKEND_HOLIDAY : BookingPricing.DAY_TYPE.WEEKDAY };
  }

  /*
   * params: { brand, priceTier ('GENERAL'|'MEMBER'), durationMinutes, dateString }
   * dateStringは変更後の利用日（'YYYY-MM-DD'。土日祝判定に使う）。
   * 戻り値:
   *   { supported: true, amount, dayType, tier, roundedMinutes, billableHours }
   * | { supported: false, reason, message, roundedMinutes, dayType }
   *     reason: 'HALF_HOUR_RATE_UNCONFIRMED' | BookingPricing/JapaneseHolidaysのerror.code
   *             （'INVALID_BRAND'|'INVALID_DATE'|'INVALID_DURATION'|'HOLIDAY_YEAR_UNSUPPORTED'）
   */
  function quoteFee(params) {
    var roundedMinutes = roundUpToStepMinutes_(Number(params.durationMinutes), STEP_MINUTES_);
    var dayTypeResult = resolveDayType_(params.dateString);
    if (!dayTypeResult.ok) {
      return {
        supported: false, reason: dayTypeResult.error.code, message: dayTypeResult.error.message,
        roundedMinutes: roundedMinutes, dayType: null
      };
    }
    if (roundedMinutes % 60 !== 0) {
      return {
        supported: false, reason: 'HALF_HOUR_RATE_UNCONFIRMED',
        message: '30分刻みの端数（' + (roundedMinutes / 60) + '時間）の金額は承認された料金表にないため、自動算出できません。管理者が金額を確認してください。',
        roundedMinutes: roundedMinutes, dayType: dayTypeResult.dayType
      };
    }
    var priceResult = BookingPricing.computeBookingPrice({
      brand: params.brand, date: params.dateString, durationMinutes: roundedMinutes,
      isMember: params.priceTier === 'MEMBER'
    });
    if (!priceResult.valid) {
      return {
        supported: false, reason: priceResult.error.code, message: priceResult.error.message,
        roundedMinutes: roundedMinutes, dayType: dayTypeResult.dayType
      };
    }
    return {
      supported: true, amount: priceResult.price.amount, dayType: priceResult.price.dayType,
      tier: priceResult.price.tier, roundedMinutes: roundedMinutes, billableHours: priceResult.price.billableHours
    };
  }

  function toUtcDays_(dateString) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    if (!m) return null;
    return Math.floor(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) / 86400000);
  }

  /* referenceDateString: 変更前の利用日。todayDateString: 申し出日（通常は今日）。
     いずれも'YYYY-MM-DD'。日付を解釈できない場合は最も保守的な'SAME_DAY'を返す
     （fail-closed。自動での「無料変更」判定を誤って有利に倒さない）。 */
  function classifyCancellationPolicy(referenceDateString, todayDateString) {
    var refDays = toUtcDays_(referenceDateString);
    var todayDays = toUtcDays_(todayDateString);
    if (refDays === null || todayDays === null) return 'SAME_DAY';
    var diff = refDays - todayDays;
    if (diff <= 0) return diff === 0 ? 'SAME_DAY' : 'PAST';
    if (diff === 1) return 'DAY_BEFORE';
    return 'TWO_DAYS_PLUS';
  }

  /*
   * params: {
   *   oldAmount, newAmount: 円。
   *   unrefundedPaidAmount: 既に入金済みでまだ返金していない額（返金候補の上限）。
   *   scheduleChangeCount: このBookingでこれまでに確定した日程変更の回数（今回を含まない）。
   *   cancellationPolicyCategory: classifyCancellationPolicy()の戻り値。
   * }
   * 戻り値: { feeDifference, refundStatus, refundCandidateAmount, pendingReason }
   * refundStatus: 'NONE' | 'ADDITIONAL_CHARGE_REQUIRED' | 'CANDIDATE' | 'PENDING_POLICY_DECISION'
   * refundCandidateAmountはPENDING_POLICY_DECISIONの場合はnull（自動算出しない。
   * この場合に金額を確定する・免除特例を適用する等の判断はBookingReschedule.gs側で
   * 管理者の明示的な承認を必須として扱う）。
   */
  function assessScheduleChangeFee(params) {
    var diff = params.newAmount - params.oldAmount;
    if (diff === 0) {
      return { feeDifference: 0, refundStatus: 'NONE', refundCandidateAmount: 0, pendingReason: '' };
    }
    if (diff > 0) {
      return { feeDifference: diff, refundStatus: 'ADDITIONAL_CHARGE_REQUIRED', refundCandidateAmount: 0, pendingReason: '' };
    }
    var unrefunded = Math.max(0, Number(params.unrefundedPaidAmount) || 0);
    var isFirstChange = Number(params.scheduleChangeCount) === 0;
    var isBeforeSameDay = params.cancellationPolicyCategory === 'TWO_DAYS_PLUS' ||
      params.cancellationPolicyCategory === 'DAY_BEFORE';
    if (isFirstChange && isBeforeSameDay) {
      return {
        feeDifference: diff, refundStatus: 'CANDIDATE',
        refundCandidateAmount: Math.min(-diff, unrefunded), pendingReason: ''
      };
    }
    var pendingReason = !isFirstChange
      ? '2回目以降の日程変更はキャンセル規定の適用方法が規約上未確定のため、返金額は管理者が個別判断してください。'
      : '当日の日程変更（短縮）はキャンセル規定の適用方法が規約上未確定のため、返金額は管理者が個別判断してください。';
    return { feeDifference: diff, refundStatus: 'PENDING_POLICY_DECISION', refundCandidateAmount: null, pendingReason: pendingReason };
  }

  return {
    roundUpToStepMinutes: roundUpToStepMinutes_,
    resolveDayType: resolveDayType_,
    quoteFee: quoteFee,
    classifyCancellationPolicy: classifyCancellationPolicy,
    assessScheduleChangeFee: assessScheduleChangeFee
  };
})();
