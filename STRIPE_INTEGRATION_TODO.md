# Stripe Checkout Integration TODO

This file is the single source of truth for the remaining Stripe Checkout setup and verification steps.

## Scenario

**Scenario A — Existing Checkout Session API calls found.**

The application already creates Stripe Checkout Sessions through the Stripe REST API in [`gas/booking/shared/StripeGateway.gs`](gas/booking/shared/StripeGateway.gs). No new endpoint, Stripe SDK, middleware, webhook handler, or environment-loading infrastructure was added.

## Values to Replace

No placeholder `mode`, `success_url`, `cancel_url`, or `line_items` values were found in the existing Checkout Session creation paths.

The application already supplies real runtime values for:

- `mode` (`payment`)
- `success_url`
- `cancel_url`
- `line_items`

Therefore there are no sample-only placeholder values to replace in this change.

**Files containing placeholders:** none.

| Field | Current Value | What to Set |
|-------|---------------|-------------|
| — | — | No sample-only placeholders were introduced. |

## Configured Parameters

Checkout Studio parameters are applied to both existing Checkout Session creation paths in [`gas/booking/shared/StripeGateway.gs`](gas/booking/shared/StripeGateway.gs):

- normal booking / option Checkout Sessions
- SNB MEMBER join Checkout Sessions

| Parameter | Value |
|-----------|-------|
| `ui_mode` | `hosted_page` |
| `billing_address_collection` | `auto` |
| `phone_number_collection[enabled]` | `false` |
| `automatic_tax[enabled]` | `false` |
| `allow_promotion_codes` | `false` |
| `submit_type` | `auto` |
| `name_collection[individual][enabled]` | `true` |
| `name_collection[individual][optional]` | `true` |
| `integration_identifier` | `hosted_web_0001` |
| `origin_context` | `web` |

`payment_method_collection` is intentionally not added because the existing Checkout Sessions use `mode=payment`; the supplied integration rules require that field only for `mode=subscription`.

## Compatibility Exception

The generic Checkout Studio instruction says to remove Checkout parameters that are absent from the Field Intents list. That removal is **not safe for this repository** because the existing application depends on additional operational parameters that are not merely UI configuration.

The following existing parameters are intentionally preserved:

### Booking / option Checkout

- `expires_at`
- `customer_email` when supplied
- `client_reference_id` when supplied
- booking / option `metadata[...]`

These are used by the existing payment-attempt, booking, option-order, expiry, and webhook reconciliation logic.

### SNB MEMBER join Checkout

- `customer_email`
- `customer_creation=always`
- `payment_intent_data[setup_future_usage]=off_session`
- membership `metadata[...]`
- `client_reference_id`
- optional `expires_at`

These values are required by the current two-step membership flow: the initial ¥500 Checkout payment creates/saves a Customer/payment method, and the post-payment webhook then creates the recurring membership Subscription. Removing these fields would prevent the existing downstream membership flow from having the required Customer/payment-method identity.

Do not remove these operational parameters unless the membership / booking reconciliation architecture is redesigned in the same change.

## UI mode / SDK version note

This Checkout path does not use a Stripe language SDK; it calls the Stripe REST API directly from Google Apps Script. The configured value is therefore `ui_mode=hosted_page`, matching the current Stripe REST API naming. If this path is later migrated to a Stripe SDK with older naming semantics, re-check the SDK-specific `ui_mode` value before deployment.

## Setup and next steps

### Server-side configuration

The project uses Google Apps Script Script Properties rather than a `.env` file for the Booking GAS runtime. Keep secret values out of source control.

Confirm the existing production properties required by the current payment flows are present, including the Stripe secret key and the existing Checkout return URLs used by the repository. Do not paste secret values into GitHub, logs, or chat.

No new environment variable names or Script Properties are introduced by this Checkout Studio parameter update.

### Project structure changed

- Modified: [`gas/booking/shared/StripeGateway.gs`](gas/booking/shared/StripeGateway.gs)
- Added: [`STRIPE_INTEGRATION_TODO.md`](STRIPE_INTEGRATION_TODO.md)

No new routes, endpoints, webhook handlers, middleware, auth layers, or Stripe client initialization were added.

### Flow overview

1. Existing application logic builds a Checkout Session request.
2. `StripeGateway.gs` sends `POST /v1/checkout/sessions` to Stripe.
3. The customer is redirected to the Stripe-hosted Checkout page.
4. Existing success/cancel URLs remain unchanged.
5. Existing webhook and reconciliation logic continues to process the completed Checkout Session.
6. For SNB MEMBER joins, the existing post-payment membership flow continues to create the recurring Subscription separately.

### Testing

Before production deployment:

1. Run the repository's existing Stripe / booking tests.
2. Use Stripe test mode and a standard successful test card such as `4242 4242 4242 4242`, with any future expiry date and any valid CVC.
3. Verify normal booking Checkout still returns to the existing success/cancel URLs.
4. Verify booking and option webhook reconciliation still receives the expected metadata/client reference values.
5. Verify an SNB MEMBER join Checkout still creates a Customer and stores a reusable payment method.
6. Verify the membership webhook can create the recurring Subscription after the initial payment.
7. Verify the Stripe-hosted Checkout page collects the optional individual name and does not require phone collection or promotion codes.

### Membership blocker to resolve separately

The currently observed production error `会員subscription作成に失敗しました ... errorType=STRIPE_ERROR` occurs **after** the Checkout payment, during the separate `/v1/subscriptions` call. This Checkout Studio change does not modify `createMembershipSubscription()` and therefore does not itself fix that Subscription API error.

Before enabling production membership enrollment broadly, inspect the Stripe Workbench/API request error for the failed `POST /v1/subscriptions` call and fix that separate failure. Also verify refund handling removes or invalidates the corresponding membership entitlement when an initial membership payment is fully refunded.

## Next steps

- Review and merge this Checkout parameter change only after existing booking and membership Checkout tests pass.
- Diagnose the separate recurring Subscription creation `STRIPE_ERROR` using Stripe's API request error details.
- Re-test the full membership lifecycle: join → initial payment → Subscription creation → status → renewal → cancellation → refund handling.
- Keep fulfillment and entitlement decisions server-side and based on verified Stripe/webhook data.

## Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
- https://docs.stripe.com/api/checkout/sessions/create
