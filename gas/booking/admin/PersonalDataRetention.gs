/*
 * PersonalDataRetention.gs — Bookings台帳と、予約IDで結び付く子シート（FeeSettlements / BookingChanges /
 * Recovery / OptionOrders）、会員系シート（Members / MemberCheckouts / MemberStatusTokens）、Stripe
 * Webhookの受信台帳（StripeEvents）の個人情報を、通常保存期間（180日）の経過後に毎日自動で消去する
 * 運用基盤（Issue #680 PR-1〜PR-4）。
 *
 * 【デプロイ先】Booking Admin（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）専用。公開Web App・
 * Webhookプロジェクトへは配布しない（削除実行APIを公開側へ置かない）。エディタ・時間主導トリガーから
 * 呼ぶ関数だけで、`BookingAdminWeb.gs`（管理画面）には配線していない。
 *
 * 【初期状態は無効】Script Propertiesの有効化フラグと方針バージョンが両方そろい、かつ同じ方針バージョンで
 * dry-runを実行済みのときだけ消去する。未設定・不正値・方針不一致では何も消さず、無効／設定不備として
 * 件数だけを記録する（無効状態の呼び出しを成功日時として扱わない）。
 * - PERSONAL_DATA_RETENTION_ENABLED: 'true'のときだけ有効（enablePersonalDataRetentionが設定）。
 * - PERSONAL_DATA_RETENTION_POLICY_VERSION: 有効化時に書く。コードのPOLICY_VERSIONと一致しなければ消去しない。
 * - PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: dry-run実行時に書く。POLICY_VERSIONと一致しなければ有効化できない。
 * - PERSONAL_DATA_RETENTION_LAST_RUN / _LAST_SUCCESS_AT: 直近の実行結果（件数のみ。個人情報・ID・行内容なし）。
 * 対象列・起算点・除外条件を変えるときはPOLICY_VERSIONを更新する。更新すると有効化とdry-run確認がやり直しになる。
 *
 * 【消去の方式】対象列のセルだけを1セルずつ空にする。行全体や連続範囲は書き戻さない（読み込み済みの古い
 * 値で他の更新を巻き戻さないため）。行は削除せず、予約ID・日時・金額・状態・決済ID等は残す。残る情報は照合
 * 可能であり、匿名データではない。
 *
 * 【版の履歴は消えない】セルを空にしても、スプレッドシートの版の履歴には旧値が残る。履歴対策は編集権限を
 * 必要最小限にする運用で、消去の完了を意味しない。結果は「現行セルの消去」のみを表す（README参照）。
 *
 * 【排他と限界】消去はバッチ（BATCH_SIZE_行）ごとにAdminのスクリプトロックを取り、ロック取得後に有効化フラグを
 * 読み直し、バッチ内で対象行を予約IDで読み直して同じ判定をやり直してから書く。ロックを共有するのは同じAdminプロジェクト内の処理
 * （予約確定・失効・取消・Webhook処理トリガー等）だけで、公開Web Appとはロックを共有できない。再読込は
 * 別プロジェクトとの原子的な排他にはならない（README「Issue #680」節の残存リスク参照）。
 *
 * 【子シート（PR-2）】FeeSettlements.note / BookingChanges（reason・feeNote・mailError・refundPendingReason と
 * feeDetailsJsonの限定投影）/ Recovery.errorMessageも、親Bookingsの起算日時と自身の終端日時の遅い方から
 * 180日後に同じ方式で消す。自身が未完了・親が未終了／保留中／依存未解決・紐付けなし・曖昧なものは消さない。
 *
 * 【会員系・オプション注文（PR-3）】OptionOrders（親はBookings）、MemberStatusTokens（有効期限）、MemberCheckouts（親はMembers）、
 * Members（退会かつ資格の最終終了から180日。同じメールの未終了の予約があれば消さない）も同じ方式で、メール等だけを消す。
 *
 * 【Stripe受信台帳（PR-4）】StripeEventsのrawBody・outcomeMessageを、終端(COMPLETED/IGNORED/REJECTED)のupdatedAtと、
 * 結び付く予約（bookingId列）または会員（本文のmetadata.memberId/customer/subscription）の終了の遅い方から
 * 180日後に消す。結び付かないものは要確認。
 *
 * 【別シートの未解決記録】Recovery / FeeSettlements / BookingChanges / OptionOrdersに、予約IDで結び付く未解決の
 * 記録がある予約は消さない（読み取りのみ。Bookings側のフラグ保存自体が失敗した複合障害でも保護するため）。
 * これらのシートを読めない場合は判定できないため、何も消さず停止する。
 *
 * 【保留】`RetentionHolds`シート（無ければdry-run・自動実行では作らない）に、予約ID・理由区分・担当・
 * 見直し期限を持つ保留を置ける。有効な保留（resolvedAtが空）がある予約は期限にかかわらず消さない。保留の
 * 解決後は、解決日時から180日を経過するまで消さない（通常の期限と遅い方）。見直し期限の超過は件数で
 * 通知するだけで、自動解除はしない。
 *
 * ログ・記録には件数と区分コードだけを出す。氏名・メール・予約ID・行番号・セル内容は出さない。
 */
'use strict';

var PersonalDataRetention = (function () {
  var POLICY_VERSION = '2026-10-31.4';
  var RETENTION_DAYS = 180;
  var DAY_MS_ = 24 * 60 * 60 * 1000;
  var RETENTION_MS_ = RETENTION_DAYS * DAY_MS_;

  var PROP_ENABLED_ = 'PERSONAL_DATA_RETENTION_ENABLED';
  var PROP_POLICY_VERSION_ = 'PERSONAL_DATA_RETENTION_POLICY_VERSION';
  var PROP_DRY_RUN_VERSION_ = 'PERSONAL_DATA_RETENTION_DRY_RUN_VERSION';
  var PROP_LAST_RUN_ = 'PERSONAL_DATA_RETENTION_LAST_RUN';
  var PROP_LAST_SUCCESS_AT_ = 'PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT';

  var HANDLER_FUNCTION_ = 'purgeExpiredPersonalData';
  var TRIGGER_HOUR_ = 4;
  var TRIGGER_TIMEZONE_ = 'Asia/Tokyo';

  /*
   * 会員IDの接頭辞（MembershipService: 'MBR-' + UUID）。入会処理の失敗・却下の経路は、StripeEventsとRecoveryの
   * bookingId列へ会員IDを記録する（StripeWebhookProcessor.rejectAndFinalize_）。予約ID（ブランド＋日付＋UUID）とは
   * 接頭辞で区別でき、'MBR-'で始まる値は会員IDとして扱う（予約の紐付けの不整合を会員に読み替えない）。
   */
  var MEMBER_ID_PREFIX_ = 'MBR-';

  var BATCH_SIZE_ = 20;
  var MAX_ROWS_DEFAULT_ = 200;
  var TIME_BUDGET_MS_DEFAULT_ = 4 * 60 * 1000;
  var LOCK_TIMEOUT_MS_ = 10000;
  /* 有効化中に、これを超えて実行記録が無ければ「継続的な未実行」として知らせる。 */
  var STALE_RUN_MS_ = 36 * 60 * 60 * 1000;

  /*
   * 180日後に空にするBookingsの列（仕様案: Issue #680 コメント「対象列と起算点の仕様案」C節）。
   * 列名はBookingsSchemaの正本と照合し、列番号の固定や部分一致では消去しない。
   * checkoutAccessToken（決済開始の認証値）はこの段階では扱わない。
   */
  var BOOKINGS_ERASE_COLUMNS_ = [
    'name', 'email', 'phone', 'purpose', 'note',
    'paymentLinkSentTo',
    'lastMailErrorMessage', 'paymentLinkLastErrorMessage',
    'feeSettlementNote', 'feeRecoveryReason',
    'paymentLastErrorMessage', 'paymentRecoveryReason',
    'refundReason',
    'stripeCheckoutRequestSnapshot'
  ];

  var HOLDS_SHEET_ = 'RetentionHolds';
  /*
   * 保留シート。先頭6列は予約単位の保留（bookingId）。7列目memberIdは会員単位の保留（PR-3で追加）。
   * 既存の6列のシートはaddMemberHoldが7列目の見出しだけを追記する（既存の行は変えない）。
   * 会員単位の保留は、保留が必要な会員（入会決済）を明示的にmemberIdで指定する。予約の保留から
   * 同じメールの会員へは暗黙に波及させない（無関係な過去予約で会員情報を一律に残さないため）。
   */
  var HOLDS_BASE_HEADERS_ = ['bookingId', 'reasonCode', 'owner', 'createdAt', 'reviewBy', 'resolvedAt'];
  var HOLDS_HEADERS_ = HOLDS_BASE_HEADERS_.concat(['memberId']);
  var HOLDS_MEMBER_COLUMN_ = HOLDS_BASE_HEADERS_.length;
  var HOLD_REASONS_ = ['DISPUTE', 'INQUIRY', 'REFUND', 'UNPAID', 'OTHER'];

  /*
   * 予約IDで結び付く別シートの未解決記録（保留判定のための読み取り専用。個人情報の消去は子シート定義が別に行う）。
   * Bookings側のフラグだけでは、フラグの保存自体が失敗した複合障害（RecoveryRepository.hasOpenBaselineRecovery
   * と同じ前提）を見落とすため、別シートの記録も参照する。列は名前で引く（追加列は許容、必須列の欠落は停止）。
   * シートが存在しなければ記録なし。ヘッダーを読めない・必須列がない場合は判定できないため消去しない。
   */
  var RELATED_SHEETS_ = [
    {
      sheet: 'Recovery', reason: 'RELATED_RECOVERY_OPEN', columns: ['bookingId', 'recoveryState'],
      unresolved: function (row) { return String(row.recoveryState).trim() !== 'RESOLVED'; }
    },
    {
      sheet: 'FeeSettlements', reason: 'RELATED_SETTLEMENT_UNRESOLVED', columns: ['bookingId', 'applyStatus'],
      unresolved: function (row) { return ['APPLIED', 'ABANDONED'].indexOf(String(row.applyStatus).trim()) === -1; }
    },
    {
      sheet: 'BookingChanges', reason: 'RELATED_RESCHEDULE_UNRESOLVED', columns: ['bookingId', 'mailState'],
      unresolved: function (row) { return ['PREPARED', 'RECOVERY_REQUIRED'].indexOf(String(row.mailState).trim()) !== -1; }
    },
    {
      sheet: 'OptionOrders', reason: 'RELATED_OPTION_ORDER_UNRESOLVED', columns: ['bookingId', 'status', 'paymentRecoveryRequiredAt'],
      unresolved: function (row) {
        return ['CONFIRMED', 'DECLINED', 'CANCELLED'].indexOf(String(row.status).trim()) === -1 ||
          !isBlank_(row.paymentRecoveryRequiredAt);
      }
    }
  ];

  /*
   * 子シート（Issue #680 PR-2）。予約IDでBookings行に結び付く記録のうち、自由記述（個人情報が入り得る列）を
   * 持つもの。列は名前で引く（追加列は許容、必須列の欠落はシート全体の停止）。行は削除せず、消すのは
   * eraseColumnsのセルと、projectColumn（feeDetailsJson）の自由記述キーだけ。ID・状態・金額・日時は残す。
   * 起算点は「親Bookingsの起算日時」と「自身の終端日時」の遅い方（updatedAt等で代用しない）。
   * 自身が未完了（own.kind=OPEN）、親が未終了・保留中・依存が未解決のものは消さない。
   */
  var CHILD_SHEETS_ = [
    {
      name: 'FeeSettlements',
      columns: ['settlementId', 'bookingId', 'note', 'applyStatus', 'appliedAt'],
      eraseColumns: ['note'],
      projectColumn: '',
      keyOf: function (record) { return trimText_(record.settlementId); },
      /* APPLIED / ABANDONEDは終端（どちらもappliedAtを記録する）。未完了の精算は消さない。 */
      own: function (record) {
        var state = trimText_(record.applyStatus);
        if (state === 'PENDING_APPLY' || state === 'FAILED_NEEDS_RECOVERY') return { kind: 'OPEN', reason: 'SETTLEMENT_UNRESOLVED' };
        if (state !== 'APPLIED' && state !== 'ABANDONED') return { kind: 'REVIEW', reason: 'APPLY_STATUS_UNKNOWN' };
        var ms = parseStrictMillis_(record.appliedAt);
        return isNaN(ms) ? { kind: 'REVIEW', reason: 'OWN_DATE_INVALID' } : { kind: 'TERMINAL', ms: ms };
      }
    },
    {
      name: 'BookingChanges',
      columns: ['changeId', 'bookingId', 'changedAt', 'mailState', 'mailAt', 'refundApprovedAt',
        'reason', 'feeNote', 'mailError', 'refundPendingReason', 'feeDetailsJson'],
      eraseColumns: ['reason', 'feeNote', 'mailError', 'refundPendingReason'],
      /* feeDetailsJsonは全文を消さず、構造化された金額区分等だけを残す限定投影にする（projectFeeDetails_）。 */
      projectColumn: 'feeDetailsJson',
      keyOf: function (record) { return trimText_(record.changeId); },
      /* SENT / ROLLED_BACK / CHANGE_FAILEDは終端。PREPARED（確定前・結果不明）とRECOVERY_REQUIREDは未完了。 */
      own: function (record) {
        var state = trimText_(record.mailState);
        if (state === 'PREPARED' || state === 'RECOVERY_REQUIRED') return { kind: 'OPEN', reason: 'RESCHEDULE_UNRESOLVED' };
        if (['SENT', 'ROLLED_BACK', 'CHANGE_FAILED'].indexOf(state) === -1) return { kind: 'REVIEW', reason: 'MAIL_STATE_UNKNOWN' };
        var ms = parseStrictMillis_(record.changedAt);
        if (isNaN(ms)) return { kind: 'REVIEW', reason: 'OWN_DATE_INVALID' };
        var invalid = false;
        ['mailAt', 'refundApprovedAt'].forEach(function (column) {
          if (isBlank_(record[column])) return;
          var value = parseStrictMillis_(record[column]);
          if (isNaN(value)) invalid = true;
          else ms = Math.max(ms, value);
        });
        return invalid ? { kind: 'REVIEW', reason: 'OWN_DATE_INVALID' } : { kind: 'TERMINAL', ms: ms };
      }
    },
    {
      name: 'Recovery',
      columns: ['bookingId', 'failureType', 'occurredAt', 'calendarEventId', 'errorMessage', 'recoveryState', 'resolvedAt'],
      eraseColumns: ['errorMessage'],
      projectColumn: '',
      /* 入会処理の失敗は、bookingId列へ会員IDを記録する（MBR-で始まる値は親をMembersとして扱う）。 */
      memberIdLinked: true,
      /* 行ごとの一意なIDがないため、(予約ID, 障害種別, 発生日時, CalendarイベントID)の組を識別子にする。重複は要確認。 */
      keyOf: function (record) {
        if (isBlank_(record.failureType) && isBlank_(record.occurredAt)) return '';
        var occurred = isDateLike_(record.occurredAt) ? String(record.occurredAt.getTime()) : trimText_(record.occurredAt);
        return [trimText_(record.bookingId), trimText_(record.failureType), occurred, trimText_(record.calendarEventId)].join('\u0001');
      },
      /* RESOLVEDで解決日時が有効なものだけ終端。それ以外（OPEN・空欄・未知）は未解決として扱う。 */
      own: function (record) {
        if (trimText_(record.recoveryState) !== 'RESOLVED') return { kind: 'OPEN', reason: 'RECOVERY_OPEN' };
        var ms = parseStrictMillis_(record.resolvedAt);
        return isNaN(ms)
          ? { kind: 'REVIEW', reason: isBlank_(record.resolvedAt) ? 'OWN_DATE_MISSING' : 'OWN_DATE_INVALID' }
          : { kind: 'TERMINAL', ms: ms };
      }
    },
    {
      /* オプション注文（Issue #423）。親Bookingsに結び付く。顧客メール・不承認理由・Checkout要求・復旧理由を消す。 */
      name: 'OptionOrders',
      columns: ['optionOrderId', 'bookingId', 'status', 'paymentRecoveryRequiredAt', 'approvedAt', 'declinedAt', 'paidAt', 'createdAt',
        'category', 'amountJpy', 'approvalStatus', 'paymentStatus',
        'customerEmail', 'declineReason', 'checkoutRequestJson', 'paymentRecoveryReason'],
      eraseColumns: ['customerEmail', 'declineReason', 'checkoutRequestJson', 'paymentRecoveryReason'],
      projectColumn: '',
      keyOf: function (record) { return trimText_(record.optionOrderId); },
      /*
       * 終端はCONFIRMED / DECLINED。終端日時はapprovedAt・declinedAt・paidAtの最も遅い日時（updatedAtでは推測しない）。
       * 作成時に確定する無料の注文（カテゴリFREE・金額0・承認不要・決済不要。BookingOptionsの生成条件と同じ）は
       * この3つがすべて空のため、その場合に限り作成日時を確定日時とする。有料または条件に合わない注文で
       * 3つが欠落している場合は、終端日時を決められず要確認にする。
       * CANCELLEDは現行コードが書かず、取消日時の列もないため、終端日時を決められず要確認にする。
       */
      own: function (record) {
        if (!isBlank_(record.paymentRecoveryRequiredAt)) return { kind: 'OPEN', reason: 'OPTION_RECOVERY_OPEN' };
        var state = trimText_(record.status);
        if (['PENDING_APPROVAL', 'AWAITING_PAYMENT', 'PAYMENT_PENDING'].indexOf(state) !== -1) {
          return { kind: 'OPEN', reason: 'OPTION_ORDER_UNRESOLVED' };
        }
        if (state === 'CANCELLED') return { kind: 'REVIEW', reason: 'OWN_DATE_MISSING' };
        if (state !== 'CONFIRMED' && state !== 'DECLINED') return { kind: 'REVIEW', reason: 'ORDER_STATUS_UNKNOWN' };
        var ms = NaN;
        var invalid = false;
        ['approvedAt', 'declinedAt', 'paidAt'].forEach(function (column) {
          if (isBlank_(record[column])) return;
          var value = parseStrictMillis_(record[column]);
          if (isNaN(value)) invalid = true;
          else ms = isNaN(ms) ? value : Math.max(ms, value);
        });
        if (invalid) return { kind: 'REVIEW', reason: 'OWN_DATE_INVALID' };
        if (isNaN(ms) && state === 'CONFIRMED' && isFreeOrderConfirmedAtCreation_(record)) ms = parseStrictMillis_(record.createdAt);
        return isNaN(ms) ? { kind: 'REVIEW', reason: 'OWN_DATE_MISSING' } : { kind: 'TERMINAL', ms: ms };
      }
    },
    {
      /*
       * 会員状態ページ用のワンタイムトークン台帳。親はなく、有効期限の経過後180日で、メールとハッシュを消す。
       * 行の識別子であるtokenHashは最後に消す（途中で失敗しても、次回の実行で同じ行を引き直せるように）。
       */
      name: 'MemberStatusTokens',
      columns: ['tokenHash', 'email', 'expiresAt'],
      eraseColumns: ['email', 'tokenHash'],
      projectColumn: '',
      standalone: true,
      keyOf: function (record) { return trimText_(record.tokenHash); },
      classify: function (definition, record, ctx) {
        var plan = planChildWrites_(definition, record);
        if (plan.writes.length === 0) return { verdict: VERDICT.ALREADY_CLEAR, reason: 'ALREADY_CLEAR' };
        var key = definition.keyOf(record);
        if (!key) return { verdict: VERDICT.REVIEW, reason: 'INVALID_KEY' };
        if (ctx.duplicateKeys && ctx.duplicateKeys[key]) return { verdict: VERDICT.REVIEW, reason: 'DUPLICATE_KEY' };
        var expiresMs = parseStrictMillis_(record.expiresAt);
        if (isNaN(expiresMs)) return { verdict: VERDICT.REVIEW, reason: isBlank_(record.expiresAt) ? 'BASIS_MISSING' : 'BASIS_INVALID' };
        if (ctx.nowMs < expiresMs + RETENTION_MS_) return { verdict: VERDICT.NOT_DUE, reason: 'NOT_DUE' };
        return { verdict: VERDICT.ELIGIBLE, reason: 'ELIGIBLE', writes: plan.writes };
      }
    },
    {
      /*
       * 入会Checkoutの保留台帳。親はMembers（memberIdで結び付く）。メールだけを消す。
       * EXPIRED、およびpendingUntilを過ぎても会員行が作られていないPENDING（放棄された入会）はpendingUntilから180日。
       * COMPLETED、およびpendingUntilを過ぎて会員行があるPENDINGは、会員側の終了（Membersと同じ条件）から180日。
       */
      name: 'MemberCheckouts',
      columns: ['memberId', 'email', 'checkoutSessionId', 'pendingUntil', 'state'],
      eraseColumns: ['email'],
      projectColumn: '',
      standalone: true,
      keyOf: function (record) {
        if (isBlank_(record.memberId)) return '';
        return trimText_(record.memberId) + '\u0001' + trimText_(record.checkoutSessionId);
      },
      classify: function (definition, record, ctx) {
        var key = definition.keyOf(record);
        if (!key) return { verdict: VERDICT.REVIEW, reason: 'INVALID_KEY' };
        if (ctx.duplicateKeys && ctx.duplicateKeys[key]) return { verdict: VERDICT.REVIEW, reason: 'DUPLICATE_KEY' };
        var plan = planChildWrites_(definition, record);
        if (plan.writes.length === 0) return { verdict: VERDICT.ALREADY_CLEAR, reason: 'ALREADY_CLEAR' };

        var state = trimText_(record.state);
        var pendingMs = parseStrictMillis_(record.pendingUntil);
        var memberId = trimText_(record.memberId);
        var member = ctx.membersById ? ctx.membersById[memberId] : null;
        var needsMember;
        if (state === 'COMPLETED') {
          needsMember = true;
        } else if (state === 'EXPIRED') {
          needsMember = false;
        } else if (state === 'PENDING') {
          if (isNaN(pendingMs)) return { verdict: VERDICT.REVIEW, reason: 'BASIS_INVALID' };
          if (pendingMs > ctx.nowMs) return { verdict: VERDICT.HELD, reason: 'CHECKOUT_PENDING' };
          needsMember = !!member;
        } else {
          return { verdict: VERDICT.REVIEW, reason: 'CHECKOUT_STATE_UNKNOWN' };
        }

        var basisMs;
        if (needsMember) {
          if (!member) return { verdict: VERDICT.REVIEW, reason: 'MEMBER_NOT_FOUND' };
          if (member.duplicate) return { verdict: VERDICT.REVIEW, reason: 'MEMBER_AMBIGUOUS' };
          var terminal = memberTerminal_(member.record, ctx);
          if (!terminal.ok) return terminal.outcome;
          basisMs = terminal.endMs;
          if (!isNaN(pendingMs)) basisMs = Math.max(basisMs, pendingMs);
        } else {
          if (isNaN(pendingMs)) return { verdict: VERDICT.REVIEW, reason: isBlank_(record.pendingUntil) ? 'BASIS_MISSING' : 'BASIS_INVALID' };
          basisMs = pendingMs;
        }
        var checkoutHeld = applyMemberHold_(basisMs, memberId, ctx);
        if (checkoutHeld) return checkoutHeld;
        return { verdict: VERDICT.ELIGIBLE, reason: 'ELIGIBLE', writes: plan.writes };
      }
    },
    {
      /*
       * 会員台帳（Stripe subscriptionの写し）。メールだけを消す（Stripe ID・状態・期間は残す）。
       * 退会（status=canceled）かつ、退会日時・現在の期間終了・支払済みPeriod・旧MemberMonthsの最も遅い日時から180日。
       * 有効・支払い遅延・未完了の会員、同じメールの将来予約／未終了の予約がある会員は消さない。
       * canceledは終端でMembers.applyState_がメールを補完しない（再補完で復活しない）。
       */
      name: 'Members',
      columns: ['memberId', 'email', 'status', 'currentPeriodEnd', 'canceledAt', 'stripeSubscriptionId', 'stripeCustomerId'],
      eraseColumns: ['email'],
      projectColumn: '',
      standalone: true,
      keyOf: function (record) { return trimText_(record.memberId); },
      classify: function (definition, record, ctx) {
        var key = definition.keyOf(record);
        if (!key) return { verdict: VERDICT.REVIEW, reason: 'INVALID_KEY' };
        if (ctx.duplicateKeys && ctx.duplicateKeys[key]) return { verdict: VERDICT.REVIEW, reason: 'DUPLICATE_KEY' };
        var plan = planChildWrites_(definition, record);
        if (plan.writes.length === 0) return { verdict: VERDICT.ALREADY_CLEAR, reason: 'ALREADY_CLEAR' };
        var terminal = memberTerminal_(record, ctx);
        if (!terminal.ok) return terminal.outcome;
        var memberHeld = applyMemberHold_(terminal.endMs, key, ctx);
        if (memberHeld) return memberHeld;
        var email = MembershipRules.normalizeEmail(String(record.email));
        if (email && ctx.activeBookingEmails && ctx.activeBookingEmails[email]) {
          return { verdict: VERDICT.HELD, reason: 'ACTIVE_BOOKING_EXISTS' };
        }
        return { verdict: VERDICT.ELIGIBLE, reason: 'ELIGIBLE', writes: plan.writes };
      }
    },
    {
      /*
       * Stripe Webhookの受信台帳。イベント本文(rawBody)と結果メッセージだけを消す（eventId・種別・状態・予約ID・
       * 決済試行ID・PaymentIntent ID・結果コード・日時は、冪等性と照合のために残す）。
       * 終端はCOMPLETED / IGNORED / REJECTEDで、終端日時はupdatedAt。終端の行のupdatedAtを書くのは
       * finalize／finalizeForProcessingだけで、終端の行は再受信されてもclaim()がALREADY_TERMINALを返して
       * 書き換えない（StripeEventRepository参照。回帰テストあり）ため、終端日時として使える。
       * 予約IDの列があれば親Bookingsに、なければ本文から特定した会員に結び付ける。結び付かないものは要確認。
       * rawBodyを読むのは未処理(RECEIVED)イベントの処理だけで、終端の行の本文は再処理に使われない。
       */
      name: 'StripeEvents',
      columns: ['eventId', 'processingState', 'bookingId', 'updatedAt', 'rawBody', 'outcomeMessage'],
      /* 会員への結び付けに使うrawBodyは最後に消す（途中で失敗しても、次回に同じ期限・保留条件で再開できるように）。 */
      eraseColumns: ['outcomeMessage', 'rawBody'],
      projectColumn: '',
      memberIdLinked: true,
      keyOf: function (record) { return trimText_(record.eventId); },
      own: function (record) {
        var state = trimText_(record.processingState);
        if (state === 'RECEIVED') return { kind: 'OPEN', reason: 'EVENT_UNPROCESSED' };
        if (['COMPLETED', 'IGNORED', 'REJECTED'].indexOf(state) === -1) return { kind: 'REVIEW', reason: 'EVENT_STATE_UNKNOWN' };
        var ms = parseStrictMillis_(record.updatedAt);
        return isNaN(ms)
          ? { kind: 'REVIEW', reason: isBlank_(record.updatedAt) ? 'OWN_DATE_MISSING' : 'OWN_DATE_INVALID' }
          : { kind: 'TERMINAL', ms: ms };
      },
      classify: function (definition, record, ctx) {
        var key = definition.keyOf(record);
        if (!key) return { verdict: VERDICT.REVIEW, reason: 'INVALID_KEY' };
        if (ctx.duplicateKeys && ctx.duplicateKeys[key]) return { verdict: VERDICT.REVIEW, reason: 'DUPLICATE_KEY' };
        var plan = planChildWrites_(definition, record);
        if (plan.writes.length === 0) return { verdict: VERDICT.ALREADY_CLEAR, reason: 'ALREADY_CLEAR' };
        if (!isBlank_(record.bookingId)) return classifyLinked_(definition, record, trimText_(record.bookingId), plan, ctx);
        return classifyMemberLinkedEvent_(definition, record, plan, ctx);
      }
    }
  ];

  /*
   * 作成時に確定する無料のオプション注文か。BookingOptions.planOrders（無料枠）が作る注文と同じ条件:
   * category=FREE・amountJpy=0・approvalStatus=NOT_REQUIRED・paymentStatus=NOT_REQUIRED。
   */
  function isFreeOrderConfirmedAtCreation_(record) {
    return trimText_(record.category) === 'FREE' &&
      !isBlank_(record.amountJpy) && Number(record.amountJpy) === 0 &&
      trimText_(record.approvalStatus) === 'NOT_REQUIRED' &&
      trimText_(record.paymentStatus) === 'NOT_REQUIRED';
  }

  /* feeDetailsJsonに残してよいキーと値の形。これ以外（manualNote等の自由記述・未知のキー）は投影で落とす。 */
  var FEE_DETAILS_BRAND_ = /^[a-z_]{1,20}$/;
  var FEE_DETAILS_DAY_TYPE_ = /^[A-Z_]{1,30}$/;

  var OPEN_FEE_SETTLEMENT_STATES_ = ['PENDING_CHARGE', 'PENDING_REFUND', 'PENDING_DECISION'];
  var KNOWN_FEE_SETTLEMENT_STATES_ = ['', 'SETTLED'].concat(OPEN_FEE_SETTLEMENT_STATES_);
  var OPEN_CHECKOUT_CANCEL_STATES_ = ['EXPIRE_REQUESTED', 'UNKNOWN', 'PAYMENT_RECEIVED'];
  var KNOWN_CHECKOUT_CANCEL_STATES_ = ['', 'EXPIRED', 'NO_SESSION'].concat(OPEN_CHECKOUT_CANCEL_STATES_);

  var VERDICT = {
    ELIGIBLE: 'ELIGIBLE',
    NOT_DUE: 'NOT_DUE',
    ALREADY_CLEAR: 'ALREADY_CLEAR',
    PENDING: 'PENDING',
    HELD: 'HELD',
    REVIEW: 'REVIEW'
  };

  var ISO_WITH_OFFSET_ = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function isBlank_(value) {
    return value === undefined || value === null || String(value).trim() === '';
  }

  function isLeapYear_(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  function daysInMonth_(year, month) {
    if (month === 2) return isLeapYear_(year) ? 29 : 28;
    return [4, 6, 9, 11].indexOf(month) !== -1 ? 30 : 31;
  }

  /*
   * 起算点・保留に使う日時は、有効なDate、またはタイムゾーンを明示したISO 8601文字列だけを受け付ける。
   * 文字列は書式に加えて暦日・時刻・オフセットの範囲も検証する（Date.parseは2月30日等を補正して
   * 受け付けるため、書式の一致だけでは不十分）。空欄・不正・タイムゾーン不明の文字列・数値は
   * 暗黙変換せずNaN（＝要確認）にする。
   */
  function parseStrictMillis_(value) {
    if (isDateLike_(value)) return value.getTime();
    if (typeof value !== 'string') return NaN;
    var text = value.trim();
    var match = ISO_WITH_OFFSET_.exec(text);
    if (!match) return NaN;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var hour = Number(match[4]);
    var minute = Number(match[5]);
    var second = match[6] === undefined ? 0 : Number(match[6]);
    if (month < 1 || month > 12) return NaN;
    if (day < 1 || day > daysInMonth_(year, month)) return NaN;
    if (hour > 23 || minute > 59 || second > 59) return NaN;
    if (match[7] !== undefined && (Number(match[7]) > 23 || Number(match[8]) > 59)) return NaN;
    var parsed = Date.parse(text);
    return isNaN(parsed) ? NaN : parsed;
  }

  function trimText_(value) {
    return isBlank_(value) ? '' : String(value).trim();
  }

  /*
   * BookingChanges.feeDetailsJsonの限定投影。JSONを解析し、構造化された区分値（料金区分・ブランド・曜日区分・
   * 丸め後の分数・手動フラグ・確定フラグ）だけを固定順で残す。manualNote・pendingReason等の自由記述と
   * 未知のキーは落とす。解析できないものはnull（呼び出し側で要確認）。投影済みの値に再適用しても変わらない。
   */
  function projectFeeDetails_(text) {
    var parsed;
    try {
      parsed = JSON.parse(String(text));
    } catch (error) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    var kept = {};
    if (parsed.priceTier === 'GENERAL' || parsed.priceTier === 'MEMBER') kept.priceTier = parsed.priceTier;
    if (typeof parsed.brand === 'string' && FEE_DETAILS_BRAND_.test(parsed.brand)) kept.brand = parsed.brand;
    if (typeof parsed.dayType === 'string' && FEE_DETAILS_DAY_TYPE_.test(parsed.dayType)) kept.dayType = parsed.dayType;
    if (typeof parsed.roundedMinutes === 'number' && isFinite(parsed.roundedMinutes)) kept.roundedMinutes = parsed.roundedMinutes;
    if (typeof parsed.manual === 'boolean') kept.manual = parsed.manual;
    if (typeof parsed.feeConfirmed === 'boolean') kept.feeConfirmed = parsed.feeConfirmed;
    return JSON.stringify(kept);
  }

  function increment_(map, key) {
    map[key] = (map[key] || 0) + 1;
  }

  function newChildCounts_() {
    return {
      scanned: 0, eligible: 0, notDue: 0, alreadyClear: 0, held: {}, review: {},
      erasedRows: 0, cellsCleared: 0, recheckSkipped: 0
    };
  }

  function newCounts_() {
    var counts = {
      scanned: 0, eligible: 0, notDue: 0, alreadyClear: 0, pending: 0,
      held: {}, review: {}, holdReviewOverdue: 0,
      erasedRows: 0, cellsCleared: 0, recheckSkipped: 0, failed: 0, truncated: false,
      children: {}
    };
    CHILD_SHEETS_.forEach(function (definition) { counts.children[definition.name] = newChildCounts_(); });
    return counts;
  }

  function indexOfColumns_(headers, names) {
    return names.map(function (name) { return headers.indexOf(name); });
  }

  /* シートのヘッダー行がBookingsSchemaの正本の先頭一致で、対象列をすべて含むかを返す。 */
  function checkBookingsHeader_(headerRow) {
    var expected = BookingsSchema.HEADERS;
    var actual = (headerRow || []).map(function (cell) { return String(cell === undefined || cell === null ? '' : cell); });
    while (actual.length > 0 && actual[actual.length - 1] === '') actual.pop();
    if (actual.length > expected.length) return { ok: false, code: 'HEADER_UNKNOWN_COLUMNS' };
    for (var i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) return { ok: false, code: 'HEADER_MISMATCH' };
    }
    for (var c = 0; c < BOOKINGS_ERASE_COLUMNS_.length; c++) {
      var index = expected.indexOf(BOOKINGS_ERASE_COLUMNS_[c]);
      if (index === -1) return { ok: false, code: 'HEADER_SCHEMA_MISSING_TARGET' };
      if (index >= actual.length) return { ok: false, code: 'HEADER_MISSING_TARGET' };
    }
    return { ok: true, columnCount: actual.length };
  }

  function rowToRecord_(row, columnCount) {
    var record = {};
    BookingsSchema.HEADERS.forEach(function (header, index) {
      record[header] = index < columnCount ? row[index] : '';
    });
    return record;
  }

  /*
   * 保留シートの行を予約IDごとにまとめる。resolvedAtが空の保留は有効（active）。resolvedAtが
   * あっても解釈できない場合は有効扱い（invalid）にして消さない。
   * 戻り値: { byBookingId, byMemberId: { id: { active, invalid, latestResolvedMs } }, overdueCount }
   */
  function summarizeHolds_(holdRows, nowMs) {
    var byBookingId = {};
    var byMemberId = {};
    var overdueCount = 0;
    holdRows.forEach(function (row) {
      var bookingKey = trimText_(row[0]);
      var memberKey = row.length > HOLDS_MEMBER_COLUMN_ ? trimText_(row[HOLDS_MEMBER_COLUMN_]) : '';
      if (!bookingKey && !memberKey) return;
      var entries = [];
      if (bookingKey) entries.push(byBookingId[bookingKey] || (byBookingId[bookingKey] = { active: false, invalid: false, latestResolvedMs: NaN }));
      if (memberKey) entries.push(byMemberId[memberKey] || (byMemberId[memberKey] = { active: false, invalid: false, latestResolvedMs: NaN }));
      if (isBlank_(row[5])) {
        entries.forEach(function (entry) { entry.active = true; });
        var reviewMs = parseStrictMillis_(row[4]);
        if (isNaN(reviewMs) || reviewMs < nowMs) overdueCount++;
        return;
      }
      var resolvedMs = parseStrictMillis_(row[5]);
      entries.forEach(function (entry) {
        if (isNaN(resolvedMs)) {
          entry.active = true;
          entry.invalid = true;
        } else if (isNaN(entry.latestResolvedMs) || resolvedMs > entry.latestResolvedMs) {
          entry.latestResolvedMs = resolvedMs;
        }
      });
    });
    return { byBookingId: byBookingId, byMemberId: byMemberId, overdueCount: overdueCount };
  }

  /* 起算日時を持つ列。CONFIRMED=最新のendAt / CANCELLED=cancelledAt / EXPIRED=expiredAt。PENDING・未知は''。 */
  function basisColumnFor_(status) {
    return status === Booking.STATUS.CONFIRMED ? 'endAt'
      : status === Booking.STATUS.CANCELLED ? 'cancelledAt'
        : status === Booking.STATUS.EXPIRED ? 'expiredAt' : '';
  }

  /*
   * 1行の判定。純粋関数（シート・時刻に触れない）。
   * ctx: { nowMs, holdsByBookingId, duplicateIds, relatedByBookingId }
   * 戻り値: { verdict, reason?, clearColumns? }。reasonは件数集計用の区分コード。
   */
  function classifyBookingRecord(record, ctx) {
    var bookingId = isBlank_(record.bookingId) ? '' : String(record.bookingId).trim();
    if (!bookingId) return { verdict: VERDICT.REVIEW, reason: 'INVALID_BOOKING_ID' };
    if (ctx.duplicateIds && ctx.duplicateIds[bookingId]) return { verdict: VERDICT.REVIEW, reason: 'DUPLICATE_BOOKING_ID' };

    var status = String(record.status === undefined || record.status === null ? '' : record.status).trim();
    if (status === Booking.STATUS.PENDING) return { verdict: VERDICT.PENDING, reason: 'PENDING_STATUS' };
    var basisColumn = basisColumnFor_(status);
    if (!basisColumn) return { verdict: VERDICT.REVIEW, reason: 'UNKNOWN_STATUS' };

    var clearColumns = BOOKINGS_ERASE_COLUMNS_.filter(function (column) { return !isBlank_(record[column]); });
    if (clearColumns.length === 0) return { verdict: VERDICT.ALREADY_CLEAR, reason: 'ALREADY_CLEAR' };

    var basisMs = parseStrictMillis_(record[basisColumn]);
    if (isNaN(basisMs)) {
      return { verdict: VERDICT.REVIEW, reason: isBlank_(record[basisColumn]) ? 'BASIS_MISSING' : 'BASIS_INVALID' };
    }
    var dueMs = basisMs + RETENTION_MS_;

    var hold = ctx.holdsByBookingId ? ctx.holdsByBookingId[bookingId] : null;
    if (hold && !isNaN(hold.latestResolvedMs)) dueMs = Math.max(dueMs, hold.latestResolvedMs + RETENTION_MS_);
    if (ctx.nowMs < dueMs) return { verdict: VERDICT.NOT_DUE, reason: 'NOT_DUE' };

    if (hold && hold.invalid) return { verdict: VERDICT.HELD, reason: 'HOLD_RECORD_INVALID' };
    if (hold && hold.active) return { verdict: VERDICT.HELD, reason: 'HOLD_ACTIVE' };
    var relatedReason = ctx.relatedByBookingId ? ctx.relatedByBookingId[bookingId] : '';
    if (relatedReason) return { verdict: VERDICT.HELD, reason: relatedReason };

    var dependency = checkDependencies_(record);
    if (dependency) return dependency;
    return { verdict: VERDICT.ELIGIBLE, reason: 'ELIGIBLE', clearColumns: clearColumns };
  }

  /* 期限を過ぎていても、決済・返金・精算・復旧が終わっていない予約は消さない。 */
  function checkDependencies_(record) {
    var paymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    if (paymentStatus === null) return { verdict: VERDICT.REVIEW, reason: 'PAYMENT_STATUS_UNKNOWN' };
    if (paymentStatus === Booking.PAYMENT_STATUS.CHECKOUT_PENDING || paymentStatus === Booking.PAYMENT_STATUS.REFUND_PENDING) {
      return { verdict: VERDICT.HELD, reason: 'PAYMENT_UNRESOLVED' };
    }
    if (!isBlank_(record.paymentAttemptId) && isBlank_(record.paymentAttemptResolvedAt)) {
      return { verdict: VERDICT.HELD, reason: 'PAYMENT_ATTEMPT_UNRESOLVED' };
    }
    if (!isBlank_(record.paymentRecoveryRequiredAt)) return { verdict: VERDICT.HELD, reason: 'PAYMENT_RECOVERY_OPEN' };
    if (!isBlank_(record.feeRecoveryRequiredAt)) return { verdict: VERDICT.HELD, reason: 'FEE_RECOVERY_OPEN' };
    if (!isBlank_(record.paymentLinkSendUnconfirmedAt) || !isBlank_(record.paymentLinkMetadataInconsistentAt)) {
      return { verdict: VERDICT.HELD, reason: 'PAYMENT_LINK_INCONSISTENT' };
    }

    var settlement = isBlank_(record.feeSettlementState) ? '' : String(record.feeSettlementState).trim();
    if (KNOWN_FEE_SETTLEMENT_STATES_.indexOf(settlement) === -1) return { verdict: VERDICT.REVIEW, reason: 'FEE_SETTLEMENT_STATE_UNKNOWN' };
    if (OPEN_FEE_SETTLEMENT_STATES_.indexOf(settlement) !== -1) return { verdict: VERDICT.HELD, reason: 'FEE_SETTLEMENT_PENDING' };

    var checkoutCancel = isBlank_(record.checkoutCancelState) ? '' : String(record.checkoutCancelState).trim();
    if (KNOWN_CHECKOUT_CANCEL_STATES_.indexOf(checkoutCancel) === -1) return { verdict: VERDICT.REVIEW, reason: 'CHECKOUT_CANCEL_STATE_UNKNOWN' };
    if (OPEN_CHECKOUT_CANCEL_STATES_.indexOf(checkoutCancel) !== -1) return { verdict: VERDICT.HELD, reason: 'CHECKOUT_CANCEL_UNRESOLVED' };

    /* 返金: 試行があるなら、Stripeが受け付けて返金完了日時が有効なときだけ解決済み。決定済み（全額・一部）なのに
       試行が始まっていない場合も未解決。 */
    var refundAttempt = isBlank_(record.refundAttemptState) ? '' : String(record.refundAttemptState).trim();
    var refundCompleted = !isNaN(parseStrictMillis_(record.refundedAt));
    if (refundAttempt) {
      if (!(refundAttempt === 'SUBMITTED' && refundCompleted)) return { verdict: VERDICT.HELD, reason: 'REFUND_UNRESOLVED' };
    } else if ((record.refundDecision === 'FULL' || record.refundDecision === 'PARTIAL') && !refundCompleted) {
      return { verdict: VERDICT.HELD, reason: 'REFUND_UNRESOLVED' };
    }
    return null;
  }

  /* 会員の利用資格の終了日時の列挙に使う。Date、またはタイムゾーン明示のISO文字列だけを受け付ける。 */
  function memberMonthEndMs_(value) {
    var month = Number(value);
    if (!isFinite(month) || month !== Math.floor(month)) return NaN;
    var year = Math.floor(month / 100);
    var monthOfYear = month % 100;
    if (year < 2000 || year > 2999 || monthOfYear < 1 || monthOfYear > 12) return NaN;
    /* 利用月（JST）の末日の終わり = 翌月1日0時（JST）。 */
    return Date.UTC(year, monthOfYear, 1, 0, 0, 0) - 9 * 60 * 60 * 1000;
  }

  /*
   * 会員行が消去できる終端にあるかを判定する。戻り値: { ok:true, endMs } | { ok:false, outcome }。
   * 退会（canceled）のみ終端。endMsは退会日時・現在の期間終了・支払済みPeriod・旧MemberMonthsの最も遅い日時。
   * いずれかの日時が空欄でない不正値なら要確認（推測しない）。
   */
  function memberTerminal_(member, ctx) {
    var status = trimText_(member.status);
    if (status === 'active' || status === 'past_due' || status === 'incomplete') {
      return { ok: false, outcome: { verdict: VERDICT.HELD, reason: 'MEMBER_NOT_ENDED' } };
    }
    if (status !== 'canceled') return { ok: false, outcome: { verdict: VERDICT.REVIEW, reason: 'MEMBER_STATUS_UNKNOWN' } };
    var endMs = parseStrictMillis_(member.canceledAt);
    if (isNaN(endMs)) return { ok: false, outcome: { verdict: VERDICT.REVIEW, reason: 'MEMBER_CANCELED_AT_INVALID' } };
    if (!isBlank_(member.currentPeriodEnd)) {
      var periodEnd = parseStrictMillis_(member.currentPeriodEnd);
      if (isNaN(periodEnd)) return { ok: false, outcome: { verdict: VERDICT.REVIEW, reason: 'MEMBER_PERIOD_INVALID' } };
      endMs = Math.max(endMs, periodEnd);
    }
    var memberId = trimText_(member.memberId);
    var subscriptionId = trimText_(member.stripeSubscriptionId);
    var periods = (ctx.periodsByMemberId && ctx.periodsByMemberId[memberId]) || [];
    if (subscriptionId && ctx.periodsBySubscriptionId && ctx.periodsBySubscriptionId[subscriptionId]) {
      periods = periods.concat(ctx.periodsBySubscriptionId[subscriptionId]);
    }
    for (var i = 0; i < periods.length; i++) {
      var end = parseStrictMillis_(periods[i]);
      if (isNaN(end)) return { ok: false, outcome: { verdict: VERDICT.REVIEW, reason: 'MEMBER_PERIOD_INVALID' } };
      endMs = Math.max(endMs, end);
    }
    var months = (ctx.monthsByMemberId && ctx.monthsByMemberId[memberId]) || [];
    for (var m = 0; m < months.length; m++) {
      var monthEnd = memberMonthEndMs_(months[m]);
      if (isNaN(monthEnd)) return { ok: false, outcome: { verdict: VERDICT.REVIEW, reason: 'MEMBER_MONTH_INVALID' } };
      endMs = Math.max(endMs, monthEnd);
    }
    return { ok: true, endMs: endMs };
  }

  /*
   * 会員単位の保留（memberId）を反映した判定。baseMsは会員の終了日時等の起算点。
   * 戻り値: null（続行可）| outcome（NOT_DUE / HELD）。解決済みの保留は、解決日時から180日まで消さない（遅い方）。
   */
  function applyMemberHold_(baseMs, memberId, ctx) {
    var hold = ctx.memberHoldsById ? ctx.memberHoldsById[memberId] : null;
    var dueMs = baseMs + RETENTION_MS_;
    if (hold && !isNaN(hold.latestResolvedMs)) dueMs = Math.max(dueMs, hold.latestResolvedMs + RETENTION_MS_);
    if (ctx.nowMs < dueMs) return { verdict: VERDICT.NOT_DUE, reason: 'NOT_DUE' };
    if (hold && hold.invalid) return { verdict: VERDICT.HELD, reason: 'HOLD_RECORD_INVALID' };
    if (hold && hold.active) return { verdict: VERDICT.HELD, reason: 'HOLD_ACTIVE' };
    /* 入会処理の失敗は、RecoveryのbookingId列へ会員IDを記録する。その会員IDで未解決の記録があれば消さない。 */
    var relatedReason = ctx.relatedByBookingId ? ctx.relatedByBookingId[memberId] : '';
    if (relatedReason) return { verdict: VERDICT.HELD, reason: relatedReason };
    return null;
  }

  /* 子シートの消去計画。戻り値: { ok, reason?, writes: [{ column, value }] }。解析できないJSONは要確認。 */
  function planChildWrites_(definition, record) {
    var writes = [];
    definition.eraseColumns.forEach(function (column) {
      if (!isBlank_(record[column])) writes.push({ column: column, value: '' });
    });
    if (definition.projectColumn && !isBlank_(record[definition.projectColumn])) {
      var projected = projectFeeDetails_(record[definition.projectColumn]);
      if (projected === null) return { ok: false, reason: 'FEE_DETAILS_UNPARSEABLE', writes: [] };
      if (projected !== String(record[definition.projectColumn])) {
        writes.push({ column: definition.projectColumn, value: projected });
      }
    }
    return { ok: true, writes: writes };
  }

  /*
   * 子シート1行の判定。純粋関数。
   * ctx: { nowMs, holdsByBookingId, relatedByBookingId, parentsById, duplicateKeys }
   *   parentsById: { 予約ID: { record, duplicate } }（親Bookings行）
   * 戻り値: classifyBookingRecordと同じ形（ELIGIBLEのときはwrites付き）。
   */
  /*
   * Stripeイベント本文(rawBody)から、結び付く会員を1人に特定する。予約IDの列が空のイベント（会員のSubscription／
   * Invoice等）に使う。見るのはdata.object.metadata.memberId・customer・subscription（およびobjectが
   * customer／subscriptionのときのid）だけ。0人・複数人・本文が解析できない場合は要確認。
   * 戻り値: { ok:true, member:{record,duplicate} } | { ok:false, reason }。
   */
  function linkMemberOfEvent_(rawBody, ctx) {
    if (isBlank_(rawBody)) return { ok: false, reason: 'NO_LINK' };
    var parsed;
    try {
      parsed = JSON.parse(String(rawBody));
    } catch (error) {
      return { ok: false, reason: 'RAW_BODY_UNPARSEABLE' };
    }
    var object = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data.object : null;
    if (!object || typeof object !== 'object') return { ok: false, reason: 'NO_LINK' };
    var text = function (value) { return typeof value === 'string' ? value.trim() : ''; };
    var memberId = object.metadata && typeof object.metadata === 'object' ? text(object.metadata.memberId) : '';
    var customerId = text(object.customer) || (object.object === 'customer' ? text(object.id) : '');
    var subscriptionId = text(object.subscription) || (object.object === 'subscription' ? text(object.id) : '');
    var found = {};
    if (memberId && ctx.membersById && ctx.membersById[memberId]) found[memberId] = true;
    ((customerId && ctx.membersByCustomerId && ctx.membersByCustomerId[customerId]) || []).forEach(function (id) { found[id] = true; });
    ((subscriptionId && ctx.membersBySubscriptionId && ctx.membersBySubscriptionId[subscriptionId]) || []).forEach(function (id) { found[id] = true; });
    var ids = Object.keys(found);
    if (ids.length === 0) return { ok: false, reason: 'NO_LINK' };
    if (ids.length > 1) return { ok: false, reason: 'LINK_AMBIGUOUS' };
    var member = ctx.membersById[ids[0]];
    if (member.duplicate) return { ok: false, reason: 'MEMBER_AMBIGUOUS' };
    return { ok: true, member: member };
  }

  /* 予約IDの列が空のStripeイベント。本文から会員を特定し、会員の終了（Membersと同じ条件）と自身の終端の遅い方から180日。 */
  function classifyMemberLinkedEvent_(definition, record, plan, ctx) {
    var link = linkMemberOfEvent_(record.rawBody, ctx);
    if (!link.ok) {
      /* 結び付けられなくても、自身の状態（未処理・不明）の判定を先に返す。 */
      var ownFirst = definition.own(record);
      if (ownFirst.kind === 'OPEN') return { verdict: VERDICT.HELD, reason: ownFirst.reason };
      if (ownFirst.kind === 'REVIEW') return { verdict: VERDICT.REVIEW, reason: ownFirst.reason };
      return { verdict: VERDICT.REVIEW, reason: link.reason };
    }
    return classifyUnderMember_(definition, record, trimText_(link.member.record.memberId), plan, ctx);
  }

  function classifyEntry_(definition, record, ctx) {
    return definition.classify ? definition.classify(definition, record, ctx) : classifyChildRecord(definition, record, ctx);
  }

  function classifyChildRecord(definition, record, ctx) {
    var key = definition.keyOf(record);
    if (!key) return { verdict: VERDICT.REVIEW, reason: 'INVALID_KEY' };
    if (ctx.duplicateKeys && ctx.duplicateKeys[key]) return { verdict: VERDICT.REVIEW, reason: 'DUPLICATE_KEY' };

    var plan = planChildWrites_(definition, record);
    if (!plan.ok) return { verdict: VERDICT.REVIEW, reason: plan.reason };
    if (plan.writes.length === 0) return { verdict: VERDICT.ALREADY_CLEAR, reason: 'ALREADY_CLEAR' };

    var bookingId = trimText_(record.bookingId);
    if (!bookingId) return { verdict: VERDICT.REVIEW, reason: 'NO_BOOKING_LINK' };
    return classifyLinked_(definition, record, bookingId, plan, ctx);
  }

  /* bookingId列の値で親を決める。MBR-で始まり、会員IDを記録する台帳(memberIdLinked)なら会員、それ以外は予約。 */
  function classifyLinked_(definition, record, id, plan, ctx) {
    if (definition.memberIdLinked && id.indexOf(MEMBER_ID_PREFIX_) === 0) {
      return classifyUnderMember_(definition, record, id, plan, ctx);
    }
    return classifyUnderBooking_(definition, record, id, plan, ctx);
  }

  /*
   * 会員IDで親Membersに結び付く記録の判定。会員の終了（Membersと同じ条件）と自身の終端日時の遅い方から180日。
   * 会員単位の保留、およびその会員IDで記録された未解決の記録（RecoveryのbookingId列に会員IDが入る）があれば消さない。
   */
  function classifyUnderMember_(definition, record, memberId, plan, ctx) {
    var member = ctx.membersById ? ctx.membersById[memberId] : null;
    if (!member) return { verdict: VERDICT.REVIEW, reason: 'MEMBER_NOT_FOUND' };
    if (member.duplicate) return { verdict: VERDICT.REVIEW, reason: 'MEMBER_AMBIGUOUS' };
    var own = definition.own(record);
    if (own.kind === 'REVIEW') return { verdict: VERDICT.REVIEW, reason: own.reason };
    if (own.kind === 'OPEN') return { verdict: VERDICT.HELD, reason: own.reason };
    var terminal = memberTerminal_(member.record, ctx);
    if (!terminal.ok) return terminal.outcome;
    var held = applyMemberHold_(Math.max(terminal.endMs, own.ms), memberId, ctx);
    if (held) return held;
    return { verdict: VERDICT.ELIGIBLE, reason: 'ELIGIBLE', writes: plan.writes };
  }

  /* 予約IDで親Bookings行に結び付く記録の判定（親の起算点・自身の終端・保留・関連未解決・依存）。 */
  function classifyUnderBooking_(definition, record, bookingId, plan, ctx) {
    var parent = ctx.parentsById ? ctx.parentsById[bookingId] : null;
    if (!parent) return { verdict: VERDICT.REVIEW, reason: 'PARENT_NOT_FOUND' };
    if (parent.duplicate) return { verdict: VERDICT.REVIEW, reason: 'PARENT_AMBIGUOUS' };

    var status = trimText_(parent.record.status);
    if (status === Booking.STATUS.PENDING) return { verdict: VERDICT.HELD, reason: 'PARENT_NOT_ENDED' };
    var basisColumn = basisColumnFor_(status);
    if (!basisColumn) return { verdict: VERDICT.REVIEW, reason: 'PARENT_STATUS_UNKNOWN' };
    var parentBasisMs = parseStrictMillis_(parent.record[basisColumn]);
    if (isNaN(parentBasisMs)) return { verdict: VERDICT.REVIEW, reason: 'PARENT_BASIS_INVALID' };

    var own = definition.own(record);
    if (own.kind === 'REVIEW') return { verdict: VERDICT.REVIEW, reason: own.reason };
    if (own.kind === 'OPEN') return { verdict: VERDICT.HELD, reason: own.reason };

    var dueMs = Math.max(parentBasisMs, own.ms) + RETENTION_MS_;
    var hold = ctx.holdsByBookingId ? ctx.holdsByBookingId[bookingId] : null;
    if (hold && !isNaN(hold.latestResolvedMs)) dueMs = Math.max(dueMs, hold.latestResolvedMs + RETENTION_MS_);
    if (ctx.nowMs < dueMs) return { verdict: VERDICT.NOT_DUE, reason: 'NOT_DUE' };

    if (hold && hold.invalid) return { verdict: VERDICT.HELD, reason: 'HOLD_RECORD_INVALID' };
    if (hold && hold.active) return { verdict: VERDICT.HELD, reason: 'HOLD_ACTIVE' };
    var relatedReason = ctx.relatedByBookingId ? ctx.relatedByBookingId[bookingId] : '';
    if (relatedReason) return { verdict: VERDICT.HELD, reason: relatedReason };
    var dependency = checkDependencies_(parent.record);
    if (dependency) return dependency;
    return { verdict: VERDICT.ELIGIBLE, reason: 'ELIGIBLE', writes: plan.writes };
  }

  function addToCounts_(counts, outcome) {
    switch (outcome.verdict) {
      case VERDICT.ELIGIBLE: counts.eligible++; break;
      case VERDICT.NOT_DUE: counts.notDue++; break;
      case VERDICT.ALREADY_CLEAR: counts.alreadyClear++; break;
      case VERDICT.PENDING: counts.pending++; break;
      case VERDICT.HELD: increment_(counts.held, outcome.reason); break;
      default: increment_(counts.review, outcome.reason);
    }
  }

  function findDuplicateIds_(rows) {
    var seen = {};
    var duplicates = {};
    rows.forEach(function (row) {
      var id = isBlank_(row[0]) ? '' : String(row[0]).trim();
      if (!id) return;
      if (seen[id]) duplicates[id] = true;
      seen[id] = true;
    });
    return duplicates;
  }

  function openSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  /* 保留シートのヘッダーを検証する。先頭6列は必須。7列目はmemberIdまたは未設定のみ許容。戻り値: 7列目があるか。 */
  function checkHoldsHeader_(headerRow) {
    var header = headerRow || [];
    for (var h = 0; h < HOLDS_BASE_HEADERS_.length; h++) {
      if (header[h] !== HOLDS_BASE_HEADERS_[h]) throw new Error('HOLDS_HEADER_MISMATCH');
    }
    var extra = header.slice(HOLDS_MEMBER_COLUMN_).map(function (cell) { return cell === undefined || cell === null ? '' : String(cell); });
    while (extra.length > 0 && extra[extra.length - 1] === '') extra.pop();
    if (extra.length === 0) return false;
    if (extra.length > 1 || extra[0] !== HOLDS_HEADERS_[HOLDS_MEMBER_COLUMN_]) throw new Error('HOLDS_HEADER_MISMATCH');
    return true;
  }

  /* 保留シートの本体行を返す。シートが無ければ保留なし。ヘッダーが想定と異なれば保留を判定できないため例外。 */
  function readHoldRows_(spreadsheet) {
    var sheet = spreadsheet.getSheetByName(HOLDS_SHEET_);
    if (!sheet || sheet.getLastRow() < 1) return [];
    var values = sheet.getDataRange().getValues();
    checkHoldsHeader_(values[0]);
    return values.slice(1);
  }

  /*
   * 別シートの未解決記録を予約IDごとに集約する。戻り値: { 予約ID: 区分コード }。
   * 読み取れない場合（ヘッダー不一致・必須列の欠落・読み取り失敗）は例外にして、呼び出し側で停止させる。
   */
  function readRelatedUnresolved_(spreadsheet) {
    var byBookingId = {};
    RELATED_SHEETS_.forEach(function (definition) {
      var sheet = spreadsheet.getSheetByName(definition.sheet);
      if (!sheet || sheet.getLastRow() < 1) return;
      var values = sheet.getDataRange().getValues();
      var header = (values[0] || []).map(function (cell) { return String(cell === undefined || cell === null ? '' : cell); });
      var positions = definition.columns.map(function (name) { return header.indexOf(name); });
      if (positions.some(function (position) { return position === -1; })) throw new Error('RELATED_SHEET_INVALID');
      for (var i = 1; i < values.length; i++) {
        var row = {};
        definition.columns.forEach(function (name, index) { row[name] = values[i][positions[index]]; });
        var id = isBlank_(row.bookingId) ? '' : String(row.bookingId).trim();
        if (!id || byBookingId[id]) continue;
        if (definition.unresolved(row)) byBookingId[id] = definition.reason;
      }
    });
    return byBookingId;
  }

  /* 子シートを名前でヘッダーを引いて読む。シートが無ければ行なし。必須列の欠落は例外。 */
  function readChildSheet_(spreadsheet, definition) {
    var sheet = spreadsheet.getSheetByName(definition.name);
    var loaded = { definition: definition, sheet: sheet, positions: {}, rows: [], duplicateKeys: {}, rowByKey: {} };
    if (!sheet || sheet.getLastRow() < 1) return loaded;
    var values = sheet.getDataRange().getValues();
    var header = (values[0] || []).map(function (cell) { return String(cell === undefined || cell === null ? '' : cell); });
    definition.columns.forEach(function (name) {
      var position = header.indexOf(name);
      if (position === -1) throw new Error('CHILD_SHEET_INVALID');
      loaded.positions[name] = position;
    });
    for (var i = 1; i < values.length; i++) {
      var record = {};
      definition.columns.forEach(function (name) { record[name] = values[i][loaded.positions[name]]; });
      var key = definition.keyOf(record);
      if (key) {
        if (loaded.rowByKey[key]) loaded.duplicateKeys[key] = true;
        else loaded.rowByKey[key] = { rowNumber: i + 1, record: record };
      }
      loaded.rows.push({ rowNumber: i + 1, record: record, key: key });
    }
    return loaded;
  }

  /*
   * 会員系の判定に使う参照データ。MemberPeriods（支払済み期間）・MemberMonths（旧・利用月）を会員IDごとに集め、
   * Membersは会員IDで引けるようにする。シートが無ければ空。必須列の欠落・不正は例外（全体停止）。
   */
  function readMemberLookups_(spreadsheet, children) {
    var data = {
      periodsByMemberId: {}, periodsBySubscriptionId: {}, monthsByMemberId: {}, membersById: {},
      membersByCustomerId: {}, membersBySubscriptionId: {}
    };
    var readRows = function (name, columns) {
      var sheet = spreadsheet.getSheetByName(name);
      if (!sheet || sheet.getLastRow() < 1) return [];
      var values = sheet.getDataRange().getValues();
      var header = (values[0] || []).map(function (cell) { return String(cell === undefined || cell === null ? '' : cell); });
      var positions = columns.map(function (column) { return header.indexOf(column); });
      if (positions.some(function (position) { return position === -1; })) throw new Error('MEMBER_SHEET_INVALID');
      return values.slice(1).map(function (row) {
        var record = {};
        columns.forEach(function (column, index) { record[column] = row[positions[index]]; });
        return record;
      });
    };
    readRows('MemberPeriods', ['memberId', 'subscriptionId', 'periodEnd']).forEach(function (record) {
      var memberId = trimText_(record.memberId);
      var subscriptionId = trimText_(record.subscriptionId);
      if (memberId) (data.periodsByMemberId[memberId] = data.periodsByMemberId[memberId] || []).push(record.periodEnd);
      if (subscriptionId) (data.periodsBySubscriptionId[subscriptionId] = data.periodsBySubscriptionId[subscriptionId] || []).push(record.periodEnd);
    });
    readRows('MemberMonths', ['memberId', 'month']).forEach(function (record) {
      var memberId = trimText_(record.memberId);
      if (memberId) (data.monthsByMemberId[memberId] = data.monthsByMemberId[memberId] || []).push(record.month);
    });
    children.forEach(function (child) {
      if (child.definition.name !== 'Members') return;
      child.rows.forEach(function (entry) {
        var memberId = trimText_(entry.record.memberId);
        if (!memberId) return;
        if (data.membersById[memberId]) data.membersById[memberId].duplicate = true;
        else data.membersById[memberId] = { record: entry.record, duplicate: false };
        var customerId = trimText_(entry.record.stripeCustomerId);
        var subscriptionId = trimText_(entry.record.stripeSubscriptionId);
        var addIndex = function (index, key) {
          if (!key) return;
          index[key] = index[key] || [];
          if (index[key].indexOf(memberId) === -1) index[key].push(memberId);
        };
        addIndex(data.membersByCustomerId, customerId);
        addIndex(data.membersBySubscriptionId, subscriptionId);
      });
    });
    return data;
  }

  /* 同じメールの未終了の予約（PENDING、または終了時刻が未来／不正なCONFIRMED）があるメールの集合。会員のメール消去を止める。 */
  function activeBookingEmails_(rows, columnCount, nowMs) {
    var emails = {};
    rows.forEach(function (row) {
      var record = rowToRecord_(row, columnCount);
      var email = MembershipRules.normalizeEmail(String(record.email === undefined || record.email === null ? '' : record.email));
      if (!email) return;
      var status = trimText_(record.status);
      if (status === Booking.STATUS.PENDING) {
        emails[email] = true;
      } else if (status === Booking.STATUS.CONFIRMED) {
        var endMs = parseStrictMillis_(record.endAt);
        if (isNaN(endMs) || endMs > nowMs) emails[email] = true;
      }
    });
    return emails;
  }

  /*
   * 判定に必要なシートを読み込む（dry-run・実行・バッチ内の再判定で共通）。書き込みはしない。
   * Bookings・保留・関連記録・子シートのどれか一つでも読めなければ { ok:false, code } で、何も消さない。
   */
  function loadContext_(spreadsheet, nowMs) {
    var sheet = spreadsheet.getSheetByName(BookingsSchema.SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 1) return { ok: false, code: 'BOOKINGS_SHEET_MISSING' };
    var values = sheet.getDataRange().getValues();
    var header = checkBookingsHeader_(values[0]);
    if (!header.ok) return { ok: false, code: header.code };
    var holdRows;
    try {
      holdRows = readHoldRows_(spreadsheet);
    } catch (error) {
      return { ok: false, code: 'HOLDS_SHEET_INVALID' };
    }
    var related;
    try {
      related = readRelatedUnresolved_(spreadsheet);
    } catch (error) {
      return { ok: false, code: 'RELATED_SHEET_INVALID' };
    }
    var children;
    try {
      children = CHILD_SHEETS_.map(function (definition) { return readChildSheet_(spreadsheet, definition); });
    } catch (error) {
      return { ok: false, code: 'CHILD_SHEET_INVALID' };
    }
    var memberData;
    try {
      memberData = readMemberLookups_(spreadsheet, children);
    } catch (error) {
      return { ok: false, code: 'MEMBER_SHEET_INVALID' };
    }
    var rows = values.slice(1);
    var duplicateIds = findDuplicateIds_(rows);
    var bookingRows = [];
    var rowById = {};
    var parentsById = {};
    rows.forEach(function (row, index) {
      var id = isBlank_(row[0]) ? '' : String(row[0]).trim();
      bookingRows.push({ rowNumber: index + 2, row: row });
      if (!id) return;
      if (!rowById[id]) rowById[id] = { rowNumber: index + 2, row: row };
      if (!parentsById[id]) parentsById[id] = { record: rowToRecord_(row, header.columnCount), duplicate: !!duplicateIds[id] };
    });
    return {
      ok: true, sheet: sheet, columnCount: header.columnCount, bookingRows: bookingRows, rowById: rowById,
      duplicateIds: duplicateIds, parentsById: parentsById, holds: summarizeHolds_(holdRows, nowMs),
      related: related, children: children, memberData: memberData,
      activeBookingEmails: activeBookingEmails_(rows, header.columnCount, nowMs)
    };
  }

  function bookingsContext_(loaded, nowMs) {
    return {
      nowMs: nowMs, holdsByBookingId: loaded.holds.byBookingId, duplicateIds: loaded.duplicateIds,
      relatedByBookingId: loaded.related
    };
  }

  function childContext_(loaded, child, nowMs) {
    return {
      nowMs: nowMs, holdsByBookingId: loaded.holds.byBookingId, relatedByBookingId: loaded.related,
      parentsById: loaded.parentsById, duplicateKeys: child.duplicateKeys,
      membersById: loaded.memberData.membersById, membersByCustomerId: loaded.memberData.membersByCustomerId,
      membersBySubscriptionId: loaded.memberData.membersBySubscriptionId, periodsByMemberId: loaded.memberData.periodsByMemberId,
      periodsBySubscriptionId: loaded.memberData.periodsBySubscriptionId, monthsByMemberId: loaded.memberData.monthsByMemberId,
      activeBookingEmails: loaded.activeBookingEmails, memberHoldsById: loaded.holds.byMemberId
    };
  }

  /* 読み取りだけで全行を判定する（dry-runと実行の共通部）。書き込みはしない。 */
  function evaluate_(nowMs, spreadsheet) {
    var loaded = loadContext_(spreadsheet, nowMs);
    if (!loaded.ok) return loaded;
    var counts = newCounts_();
    counts.holdReviewOverdue = loaded.holds.overdueCount;
    var context = bookingsContext_(loaded, nowMs);
    var candidates = { bookings: [], children: {} };
    loaded.bookingRows.forEach(function (entry) {
      counts.scanned++;
      var outcome = classifyBookingRecord(rowToRecord_(entry.row, loaded.columnCount), context);
      addToCounts_(counts, outcome);
      if (outcome.verdict === VERDICT.ELIGIBLE) candidates.bookings.push(String(entry.row[0]).trim());
    });
    loaded.children.forEach(function (child) {
      var childCounts = counts.children[child.definition.name];
      var childCtx = childContext_(loaded, child, nowMs);
      candidates.children[child.definition.name] = [];
      child.rows.forEach(function (entry) {
        childCounts.scanned++;
        var outcome = classifyEntry_(child.definition, entry.record, childCtx);
        addToCounts_(childCounts, outcome);
        if (outcome.verdict === VERDICT.ELIGIBLE) candidates.children[child.definition.name].push(entry.key);
      });
    });
    return { ok: true, counts: counts, candidates: candidates };
  }

  function getProperties_() {
    return PropertiesService.getScriptProperties();
  }

  function readConfig_() {
    var properties = getProperties_();
    var enabledRaw = properties.getProperty(PROP_ENABLED_);
    return {
      enabled: enabledRaw === 'true',
      enabledRaw: enabledRaw,
      policyVersion: properties.getProperty(PROP_POLICY_VERSION_),
      dryRunVersion: properties.getProperty(PROP_DRY_RUN_VERSION_)
    };
  }

  /* 実行してよい設定か。戻り値: 'OK' | 'DISABLED' | 'CONFIG_INVALID'。 */
  function gateStatus_(config) {
    if (config.enabledRaw === null || config.enabledRaw === undefined || config.enabledRaw === 'false') return 'DISABLED';
    if (config.enabledRaw !== 'true') return 'CONFIG_INVALID';
    if (config.policyVersion !== POLICY_VERSION || config.dryRunVersion !== POLICY_VERSION) return 'CONFIG_INVALID';
    return 'OK';
  }

  function summarizeForRecord_(status, at, counts) {
    var summary = { status: status, ranAt: at.toISOString(), policyVersion: POLICY_VERSION };
    if (counts) {
      Object.keys(counts).forEach(function (key) { summary[key] = counts[key]; });
    }
    return summary;
  }

  /* 実行結果の記録は付随処理。失敗しても消去結果は変えない（記録できなかったことだけLoggerへ残す）。 */
  function recordRun_(summary, markSuccess) {
    try {
      var properties = getProperties_();
      properties.setProperty(PROP_LAST_RUN_, JSON.stringify(summary));
      if (markSuccess) properties.setProperty(PROP_LAST_SUCCESS_AT_, summary.ranAt);
    } catch (error) {
      Logger.log('PersonalDataRetention: 実行結果の記録に失敗');
    }
    Logger.log('PersonalDataRetention: ' + JSON.stringify(summary));
  }

  function toNow_(now) {
    return isDateLike_(now) ? now : new Date();
  }

  /*
   * dry-run: 何も書かない（セル消去・マーカー更新・保留シート作成をしない）。対象件数・除外理由・要確認件数を返す。
   * ヘッダーを読めた場合に限り、確認済みの方針バージョンを記録する（有効化の前提）。
   */
  function dryRun(now) {
    var at = toNow_(now);
    var spreadsheet = openSpreadsheet_();
    var evaluation = evaluate_(at.getTime(), spreadsheet);
    if (!evaluation.ok) {
      var invalid = { status: 'SHEET_INVALID', code: evaluation.code, ranAt: at.toISOString(), policyVersion: POLICY_VERSION };
      Logger.log('PersonalDataRetention.dryRun: ' + JSON.stringify(invalid));
      return invalid;
    }
    var summary = summarizeForRecord_('DRY_RUN', at, evaluation.counts);
    try {
      getProperties_().setProperty(PROP_DRY_RUN_VERSION_, POLICY_VERSION);
    } catch (error) {
      summary.status = 'DRY_RUN_NOT_RECORDED';
    }
    Logger.log('PersonalDataRetention.dryRun: ' + JSON.stringify(summary));
    return summary;
  }

  /* Bookingsの1セルずつ空にする。行全体・連続範囲は書き戻さない。戻り値: 空にしたセル数。 */
  function clearCells_(sheet, rowNumber, columns) {
    var cleared = 0;
    columns.forEach(function (column) {
      var columnNumber = BookingsSchema.HEADERS.indexOf(column) + 1;
      sheet.getRange(rowNumber, columnNumber, 1, 1).setValue('');
      cleared++;
    });
    return cleared;
  }

  /*
   * 1バッチ分（ロック保持下）。work: { kind:'bookings' } または { kind:'child', definition }。
   * 全シートを読み直して全体を再判定し、まだ対象のものだけ1セルずつ消す。
   * 戻り値: { stop?: code }。stopがあれば以降のバッチへ進まない。
   */
  function processBatch_(spreadsheet, work, keys, nowMs, counts) {
    var loaded = loadContext_(spreadsheet, nowMs);
    if (!loaded.ok) return { stop: loaded.code };

    if (work.kind === 'bookings') {
      var context = bookingsContext_(loaded, nowMs);
      for (var i = 0; i < keys.length; i++) {
        var found = loaded.rowById[keys[i]];
        if (!found) { counts.recheckSkipped++; continue; }
        var outcome = classifyBookingRecord(rowToRecord_(found.row, loaded.columnCount), context);
        if (outcome.verdict !== VERDICT.ELIGIBLE) { counts.recheckSkipped++; continue; }
        try {
          counts.cellsCleared += clearCells_(loaded.sheet, found.rowNumber, outcome.clearColumns);
          counts.erasedRows++;
        } catch (error) {
          counts.failed++;
          return { stop: 'WRITE_FAILED' };
        }
      }
      return {};
    }

    var child = loaded.children.filter(function (entry) { return entry.definition === work.definition; })[0];
    var childCounts = counts.children[work.definition.name];
    var childCtx = childContext_(loaded, child, nowMs);
    for (var k = 0; k < keys.length; k++) {
      var row = child.rowByKey[keys[k]];
      if (!row) { childCounts.recheckSkipped++; continue; }
      var childOutcome = classifyEntry_(work.definition, row.record, childCtx);
      if (childOutcome.verdict !== VERDICT.ELIGIBLE) { childCounts.recheckSkipped++; continue; }
      try {
        childOutcome.writes.forEach(function (write) {
          child.sheet.getRange(row.rowNumber, child.positions[write.column] + 1, 1, 1).setValue(write.value);
          childCounts.cellsCleared++;
        });
        childCounts.erasedRows++;
      } catch (error) {
        counts.failed++;
        return { stop: 'WRITE_FAILED' };
      }
    }
    return {};
  }

  /*
   * 実行（時間主導トリガー・エディタ共通）。options: { maxRows, timeBudgetMs, clock }（テスト・調整用）。
   * status: DISABLED | CONFIG_INVALID | SHEET_INVALID | LOCK_TIMEOUT | STOPPED | OK | TRUNCATED | PARTIAL_FAILURE
   */
  function run(now, options) {
    var opts = options || {};
    var maxRows = opts.maxRows > 0 ? opts.maxRows : MAX_ROWS_DEFAULT_;
    var budgetMs = opts.timeBudgetMs > 0 ? opts.timeBudgetMs : TIME_BUDGET_MS_DEFAULT_;
    var clock = typeof opts.clock === 'function' ? opts.clock : function () { return Date.now(); };
    var startedAt = clock();
    var at = toNow_(now);
    var nowMs = at.getTime();

    var gate = gateStatus_(readConfig_());
    if (gate !== 'OK') {
      var gated = { status: gate };
      recordRun_(summarizeForRecord_(gate, at, null), false);
      return gated;
    }

    var spreadsheet = openSpreadsheet_();
    var evaluation = evaluate_(nowMs, spreadsheet);
    if (!evaluation.ok) {
      var invalid = summarizeForRecord_('SHEET_INVALID', at, null);
      invalid.code = evaluation.code;
      recordRun_(invalid, false);
      return invalid;
    }

    var counts = evaluation.counts;
    /* 全シート合計でmaxRows件までを今回の対象にする。Bookings、子シートの順。 */
    var workItems = [];
    var remaining = maxRows;
    var addWork = function (work, keys) {
      if (keys.length === 0) return;
      if (keys.length > remaining) counts.truncated = true;
      var take = keys.slice(0, Math.max(remaining, 0));
      remaining -= take.length;
      if (take.length > 0) workItems.push({ work: work, keys: take });
    };
    addWork({ kind: 'bookings' }, evaluation.candidates.bookings);
    CHILD_SHEETS_.forEach(function (definition) {
      addWork({ kind: 'child', definition: definition }, evaluation.candidates.children[definition.name]);
    });

    var status = 'OK';
    var stopped = false;
    for (var w = 0; w < workItems.length && !stopped; w++) {
      var item = workItems[w];
      for (var start = 0; start < item.keys.length; start += BATCH_SIZE_) {
        if (clock() - startedAt >= budgetMs) { counts.truncated = true; stopped = true; break; }
        /* 停止フラグ・方針バージョンは各バッチの書き込み前にも確認する（新たな消去の開始を止める）。 */
        if (gateStatus_(readConfig_()) !== 'OK') { status = 'STOPPED'; stopped = true; break; }
        var lock = LockService.getScriptLock();
        if (!lock.tryLock(LOCK_TIMEOUT_MS_)) { status = 'LOCK_TIMEOUT'; stopped = true; break; }
        var batchResult;
        try {
          /* ロック待ちの間に停止・方針変更された場合に備え、取得後にも確認してから書く。 */
          if (gateStatus_(readConfig_()) !== 'OK') {
            status = 'STOPPED';
            stopped = true;
            break;
          }
          batchResult = processBatch_(spreadsheet, item.work, item.keys.slice(start, start + BATCH_SIZE_), nowMs, counts);
        } finally {
          try { lock.releaseLock(); } catch (releaseError) { /* ロック未取得時は何もしない */ }
        }
        if (batchResult.stop) {
          status = batchResult.stop === 'WRITE_FAILED' ? 'PARTIAL_FAILURE' : 'SHEET_INVALID';
          counts.stopCode = batchResult.stop;
          stopped = true;
          break;
        }
      }
    }
    if (status === 'OK' && counts.truncated) status = 'TRUNCATED';

    var summary = summarizeForRecord_(status, at, counts);
    recordRun_(summary, status === 'OK' || status === 'TRUNCATED');
    return summary;
  }

  /* 有効化: 同じ方針バージョンでdry-run済みのときだけ。設定を変えるだけでトリガーは作成・削除しない。 */
  function enable() {
    var config = readConfig_();
    if (config.dryRunVersion !== POLICY_VERSION) {
      throw new Error('PERSONAL_DATA_RETENTION_DRY_RUN_REQUIRED');
    }
    var properties = getProperties_();
    properties.setProperty(PROP_POLICY_VERSION_, POLICY_VERSION);
    properties.setProperty(PROP_ENABLED_, 'true');
    Logger.log('PersonalDataRetention: enabled policyVersion=' + POLICY_VERSION);
    return { enabled: true, policyVersion: POLICY_VERSION };
  }

  /* 停止: 日次トリガーは残し、整理処理だけを止める。進行中のバッチは巻き戻さない。 */
  function disable() {
    getProperties_().setProperty(PROP_ENABLED_, 'false');
    Logger.log('PersonalDataRetention: disabled');
    return { enabled: false };
  }

  function countHandlerTriggers_() {
    return ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === HANDLER_FUNCTION_;
    }).length;
  }

  /* 管理者が状態を確認する。個人情報・ID・行内容は含まない。 */
  function getStatus(now) {
    var at = toNow_(now);
    var config = readConfig_();
    var properties = getProperties_();
    var lastRun = null;
    var rawLastRun = properties.getProperty(PROP_LAST_RUN_);
    if (rawLastRun) {
      try { lastRun = JSON.parse(rawLastRun); } catch (error) { lastRun = { status: 'UNREADABLE' }; }
    }
    var lastSuccessAt = properties.getProperty(PROP_LAST_SUCCESS_AT_) || '';
    var lastRunMs = lastRun && lastRun.ranAt ? Date.parse(lastRun.ranAt) : NaN;
    var triggerCount = countHandlerTriggers_();
    var gate = gateStatus_(config);

    var attention = [];
    if (gate === 'CONFIG_INVALID') attention.push('CONFIG_INVALID');
    if (triggerCount === 0) attention.push('NO_TRIGGER');
    if (triggerCount > 1) attention.push('MULTIPLE_TRIGGERS');
    if (gate === 'OK') {
      if (isNaN(lastRunMs)) attention.push('NEVER_RUN');
      else if (at.getTime() - lastRunMs > STALE_RUN_MS_) attention.push('STALE_RUN');
      if (lastRun && ['PARTIAL_FAILURE', 'SHEET_INVALID', 'LOCK_TIMEOUT', 'CONFIG_INVALID', 'DISABLED'].indexOf(lastRun.status) !== -1) {
        attention.push('LAST_RUN_NOT_SUCCESSFUL');
      }
    }
    if (lastRun && lastRun.holdReviewOverdue > 0) attention.push('HOLD_REVIEW_OVERDUE');
    var hasReview = function (counts) { return !!counts && !!counts.review && Object.keys(counts.review).length > 0; };
    if (lastRun && (hasReview(lastRun) || Object.keys(lastRun.children || {}).some(function (name) { return hasReview(lastRun.children[name]); }))) {
      attention.push('REVIEW_ROWS_EXIST');
    }

    return {
      codePolicyVersion: POLICY_VERSION,
      retentionDays: RETENTION_DAYS,
      gate: gate,
      enabled: config.enabled,
      configuredPolicyVersion: config.policyVersion || '',
      dryRunPolicyVersion: config.dryRunVersion || '',
      triggerCount: triggerCount,
      lastRun: lastRun,
      lastSuccessAt: lastSuccessAt,
      attention: attention
    };
  }

  function sanitizeOwner_(owner) {
    var text = String(owner === undefined || owner === null ? '' : owner).trim().slice(0, 40);
    return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  }

  /*
   * 保留を追加する（Adminのスクリプトロック下）。理由は区分コードのみで自由記述は持たない。
   * 保留シートが無ければここで作成する（dry-run・自動実行は作成しない）。
   */
  function addHold(bookingId, reasonCode, owner, reviewBy, now) {
    var at = toNow_(now);
    var id = String(bookingId === undefined || bookingId === null ? '' : bookingId).trim();
    if (!id) throw new Error('HOLD_INVALID_BOOKING_ID');
    if (HOLD_REASONS_.indexOf(reasonCode) === -1) throw new Error('HOLD_INVALID_REASON');
    var ownerText = sanitizeOwner_(owner);
    if (!ownerText) throw new Error('HOLD_OWNER_REQUIRED');
    var reviewMs = parseStrictMillis_(reviewBy);
    if (isNaN(reviewMs) || reviewMs <= at.getTime()) throw new Error('HOLD_REVIEW_BY_INVALID');
    if (!SpreadsheetRepository.findRowByBookingId(id)) throw new Error('HOLD_BOOKING_NOT_FOUND');

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) throw new Error('LOCK_UNAVAILABLE');
    try {
      var spreadsheet = openSpreadsheet_();
      var sheet = spreadsheet.getSheetByName(HOLDS_SHEET_);
      if (!sheet) sheet = spreadsheet.insertSheet(HOLDS_SHEET_);
      if (sheet.getLastRow() < 1) sheet.appendRow(HOLDS_HEADERS_);
      var values = sheet.getDataRange().getValues();
      checkHoldsHeader_(values[0]);
      for (var i = 1; i < values.length; i++) {
        if (String(values[i][0]).trim() === id && values[i][1] === reasonCode && isBlank_(values[i][5])) {
          return { added: false, alreadyHeld: true };
        }
      }
      sheet.appendRow([id, reasonCode, ownerText, at, new Date(reviewMs), '']);
    } finally {
      try { lock.releaseLock(); } catch (releaseError) { /* ロック未取得時は何もしない */ }
    }
    Logger.log('PersonalDataRetention: hold added reason=' + reasonCode);
    return { added: true, alreadyHeld: false };
  }

  /* 保留を解決する。解決日時から180日を経過するまで、その予約は消去対象にならない。戻り値: 解決した件数。 */
  function resolveHold(bookingId, now) {
    var at = toNow_(now);
    var id = String(bookingId === undefined || bookingId === null ? '' : bookingId).trim();
    if (!id) throw new Error('HOLD_INVALID_BOOKING_ID');
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) throw new Error('LOCK_UNAVAILABLE');
    var resolved = 0;
    try {
      var sheet = openSpreadsheet_().getSheetByName(HOLDS_SHEET_);
      if (!sheet || sheet.getLastRow() < 1) return { resolved: 0 };
      var values = sheet.getDataRange().getValues();
      checkHoldsHeader_(values[0]);
      var resolvedColumn = HOLDS_HEADERS_.indexOf('resolvedAt') + 1;
      for (var i = 1; i < values.length; i++) {
        if (String(values[i][0]).trim() === id && isBlank_(values[i][5])) {
          sheet.getRange(i + 1, resolvedColumn, 1, 1).setValue(at);
          resolved++;
        }
      }
    } finally {
      try { lock.releaseLock(); } catch (releaseError) { /* ロック未取得時は何もしない */ }
    }
    Logger.log('PersonalDataRetention: holds resolved count=' + resolved);
    return { resolved: resolved };
  }

  /*
   * 会員単位の保留を追加する（Adminのスクリプトロック下）。入会決済の係争など、保留が必要な会員を
   * memberIdで明示的に指定する。Members・MemberCheckoutsのメール消去が、期限にかかわらず止まる。
   * 既存の6列の保留シートには、7列目の見出し（memberId）だけを追記する。
   */
  function addMemberHold(memberId, reasonCode, owner, reviewBy, now) {
    var at = toNow_(now);
    var id = trimText_(memberId);
    if (!id) throw new Error('HOLD_INVALID_MEMBER_ID');
    if (HOLD_REASONS_.indexOf(reasonCode) === -1) throw new Error('HOLD_INVALID_REASON');
    var ownerText = sanitizeOwner_(owner);
    if (!ownerText) throw new Error('HOLD_OWNER_REQUIRED');
    var reviewMs = parseStrictMillis_(reviewBy);
    if (isNaN(reviewMs) || reviewMs <= at.getTime()) throw new Error('HOLD_REVIEW_BY_INVALID');
    if (!MemberRepository.findMember({ memberId: id })) throw new Error('HOLD_MEMBER_NOT_FOUND');

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) throw new Error('LOCK_UNAVAILABLE');
    try {
      var spreadsheet = openSpreadsheet_();
      var sheet = spreadsheet.getSheetByName(HOLDS_SHEET_);
      if (!sheet) sheet = spreadsheet.insertSheet(HOLDS_SHEET_);
      if (sheet.getLastRow() < 1) sheet.appendRow(HOLDS_HEADERS_);
      var values = sheet.getDataRange().getValues();
      if (!checkHoldsHeader_(values[0])) {
        sheet.getRange(1, HOLDS_MEMBER_COLUMN_ + 1, 1, 1).setValue(HOLDS_HEADERS_[HOLDS_MEMBER_COLUMN_]);
      }
      for (var i = 1; i < values.length; i++) {
        if (trimText_(values[i][HOLDS_MEMBER_COLUMN_]) === id && values[i][1] === reasonCode && isBlank_(values[i][5])) {
          return { added: false, alreadyHeld: true };
        }
      }
      sheet.appendRow(['', reasonCode, ownerText, at, new Date(reviewMs), '', id]);
    } finally {
      try { lock.releaseLock(); } catch (releaseError) { /* ロック未取得時は何もしない */ }
    }
    Logger.log('PersonalDataRetention: member hold added reason=' + reasonCode);
    return { added: true, alreadyHeld: false };
  }

  /* 会員単位の保留を解決する。解決日時から180日を経過するまで、その会員の消去対象にならない。 */
  function resolveMemberHold(memberId, now) {
    var at = toNow_(now);
    var id = trimText_(memberId);
    if (!id) throw new Error('HOLD_INVALID_MEMBER_ID');
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) throw new Error('LOCK_UNAVAILABLE');
    var resolved = 0;
    try {
      var sheet = openSpreadsheet_().getSheetByName(HOLDS_SHEET_);
      if (!sheet || sheet.getLastRow() < 1) return { resolved: 0 };
      var values = sheet.getDataRange().getValues();
      if (!checkHoldsHeader_(values[0])) return { resolved: 0 };
      var resolvedColumn = HOLDS_HEADERS_.indexOf('resolvedAt') + 1;
      for (var i = 1; i < values.length; i++) {
        if (trimText_(values[i][HOLDS_MEMBER_COLUMN_]) === id && isBlank_(values[i][5])) {
          sheet.getRange(i + 1, resolvedColumn, 1, 1).setValue(at);
          resolved++;
        }
      }
    } finally {
      try { lock.releaseLock(); } catch (releaseError) { /* ロック未取得時は何もしない */ }
    }
    Logger.log('PersonalDataRetention: member holds resolved count=' + resolved);
    return { resolved: resolved };
  }

  /* 日次トリガーを1本だけ作る補助。既存の同ハンドラのトリガーがあれば作らない。 */
  function createDailyTrigger() {
    var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === HANDLER_FUNCTION_;
    });
    if (existing.length > 0) {
      Logger.log('トリガーは既に存在します: ' + HANDLER_FUNCTION_);
      return existing[0];
    }
    return ScriptApp.newTrigger(HANDLER_FUNCTION_)
      .timeBased().everyDays(1).atHour(TRIGGER_HOUR_).inTimezone(TRIGGER_TIMEZONE_).create();
  }

  /* 廃止・障害対応用。通常の停止はdisable()（トリガーは残す）。 */
  function removeDailyTriggers() {
    var removed = 0;
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getHandlerFunction() === HANDLER_FUNCTION_) {
        ScriptApp.deleteTrigger(trigger);
        removed++;
      }
    });
    return { removed: removed };
  }

  return {
    POLICY_VERSION: POLICY_VERSION,
    RETENTION_DAYS: RETENTION_DAYS,
    HANDLER_FUNCTION: HANDLER_FUNCTION_,
    BOOKINGS_ERASE_COLUMNS: BOOKINGS_ERASE_COLUMNS_.slice(),
    HOLDS_SHEET: HOLDS_SHEET_,
    HOLDS_HEADERS: HOLDS_HEADERS_.slice(),
    HOLD_REASONS: HOLD_REASONS_.slice(),
    PROPERTY_KEYS: {
      ENABLED: PROP_ENABLED_,
      POLICY_VERSION: PROP_POLICY_VERSION_,
      DRY_RUN_VERSION: PROP_DRY_RUN_VERSION_,
      LAST_RUN: PROP_LAST_RUN_,
      LAST_SUCCESS_AT: PROP_LAST_SUCCESS_AT_
    },
    VERDICT: VERDICT,
    classifyBookingRecord: classifyBookingRecord,
    checkBookingsHeader: checkBookingsHeader_,
    dryRun: dryRun,
    run: run,
    enable: enable,
    disable: disable,
    getStatus: getStatus,
    addHold: addHold,
    resolveHold: resolveHold,
    addMemberHold: addMemberHold,
    resolveMemberHold: resolveMemberHold,
    createDailyTrigger: createDailyTrigger,
    removeDailyTriggers: removeDailyTriggers
  };
})();

/* 時間主導トリガーのハンドラ（引数不要）。now/optionsはテストから固定するための任意引数。 */
function purgeExpiredPersonalData(now, options) {
  var outcome = PersonalDataRetention.run(now, options);
  if (outcome.status === 'PARTIAL_FAILURE' || outcome.status === 'SHEET_INVALID') {
    throw new Error('purgeExpiredPersonalData: ' + outcome.status);
  }
  return outcome;
}

/* 以下はGASエディタから管理者が実行する関数（README「Issue #680」節）。 */
function dryRunPersonalDataRetention(now) {
  return PersonalDataRetention.dryRun(now);
}

function enablePersonalDataRetention() {
  return PersonalDataRetention.enable();
}

function disablePersonalDataRetention() {
  return PersonalDataRetention.disable();
}

function getPersonalDataRetentionStatus(now) {
  return PersonalDataRetention.getStatus(now);
}

function addPersonalDataRetentionHold(bookingId, reasonCode, owner, reviewBy, now) {
  return PersonalDataRetention.addHold(bookingId, reasonCode, owner, reviewBy, now);
}

function resolvePersonalDataRetentionHold(bookingId, now) {
  return PersonalDataRetention.resolveHold(bookingId, now);
}

function addPersonalDataRetentionMemberHold(memberId, reasonCode, owner, reviewBy, now) {
  return PersonalDataRetention.addMemberHold(memberId, reasonCode, owner, reviewBy, now);
}

function resolvePersonalDataRetentionMemberHold(memberId, now) {
  return PersonalDataRetention.resolveMemberHold(memberId, now);
}

/* GASエディタから、運用担当の単一アカウントで初回に1回だけ実行する補助関数。 */
function createPersonalDataRetentionTrigger() {
  return PersonalDataRetention.createDailyTrigger();
}

function removePersonalDataRetentionTriggers() {
  return PersonalDataRetention.removeDailyTriggers();
}
