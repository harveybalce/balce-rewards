# Integrating a POS with Balce Rewards (`/v1`)

Give this to whoever (or whatever) builds a shop POS. It's everything needed to
wire the POS into the central Balce Rewards service.

## What Balce Rewards is (context)
A **central loyalty service**. A customer has **one points balance shared across
all Balce shops**. Your POS is a *client*: it runs its own menu, cart, payment,
receipt, staff, and accounting **locally**, and calls Balce Rewards only for the
loyalty parts — identify a customer, earn points on a sale, redeem points for a
discount. **Identity and points live in Balce Rewards, never in your POS.**

## Connection
- **Base URL:** `https://<your-rewards-host>` (the deployed Balce Rewards service)
- **Auth:** every request sends header `Authorization: Bearer <SHOP_SECRET_KEY>`
  (Liham's key looks like `sk_liham_…`).
- **Keep the secret key on the POS _backend_ only** — never in the tablet/browser frontend.
- JSON in, JSON out.

## Where it plugs into checkout
1. **Customer presents member ID / phone** → look them up, show points.
   *(Only look up when they identify themselves — never browse the customer list.)*
2. **New customer wants to join** → enroll them (returns their member ID).
3. **Sale completes & customer is identified** → report the sale to earn points.
4. **Customer pays with points** → redeem; apply the returned peso value as a discount.

## The endpoints (contract)

### Enroll — `POST /v1/members`  (realtime)
```json
// request
{ "phone": "09171234567", "name": "Juan Dela Cruz" }
// 201 created  (or 200 with "already_existed": true if the phone is known)
{ "id": "…uuid…", "member_code": "BR-000123", "phone": "09171234567",
  "name": "Juan Dela Cruz", "points_balance": 0, "tier": "regular" }
```
One phone = one member across all shops. If the phone already exists (e.g. a
water-station customer), you get that existing member back — do **not** create a duplicate.

### Lookup — `GET /v1/members/lookup?phone=09171234567`  (realtime)
```json
// 200
{ "id":"…", "member_code":"BR-000123", "name":"Juan Dela Cruz",
  "points_balance": 240, "redeem_value": 24.00, "tier":"vip" }
// 404 { "error":"member_not_found" }  → offer to enroll
```

### Earn — `POST /v1/members/{id}/earn`  (may queue offline)
```json
// request — report the real sale
{ "amount": 500, "units": 0, "payment_method": "qrph",
  "reference": "LIHAM-0001", "idempotency_key": "earn_LIHAM-0001" }
// 200
{ "points_earned": 53, "breakdown": { "base": 50, "payment_bonus": 3 },
  "points_balance": 258, "shop": "LIHAM", "ledger_id": "…" }
```
Send the honest `amount` (peso spend) / `units` / `payment_method`. Balce Rewards
computes points from **Liham's own config** — don't reimplement the math, and don't
worry about the discount rule (it's enforced server-side).

### Redeem — `POST /v1/members/{id}/redeem`  (realtime, authoritative)
```json
// request
{ "points": 200, "reference": "LIHAM-0002", "idempotency_key": "redeem_LIHAM-0002" }
// 200 — apply "value" as a discount on the sale
{ "points_redeemed": 200, "value": 20.00, "points_balance": 58,
  "shop": "LIHAM", "redemption_ref": "…" }
// 422 { "error":"insufficient_points"|"below_min_redemption",
//       "message":"…", "points_balance": 58 }
```

*(Also available: `GET /v1/members/{id}/balance`, `GET /v1/members/{id}/ledger`,
`GET /v1/config` for this shop's rules.)*

## Rules the POS MUST follow
1. **Always send a unique `idempotency_key`** on earn/redeem, derived from your POS
   transaction (e.g. `earn_<posref>`, `redeem_<posref>`). A retried call with the
   same key never double-applies — this is your safety net against flaky networks.
2. **Enroll, Redeem, and Lookup are realtime** (need a live connection). If you're
   offline: capture the customer's phone and enroll later; **do not let them redeem offline**
   (the balance is shared — offline redeem risks double-spending across shops).
3. **Earn can queue offline.** If the sale went through but Rewards was unreachable,
   queue the earn call and retry when back online (same idempotency_key keeps it safe).
4. **Report the sale honestly** — Rewards decides the points, including zero when a
   discount was applied. Your POS doesn't compute points.
5. **Handle the responses:** 404 on lookup → offer enroll · 422 on redeem → show the
   message + current balance · 401 → API-key problem.

## Division of responsibility
| Your POS owns | Balce Rewards owns |
|---|---|
| Menu/modifiers, cart, payment, receipt, order tickets | Member identity + member code |
| Staff/admin accounts, shifts | The one shared points balance |
| Sales, inventory, accounting (own P&L) | Earn/redeem math + the ledger |

The POS never stores points or the master customer list — it asks Rewards, in realtime.

## Build it "ready to flip on" (important)
Build the loyalty integration **now** against this contract, but wire the connection
as **config** so activating it later is just setting env vars — no code change.

**Config (env vars, on the POS backend — supplied at deploy time):**
```
REWARDS_ENABLED=false          # flip to true when the Rewards service is live
REWARDS_HOST=                  # e.g. https://rewards.balceaquafinity.com
REWARDS_KEY=                   # this shop's secret key, e.g. sk_liham_…
```

**Isolate every Rewards call behind ONE backend module** — e.g. `rewardsClient` with
`lookup(phone)`, `enroll(phone, name)`, `earn(memberId, {...})`, `redeem(memberId, {...})`.
The rest of the POS only calls those functions; nothing else knows the API shape. The
secret key lives only in that module, on the backend — never sent to the tablet/frontend.

**Graceful degradation:** if `REWARDS_ENABLED` is false or `REWARDS_HOST` is unreachable,
the POS still rings up sales normally — it just skips the loyalty step. So you can build
and even ship the POS *before* Rewards is deployed.

**Activation checklist (when Rewards is deployed):**
1. Deploy the Rewards service, seed it, copy this shop's `sk_…` key.
2. In the POS backend `.env`: set `REWARDS_HOST`, `REWARDS_KEY`, `REWARDS_ENABLED=true`.
3. Restart the POS backend. Loyalty is live — **no code change.**

