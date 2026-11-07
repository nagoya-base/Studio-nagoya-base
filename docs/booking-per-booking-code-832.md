# 前日リマインドの新方式（予約別パスコード別送）切替手順 — Issue #832

Booking Adminのコードを先にデプロイしても、`ACCESS_PER_BOOKING_CODE_MODE`が未設定/`OFF`の間は
前日リマインドの本文・送信可否は従来と完全に同じです。切替は運営者の別承認で行います。
（予約ID・パスコード・Script Properties実値はこのリポジトリ/Issue/CI/ログに書かない。）

## Script Properties（Booking Admin）

| キー | 値 | 備考 |
|---|---|---|
| `ACCESS_PER_BOOKING_CODE_MODE` | `OFF`（既定・未設定も同じ）/ `PILOT` / `ALL` | 不正値はOFF扱い＋警告 |
| `ACCESS_PER_BOOKING_CODE_PILOT_IDS` | `PILOT`時のみ。カンマ区切り、予約ID完全一致 | 空・不正書式（英数字/`_`/`-`以外）はOFF扱い＋警告 |

- `ALL`は`snb` / `mens` / `studio_x`の3ブランドの予約が対象。それ以外のブランドは旧方式。
- 警告はログに警告コード（`INVALID_MODE` / `EMPTY_PILOT_IDS` / `INVALID_PILOT_IDS`）だけを残し、
  管理画面プレビューの`codeModeWarning`にも出る。予約ID・設定値は出さない。構文エラーを`ALL`とは解釈しない。

## 新方式対象予約のリマインド

- 旧固定「解錠コード」行（ラベル・値）を出さない。
- 次の一文を、句読点も含めそのまま出す: `パスコードは別途お送りするメールでお知らせします`
  （送付済みとは断定しない。旧文言「入室用の暗証番号は、別のメールでお送りします。」は使わない）。
- 住所・建物・部屋・入口・オートロック用キーボックス位置/番号・案内URLは従来どおり。
- 必須情報チェック（`ensureAccessGuideComplete_`）は新方式のみ`ACCESS_GUIDE_UNLOCK_CODE`を不要にする。
  `ACCESS_GUIDE_KEYBOX_NUMBER`ほかは必須のまま。旧方式の判定・本文は不変。
- バックアップ用キーボックス（障害時のスタジオ物理キー）の所在・番号は従来どおり定型メールに載せない。
- 新方式の発行/配送失敗・UNKNOWNでも旧固定番号へはフォールバックしない（本文に旧番号を出す経路がない）。
  別送が届かない場合は運営が本人確認のうえ個別に代替入室を案内する。

## 既存フラグ`ACCESS_KEY_NOTICE_ENABLED`との優先順位

- 新方式の判定は`ACCESS_PER_BOOKING_CODE_MODE`のみで決まり、`ACCESS_KEY_NOTICE_ENABLED`の影響を受けない。
- 新方式の予約: `ACCESS_KEY_NOTICE_ENABLED`の値にかかわらず新しい一文のみ（二重案内なし）。
- 旧方式の予約: 従来どおり（`ACCESS_KEY_NOTICE_ENABLED='true'`かつSNBなら旧文言＋旧解錠コード行）。

## 全経路で共通判定

定期便(18時台)・補完便(21時台)・確定直後便・管理画面の手動再送・診断プレビュー/管理者宛テスト送信は、すべて
`BookingConfig.resolveAccessCodeDelivery`を経由する。プレビューは`mailMethod`（`PER_BOOKING_CODE` / `LEGACY`）、
`codeMode`（`OFF`/`PILOT`/`ALL`）を返す（秘密値なし）。

## 切替の安全手順（逆順禁止）

不変条件: **Bookingの新方式対象集合 ⊆ Access GASの発行・配送対象集合。**
Booking側だけ対象のとき、旧コードは消えるのに新コードも届かず入室できなくなる。

1. Booking AdminへコードをOFFのままデプロイし、プレビューで`LEGACY`を確認。
2. Access GAS側の設定・対象ブランド・対象予約を運営が読取確認（Access GASは本PRでは変更しない）。
   AccessがONでも配送成功は保証されないため、対象予約の別送到達または代替入室手段を事前に確認する。
3. Booking側を`PILOT`＋対象予約ID（Access GASの`pilotBookingIds`の部分集合）へ。プレビューで`PER_BOOKING_CODE`を確認。
4. 全予約へ広げる場合は、**Access GAS側を全対象にして確認した後で**Booking側を`ALL`へ。
5. 戻す場合は`OFF`へ（旧方式へ戻す前に、対象予約の入室手段を確保する）。
