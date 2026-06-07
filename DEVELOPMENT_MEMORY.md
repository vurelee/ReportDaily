# Development Memory

This file records project implementation decisions and development conventions.
It is not an API reference. Keep Temu endpoint details in `temu_API.md`; keep
operator-facing usage in `README.md`.

## 2026-06-07 Seller Center Login Refactor

Seller Center and AgentSeller login handling is centralized in
`scripts/temu-login-helper.mjs`.

Current consumers:

- `scripts/temu-report.mjs`
- `scripts/temu-abnormal-orders.mjs`
- `scripts/temu-operation-status.mjs`
- `scripts/temu-shop-funds.mjs`
- `scripts/temu-price-adjust-reject.mjs`

Keep business extraction, shop matching, JSON output, image generation, and
Enterprise WeChat delivery outside the login helper.

### Ownership Boundaries

- `scripts/temu-report.mjs` still owns the `ads.temu.com` entry flow.
- `scripts/temu-login-helper.mjs` owns Seller Center login, Seller Center
  authorization, AgentSeller `auth/authentication` transition handling, page
  close recovery, and login-page state classification.
- `scripts/temu-consent-helper.mjs` owns agreement checkbox detection and
  clicking.
- API behavior and endpoint notes belong in `temu_API.md`, not here.

### Login URL States

Treat these URLs as not-ready/login-transition pages:

- `https://seller.kuajingmaihuo.com/login`
- `https://seller.kuajingmaihuo.com/settle/seller-login`
- `https://seller.kuajingmaihuo.com/settle/activity-login`
- `https://agentseller.temu.com/auth/authentication`
- `https://agentseller-eu.temu.com/auth/authentication`
- `https://agentseller-us.temu.com/auth/authentication`

Do not treat URL alone as positive proof of readiness. Use URL as a negative
signal, then let the target business page/API prove readiness.

### Seller Center State Machine

`loginSellerIfNeeded()` classifies Seller Center pages into these practical
states:

- `seller_identity_login`: account/password login page, including QR-first pages
  after switching to phone or email login.
- `seller_authorize`: authorization confirmation page with labels such as
  `确认授权并前往`, `授权并前往`, `授权登录`, or `同意并登录`.
- `seller_pending`: login URL is present but the DOM has not exposed enough
  usable login or authorization controls yet.
- `transition_closed`: the old login page closed during a redirect or successful
  login transition.
- `verification_required`: SMS, captcha, slider, or similar human verification.
- `ready`: not on a known login/authorization transition page.

Important behavior:

- `seller_pending` waits on its own timeout and must not consume real login
  attempts.
- Increment login attempts only immediately before clicking the login or
  authorization button.
- If the old login/auth page remains open but another page has already moved to
  Seller Center or AgentSeller, prefer the transitioned page.
- If a page closes while saved-password autofill is running, search the browser
  context for a live transitioned page before failing.
- Verification-required pages are external blockers. Fail clearly instead of
  retrying as a normal login failure.

### Consent Checkbox Rule

On `settle/seller-login` and `settle/activity-login`, the account/password flow
must actively check the authorization agreement before filling the password and
before clicking authorization/login.

The consent helper must recognize long authorization text such as:

```text
您授权您的账号ID和店铺名称...
```

If this checkbox is missed, the page can repeatedly retry or remain on the login
form even though credentials were filled.

### AgentSeller Authentication Middle Page

For `agentseller*.temu.com/auth/authentication`, click the `中国地区 / 商家中心`
row using structural selectors first:

- root: `#sca-auth-root`
- row: class containing `authentication_regionItem`
- region text: class containing `authentication_regionPre`
- click target: class containing `authentication_goto`

Keep the older text/parent fallback because Temu may change CSS-module suffixes
or page nesting.

### Verification Guidance

For login-helper changes, run at least:

```bash
node --check scripts/temu-consent-helper.mjs \
  scripts/temu-login-helper.mjs \
  scripts/temu-report.mjs \
  scripts/temu-abnormal-orders.mjs \
  scripts/temu-operation-status.mjs \
  scripts/temu-shop-funds.mjs \
  scripts/temu-price-adjust-reject.mjs

git diff --check
```

Use a synthetic page test for consent-checkbox ordering when the real CDP
profile is already logged in. A no-send full report run does not prove the
logged-out Seller Center login path unless the relevant CDP profile is actually
logged out or manually placed on the target login page first.

When a real logged-out verification is needed, use:

```bash
TEMU_SEND_WECOM=0 TEMU_ACCOUNT_RETRY_ATTEMPTS=1 TEMU_OPERATION_ACCOUNT_RETRY_ATTEMPTS=1 npm run temu:report:all:image
```

Do not count this as login-path proof if the run starts from an already logged-in
Chrome profile.

### Real Logged-Out Verification Notes

Do not validate Seller Center login by opening these pages directly:

- `https://seller.kuajingmaihuo.com/settle/activity-login`
- `https://seller.kuajingmaihuo.com/settle/seller-login`

Those direct URLs can miss the required source context and show transient
messages such as `获取公钥失败，请刷新页面` or `请访问agentSeller主页操作登录`.
That is not the same as the production automation path.

Use the real upstream entry instead:

- Ads report login path: clear the profile login state, then start from the
  ads report flow (`npm run temu:report`) so Ads triggers `settle/activity-login`.
- AgentSeller login path: clear the profile login state, then start from an
  AgentSeller business page such as `https://agentseller.temu.com/goods/list`
  or run `npm run temu:operation-status` so AgentSeller triggers
  `auth/authentication -> settle/seller-login`.

The `获取公钥失败` page is treated as a transient Seller Center login failure. The
helper may do a limited refresh, but if it does not recover, the practical
resolution is to restart from the correct upstream entry and log in again.

## 2026-06-07 Data Scanner Architecture Phase 1

The first reusable data-scanning slice is intentionally small. Do not add a
generic scanner directory or runner until more scripts have been migrated and
the interface has settled.

New shared helpers:

- `scripts/temu-page-api-client.mjs`: browser-page POST/JSON helper for Temu
  API calls that need the current page context, cookies, optional `mallid`, and
  AgentSeller `Anti-Content`.
- `scripts/temu-mall-resolver.mjs`: exact-only mall resolver for
  `userInfo -> mallList -> mallName -> mallId`.

Current consumers:

- `scripts/temu-operation-status.mjs`
- `scripts/temu-abnormal-orders.mjs`
- `scripts/temu-price-adjust-reject.mjs`

These scripts now demonstrate the intended split:

- login/authentication stays in `scripts/temu-login-helper.mjs`;
- page-context API transport stays in `scripts/temu-page-api-client.mjs`;
- exact mall lookup stays in `scripts/temu-mall-resolver.mjs`;
- each consumer keeps only its own business-specific collection, validation,
  JSON formatting, and message summarization.

Other scripts are not migrated yet:

- `scripts/temu-shop-funds.mjs`
- `scripts/temu-report.mjs`

Future scanner work should migrate those scripts incrementally, one consumer at
a time, preserving existing JSON shape, error codes, and delivery behavior. Keep
exact shop-name matching; do not introduce fuzzy mall matching.
