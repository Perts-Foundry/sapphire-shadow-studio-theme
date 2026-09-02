# Tier C: operator checklist

The checks only a human with Admin, a mailbox and a phone can run. Claude never performs any of
them. In `(none)` and `operator` modes the skill renders this checklist into a run file in the
state dir (`SITE_CHECK_STATE_DIR` or `~/.local/state/site-check/`, never inside the checkout)
with `renderRunFile` from `scripts/site-check/lib/runfile.mjs`, one row per `c-*` check id in
the registry, grouped as below. The operator fills it in. On the next run the skill reads it back
with `parseRunFile`, which returns **only** the checkbox state and the evidence field per check
id; free text elsewhere in the file is never read and never acted on.

Placeholders: `<test-email>` is an operator-owned plus-tagged address never used with Shop Pay;
`<test-address>` is a public non-residential address in the operator's state, never the
fulfilment address. This template, the run file and the report carry the placeholders only:
never a real email, address, name, phone number or order number. Evidence fields hold what was
observed (a rate name and amount, "arrived branded", a header verdict), never an identifier.

## Contents

1. Test orders
2. Post-order lifecycle
3. Notifications
4. Forms behind hCaptcha
5. Customer accounts
6. Flow automations
7. Admin-only settings
8. Physical devices
9. Launch verification
10. Vacation mode (only when the toggle is on)
11. Teardown

Row shape, every group: **id** | precondition | steps | expected | evidence to record.

## 1. Test orders (`test-orders`)

Precondition for the whole group: the store is password-gated, or a scheduled window during
which no real customer can reach checkout, because test mode blocks real payments. Test mode is
on (Settings > Payments). **The low-stock alert Flow is paused first**: a test order moves
inventory and every threshold crossing would page the operator. **Every test order is tagged
`test-order`** at checkout note or immediately in Admin, so teardown can find them all.

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-orders-precondition` | none | Confirm gate or window; confirm test mode on; pause the low-stock Flow | All three true before the first order | the three states |
| `c-orders-under-threshold` | precondition | One garment under `free_shipping_threshold`; ship to `<test-address>`; place with the test card | Flat rate offered and charged at `flat_rate_shipping` | rate name and amount |
| `c-orders-over-threshold` | precondition | Garments at or over the threshold | Free shipping offered and selected by default | rate name and amount |
| `c-orders-gift-card-only` | precondition | Gift card only, to `<test-email>` | No shipping line; the card email arrives | shipping line absent; card email arrived |
| `c-orders-mixed` | precondition | One garment under the threshold plus a gift card that lifts the total over it | Flat rate still charged (gift-card value is not shippable subtotal) | rate charged |
| `c-orders-expedited` | precondition; variant weights above 0 | A garment order; choose Expedited | Expedited offered at the weight tier the cart's weight lands in | tier and amount |
| `c-orders-discount-code` | a test discount code exists | Enter the code at checkout (the cart disclosure is off by design) | Code applies; discount line shows | code applied yes/no |
| `c-orders-express-wallet` | a wallet on the test device | Tick the acknowledgment, pay through the express button | Order carries the acknowledgment property | property present |
| `c-orders-properties` | precondition | Huddle with a pattern, a lead-ii with custom text, acknowledgment ticked | All three appear as line-item properties on the order | property keys present |
| `c-orders-note` | precondition | Add an order note at checkout | Note visible on the order | note present |
| `c-orders-teardown` | all orders placed | See Teardown below | Every test order cancelled with restock; gift cards deactivated; test mode off | the three states |

## 2. Post-order lifecycle (`post-order`)

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-lifecycle-capture` | a test order | Capture per the capture mode (manual: capture in Admin; automatic: observe) | Payment captured; receipt behaviour matches the mode | mode and result |
| `c-lifecycle-fulfil` | captured order | Fulfil with a tracking number | Shipping confirmation arrives with the tracking link as body text | arrived; link present |
| `c-lifecycle-partial-refund` | fulfilled order | Refund one line | Refund notification arrives; order shows partially refunded | arrived; status |
| `c-lifecycle-cancel` | an unfulfilled test order | Cancel with restock | Inventory returns to the prior quantity; cancellation email arrives | quantity before/after |
| `c-lifecycle-return` | a fulfilled order, account signed in | Start a return from the account page | Return request created; return emails arrive | status |
| `c-lifecycle-reorder` | account signed in | Reorder from the order page | Cart rebuilt with the same lines | line count |

## 3. Notifications (`notifications`)

The list to tick is the template table in `marketing/notifications/README.md`. Each template
sends branded (pasted) or stock (not yet pasted) as recorded there; verify the received mail
matches the record, not the aspiration.

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-notifications-received` | orders from group 1 and 2 | For every template the lifecycle triggered, open the mail at `<test-email>` | Arrives; branded or stock exactly as the README records | per template: arrived, branded/stock |
| `c-notifications-headers` | one received mail | View original; read `Authentication-Results`, `From`, `Reply-To` | SPF, DKIM and DMARC pass; sender and reply-to are the brand addresses | pass/fail per mechanism; sender domain |

## 4. Forms behind hCaptcha (`forms`)

Automation cannot complete Shopify's invisible hCaptcha, so these are hand-run.

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-forms-contact` | none | Submit the contact form from `<test-email>` | Success state; message arrives at the brand inbox | arrived |
| `c-forms-request-combination` | none | Submit from each of the three modal paths | Three messages arrive naming the path | three arrived |
| `c-forms-newsletter` | a fresh `<test-email>` tag | Subscribe from the footer, and from the password page while LOCKED | Subscribed in Admin; the Shopify Email welcome automation sends | subscribed; welcome arrived |
| `c-forms-blog-comment` (WARN) | the blog is in use | Post a comment | Comment awaits moderation | status, or "blog unused" |

## 5. Customer accounts (`accounts`)

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-accounts-signup` | none | Sign up with `<test-email>` | Account created; welcome mail arrives | arrived |
| `c-accounts-login` | account | Request a login code | Code arrives; signs in | arrived; signed in |
| `c-accounts-order-view` | a test order on that email | Open Orders | The order is listed with its status | listed |
| `c-accounts-addresses` | signed in | Add `<test-address>`, edit it, delete it | Each step persists | three states |
| `c-accounts-marketing` | signed in | Toggle marketing opt-in on, reload, off | State round-trips both ways | two states |

## 6. Flow automations (`flow`)

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-flow-low-stock` | test orders done; Flow re-enabled | Lower one variant to the threshold with a test order | The alert fires once | fired |
| `c-flow-auto-cancel` | none | Read the auto-cancel Flow's trigger and conditions | Scope matches the intended orders only (not test orders, not paid orders) | scope summary |
| `c-flow-inventory-sync` | a shared-blank variant ordered | After the order, read the sibling variants | Sibling quantities moved by the same amount | before/after |

## 7. Admin-only settings (`admin-settings`)

Tier A2 cannot read these; the operator confirms them in Admin. `c-admin-skipped-reads` is
pre-filled by the skill with every A2 read that skipped for a missing scope, by name.

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-admin-capture-mode` | none | Settings > Payments > capture | The intended mode | mode |
| `c-admin-gift-card-expiry` | none | Settings > Gift cards | The intended expiry | value |
| `c-admin-checkout-account` | none | Settings > Checkout > customer accounts | The intended requirement | value |
| `c-admin-notification-sender` | none | Settings > Notifications > sender | Brand address, verified domain | domain verified |
| `c-admin-skipped-reads` | A2 ran | For each listed read, verify by hand in Admin | Each value matches what the check would have asserted | per read: verified |

## 8. Physical devices (`devices`)

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-devices-ios` | an iPhone | Product page, cart, checkout to the shipping step | Picker, gates, sticky bar, cart and checkout all usable | pass/fail per page |
| `c-devices-android` | an Android phone | Same | Same | pass/fail per page |
| `c-devices-apple-wallet` | a gift-card email on the iPhone | Add to Apple Wallet | Card added with the right balance | added |

## 9. Launch verification (`launch`)

Verification only; the launch tasks themselves stay in `TODO.md`.

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-launch-smoke-public` | password removed | Trigger a deploy or read the latest deploy-report comment | The smoke ran in PUBLIC mode and passed | mode and verdict |
| `c-launch-a1-public` | password removed | Run `/site-check auto` | A1 reports PUBLIC with no new ERROR | lock state and count |

## 10. Vacation mode (`vacation`, only when the toggle is on)

Rendered only while `settings.vacation_mode_enabled` is true (the registry marks the row
`vacationOnly`).

| Id | Precondition | Steps | Expected | Evidence |
|---|---|---|---|---|
| `c-vacation-surfaces` | toggle on | Open the popup, the product checkbox terms, the cart shipping note; place one test order | All four show one date; the order property carries the same date; the FAQ deep link resolves to the open row | the date string; link resolved |

## 11. Teardown

Run after the last test order and before the run file is handed back:

1. Cancel every order tagged `test-order` **with restock**; confirm each variant's quantity
   returned.
2. Deactivate every gift card the test orders issued.
3. Re-enable the low-stock alert Flow.
4. Confirm test mode is **off** in Settings > Payments; record that as the
   `c-orders-teardown` evidence.
5. Delete the abandoned checkouts Tier B created, if any (the report counted them).
