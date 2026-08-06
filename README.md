# Balce Rewards — central service (prototype)

The **shared-wallet loyalty hub**. Each shop (water station, Liham Cafe, …) is a
client that calls this `/v1` API to enroll customers and move points against
**one shared per-customer balance**. Node/Express + Postgres.

This is the *central* service only — it is not a POS, and it has no shop UI.
Shops talk to it over the network with an API key.

## What it proves
- One member identity + one balance **across all shops** (earn at Liham, redeem at the water station).
- **Per-shop** earn/redeem rules (`shop_loyalty_config`).
- **Realtime enroll** with create-or-return dedup (one phone = one member).
- **Atomic, row-locked redeem** (no cross-shop double-spend).
- **Idempotent** earn/redeem (retries never double-apply).

## Run it
```bash
npm install                      # express + pg
createdb balce_rewards           # or CREATE DATABASE balce_rewards;
psql -d balce_rewards -f schema.sql

# point at your DB via PG* env
export PGHOST=localhost PGUSER=youruser PGPASSWORD=yourpass PGDATABASE=balce_rewards
node seed.js                     # creates WATER + LIHAM shops, writes keys.json
PORT=5055 node server.js         # start the API

# in another shell (uses the keys from seed):
node demo.js                     # scripted end-to-end walkthrough
```

`run-demo.sh` does the whole loop against a throwaway DB and cleans up after — handy for a quick proof.

## Endpoints (`/api/v1` — auth: `Authorization: Bearer sk_…`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/members` | Enroll (create-or-return existing) |
| GET  | `/v1/members/lookup?phone=` | Find a member + redeem value |
| GET  | `/v1/members/:id/balance` | Balance |
| POST | `/v1/members/:id/earn` | Report a sale → credit points |
| POST | `/v1/members/:id/redeem` | Spend points → discount value |
| GET  | `/v1/members/:id/ledger` | History (shop-tagged) |
| GET  | `/v1/config` | This shop's rules |

## Not in the prototype (next steps for production)
- Payment-bonus once-per-day cap, promo multipliers, tiers (the full earn engine).
- `void`/reverse endpoint, webhooks, rate limiting, key scopes/rotation UI.
- A merchant/admin dashboard.
- Offline earn-queue reconciliation (redeem stays online-only by design).

## Design
Full spec: the `/v1` design doc (shared-wallet network, schema, money-safety, enrollment & sync rules).
