/*
 * FeeCalculator.gs — 料金差額の自動計算エンジン（Issue #344追記 Phase 1）。
 *
 * SNB / SNB mens / Studio X 直接予約向け。外部予約サイト（スペースマーケット等）は対象外
 * （FeeMasterRepository.gs参照）。丸め・端数処理・会員適用・祝日判定を純粋関数として
 * 分離し、Spreadsheet/CalendarApp等のGAS依存を持たない（FeeMasterRepositoryの
 * 料金表取得だけがSpreadsheetApp依存）。
 *
 * 30分刻み料金の算出方法（Issue #344追記の「暫定案」を2026-09-25にv1として承認・実装）:
 *   公開されている料金表は2h/3h/4h/延長1hの4点のみ。中間の2.5h/3.5hは隣接する2点の
 *   単純平均（線形補間）、4h超は「延長1h単価の半額」を30分ごとに加算する。
 *   30分未満の端数は常に切り上げる（roundUpToStepMinutes_）。平均で1円未満の端数が
 *   生じた場合はMath.round（四捨五入）で円単位に丸める（v1の実際の金額はすべて
 *   割り切れるため、現時点でこの丸めが実際に発生することはない。将来の料金改定で
 *   端数が生じる場合は、この四捨五入ルール自体をFeeMasterのnote等に明記して変更すること）。
 *
 * キャンセル規定との関係（Issue #344追記の「確定した運用方針」）:
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
 *   上記以外の減額（2回目以降、または当日の変更。免除特例の適用判断を含む）は
 *   PENDING_POLICY_DECISION とし、このモジュールは金額を一切自動算出しない。
 *   管理者が個別に金額と理由を判断して確定する処理はBookingReschedule.gs側の責務とする
 *   （このモジュールは「規約上どちらとも決められない」ことを検出するだけに留める）。
 */
'use strict';

var FeeCalculator = (function () {
  var STEP_MINUTES_ = 30;

  function roundUpToStepMinutes_(minutes, step) {
    return Math.ceil(minutes / step) * step;
  }

  /* entry: FeeMasterRepositoryの1行（hour2Amount/hour3Amount/hour4Amount/extensionHourAmount）。
     roundedMinutesは30分刻みに切り上げ済みの値であること（120以上）。 */
  function computeAmountForEntry_(entry, roundedMinutes) {
    if (roundedMinutes < 120) return null;
    if (roundedMinutes === 120) return entry.hour2Amount;
    if (roundedMinutes === 150) return Math.round((entry.hour2Amount + entry.hour3Amount) / 2);
    if (roundedMinutes === 180) return entry.hour3Amount;
    if (roundedMinutes === 210) return Math.round((entry.hour3Amount + entry.hour4Amount) / 2);
    if (roundedMinutes === 240) return entry.hour4Amount;
    var extraSteps = (roundedMinutes - 240) / STEP_MINUTES_;
    return entry.hour4Amount + Math.round(entry.extensionHourAmount / 2 * extraSteps);
  }

  /*
   * params: { brand, priceCategory, durationMinutes, dateString, asOfDateString }
   * dateStringは利用日（'YYYY-MM-DD'。土日祝判定に使う）、asOfDateStringは料金表の
   * バージョン判定に使う基準日（プレビュー時・確定直前時でそれぞれ「今日」を渡す）。
   * 戻り値: { supported: true, version, effectiveAt, dayType, roundedMinutes, amount, entry }
   *      | { supported: false, version, effectiveAt, dayType, roundedMinutes, reason }
   */
  function quoteFee(params) {
    var dayType = JapanHolidays.isWeekendOrHoliday(params.dateString) ? 'weekend_holiday' : 'weekday';
    var roundedMinutes = roundUpToStepMinutes_(params.durationMinutes, STEP_MINUTES_);
    var found = FeeMasterRepository.findEntry(params.asOfDateString, params.brand, params.priceCategory, dayType);
    if (!found.entry) {
      return {
        supported: false, version: found.version, effectiveAt: found.effectiveAt,
        dayType: dayType, roundedMinutes: roundedMinutes, reason: 'NO_PRICE_DATA'
      };
    }
    var amount = computeAmountForEntry_(found.entry, roundedMinutes);
    if (amount === null) {
      return {
        supported: false, version: found.version, effectiveAt: found.effectiveAt,
        dayType: dayType, roundedMinutes: roundedMinutes, reason: 'DURATION_TOO_SHORT'
      };
    }
    return {
      supported: true, version: found.version, effectiveAt: found.effectiveAt,
      dayType: dayType, roundedMinutes: roundedMinutes, amount: amount, entry: found.entry
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
    computeAmountForEntry: computeAmountForEntry_,
    quoteFee: quoteFee,
    classifyCancellationPolicy: classifyCancellationPolicy,
    assessScheduleChangeFee: assessScheduleChangeFee
  };
})();
