-- Balce Rewards — central service (prototype schema)
-- Network-wide members + one shared balance; shops are clients that call /v1.

CREATE TABLE shops (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  code       text UNIQUE NOT NULL,          -- WATER / LIHAM …
  currency   text NOT NULL DEFAULT 'PHP',
  status     text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop_api_keys (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops(id),
  key_prefix text NOT NULL,                 -- shown in a dashboard
  key_hash   text NOT NULL,                 -- sha256(full key); raw key never stored
  scopes     text[] NOT NULL DEFAULT ARRAY['read','earn','redeem'],
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON shop_api_keys (key_hash);

CREATE TABLE shop_loyalty_config (
  shop_id         uuid PRIMARY KEY REFERENCES shops(id),
  earn_per_amount numeric NOT NULL DEFAULT 0.1,   -- points per currency unit spent
  earn_per_unit   numeric NOT NULL DEFAULT 0,     -- points per "unit" (gallon, cup, visit…)
  redeem_ratio    numeric NOT NULL DEFAULT 0.1,   -- currency value of one point
  min_redemption  integer NOT NULL DEFAULT 0,
  payment_bonus   jsonb   NOT NULL DEFAULT '{}'   -- {"qrph":3,"card":3}
);

-- The master customer registry — network-wide, one row per person, one balance.
CREATE TABLE loyalty_members (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_code      text UNIQUE NOT NULL,          -- BR-000123
  phone            text,                          -- optional; unique when present
  name             text,                          -- display name (first + last)
  first_name       text,
  last_name        text,
  nickname         text,                          -- what staff call them
  email            text,
  address_street   text,
  address_region   text,
  address_province text,
  address_city     text,
  address_barangay text,
  enrolled_shop_id uuid REFERENCES shops(id),     -- reporting only
  points_balance   numeric NOT NULL DEFAULT 0,
  tier             text NOT NULL DEFAULT 'regular',
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- One phone = one member, but phone is optional (walk-ins without one).
CREATE UNIQUE INDEX loyalty_members_phone_uniq ON loyalty_members (phone) WHERE phone IS NOT NULL;

-- Append-only truth. Every balance change writes a row, tagged by shop.
CREATE TABLE loyalty_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES shops(id),
  member_id       uuid NOT NULL REFERENCES loyalty_members(id),
  type            text NOT NULL,                  -- earned / redeemed / bonus / void
  points          numeric NOT NULL,               -- signed: earn +, redeem −
  balance_after   numeric NOT NULL,
  reference       text,                            -- shop POS txn ref
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Idempotency: a retried write with the same key can't double-apply.
CREATE UNIQUE INDEX ON loyalty_ledger (shop_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE SEQUENCE member_code_seq START 1;
