/*
 * Balce Rewards — central service (prototype)
 * A standalone /v1 loyalty API. Shops (water station, Liham Cafe…) are
 * clients that call this to enroll, earn, and redeem against ONE shared
 * per-customer balance. Node/Express + Postgres, to match the POS stack.
 *
 * Run:  PGDATABASE=balce_rewards_proto PORT=5055 node server.js
 * DB creds come from PG* env (PGHOST/PGUSER/PGPASSWORD/PGDATABASE), loaded
 * from a .env file if present.
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool();                 // reads PG* env
const app = express();
app.use(express.json());

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const digits = (s) => String(s || '').replace(/\D/g, '');

// ── API-key auth ──────────────────────────────────────────────────────
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Missing API key' });
  const r = await pool.query(
    `SELECT k.shop_id, k.scopes, s.code AS shop_code, s.currency
       FROM shop_api_keys k JOIN shops s ON s.id = k.shop_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`, [sha256(token)]);
  if (!r.rows.length) return res.status(401).json({ error: 'unauthorized', message: 'Invalid API key' });
  req.shop = r.rows[0];
  next();
}

const cfgCache = new Map();
async function shopCfg(shopId) {
  if (cfgCache.has(shopId)) return cfgCache.get(shopId);
  const r = await pool.query('SELECT * FROM shop_loyalty_config WHERE shop_id = $1', [shopId]);
  const c = r.rows[0];
  cfgCache.set(shopId, c);
  return c;
}
const memberView = (m) => ({
  id: m.id, member_code: m.member_code, phone: m.phone, name: m.name,
  points_balance: Number(m.points_balance), tier: m.tier,
});
async function memberById(id) {
  const r = await pool.query('SELECT * FROM loyalty_members WHERE id = $1', [id]);
  return r.rows[0];
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'balce-rewards' }));

// ── Enroll — create-or-return (realtime dedup) ────────────────────────
app.post('/v1/members', auth, async (req, res) => {
  const phone = digits((req.body || {}).phone);
  const name = (req.body || {}).name || null;
  if (!phone) return res.status(400).json({ error: 'phone_required', message: 'phone is required' });
  const existing = await pool.query('SELECT * FROM loyalty_members WHERE phone = $1', [phone]);
  if (existing.rows.length) {                                   // already a member anywhere → return them
    return res.status(200).json({ ...memberView(existing.rows[0]), already_existed: true });
  }
  const seq = await pool.query("SELECT nextval('member_code_seq') AS n");
  const code = 'BR-' + String(seq.rows[0].n).padStart(6, '0');
  const ins = await pool.query(
    `INSERT INTO loyalty_members (member_code, phone, name, enrolled_shop_id)
     VALUES ($1,$2,$3,$4) RETURNING *`, [code, phone, name, req.shop.shop_id]);
  res.status(201).json(memberView(ins.rows[0]));
});

// ── Lookup / balance (reveal-on-presentation) ─────────────────────────
app.get('/v1/members/lookup', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM loyalty_members WHERE phone = $1', [digits(req.query.phone)]);
  if (!r.rows.length) return res.status(404).json({ error: 'member_not_found', message: 'No member with that phone' });
  const cfg = await shopCfg(req.shop.shop_id);
  res.json({ ...memberView(r.rows[0]), redeem_value: round2(Number(r.rows[0].points_balance) * cfg.redeem_ratio) });
});
app.get('/v1/members/:id/balance', auth, async (req, res) => {
  const m = await memberById(req.params.id);
  if (!m) return res.status(404).json({ error: 'member_not_found' });
  const cfg = await shopCfg(req.shop.shop_id);
  res.json({ points_balance: Number(m.points_balance), redeem_value: round2(Number(m.points_balance) * cfg.redeem_ratio) });
});

// ── Earn (per-shop rates; idempotent) ─────────────────────────────────
app.post('/v1/members/:id/earn', auth, async (req, res) => {
  const { amount = 0, units = 0, payment_method, reference, idempotency_key } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (idempotency_key) {
      const dup = await client.query('SELECT * FROM loyalty_ledger WHERE shop_id=$1 AND idempotency_key=$2', [req.shop.shop_id, idempotency_key]);
      if (dup.rows.length) {
        await client.query('COMMIT');
        const m = await memberById(dup.rows[0].member_id);
        return res.json({ points_earned: Number(dup.rows[0].points), points_balance: Number(m.points_balance), ledger_id: dup.rows[0].id, replayed: true });
      }
    }
    const mres = await client.query('SELECT * FROM loyalty_members WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!mres.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'member_not_found' }); }
    const cfg = await shopCfg(req.shop.shop_id);
    const base = Math.round(Number(amount) * Number(cfg.earn_per_amount) + Number(units) * Number(cfg.earn_per_unit));
    const bonus = (payment_method && cfg.payment_bonus && cfg.payment_bonus[payment_method]) ? Number(cfg.payment_bonus[payment_method]) : 0;
    const earned = base + bonus;
    const newBal = Number(mres.rows[0].points_balance) + earned;
    await client.query('UPDATE loyalty_members SET points_balance=$1 WHERE id=$2', [newBal, req.params.id]);
    const led = await client.query(
      `INSERT INTO loyalty_ledger (shop_id,member_id,type,points,balance_after,reference,idempotency_key)
       VALUES ($1,$2,'earned',$3,$4,$5,$6) RETURNING id`,
      [req.shop.shop_id, req.params.id, earned, newBal, reference || null, idempotency_key || null]);
    await client.query('COMMIT');
    res.json({ points_earned: earned, breakdown: { base, payment_bonus: bonus }, points_balance: newBal, shop: req.shop.shop_code, ledger_id: led.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'server_error', message: e.message }); }
  finally { client.release(); }
});

// ── Redeem (atomic, row-locked, authoritative) ────────────────────────
app.post('/v1/members/:id/redeem', auth, async (req, res) => {
  const { points, reference, idempotency_key } = req.body || {};
  const pts = Number(points);
  if (!(pts > 0)) return res.status(400).json({ error: 'invalid_points', message: 'points must be > 0' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (idempotency_key) {
      const dup = await client.query('SELECT * FROM loyalty_ledger WHERE shop_id=$1 AND idempotency_key=$2', [req.shop.shop_id, idempotency_key]);
      if (dup.rows.length) {
        await client.query('COMMIT');
        const m = await memberById(dup.rows[0].member_id); const cfg = await shopCfg(req.shop.shop_id);
        const p = Math.abs(Number(dup.rows[0].points));
        return res.json({ points_redeemed: p, value: round2(p * cfg.redeem_ratio), points_balance: Number(m.points_balance), redemption_ref: dup.rows[0].id, replayed: true });
      }
    }
    const mres = await client.query('SELECT * FROM loyalty_members WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!mres.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'member_not_found' }); }
    const cfg = await shopCfg(req.shop.shop_id);
    const bal = Number(mres.rows[0].points_balance);
    if (pts < Number(cfg.min_redemption)) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'below_min_redemption', message: `Minimum redemption at this shop is ${cfg.min_redemption}`, points_balance: bal }); }
    if (pts > bal) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'insufficient_points', message: `Balance is ${bal}, cannot redeem ${pts}`, points_balance: bal }); }
    const newBal = bal - pts;
    await client.query('UPDATE loyalty_members SET points_balance=$1 WHERE id=$2', [newBal, req.params.id]);
    const led = await client.query(
      `INSERT INTO loyalty_ledger (shop_id,member_id,type,points,balance_after,reference,idempotency_key)
       VALUES ($1,$2,'redeemed',$3,$4,$5,$6) RETURNING id`,
      [req.shop.shop_id, req.params.id, -pts, newBal, reference || null, idempotency_key || null]);
    await client.query('COMMIT');
    res.json({ points_redeemed: pts, value: round2(pts * Number(cfg.redeem_ratio)), points_balance: newBal, shop: req.shop.shop_code, redemption_ref: led.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'server_error', message: e.message }); }
  finally { client.release(); }
});

// ── Ledger + config (read) ────────────────────────────────────────────
app.get('/v1/members/:id/ledger', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT l.type, l.points, l.balance_after, l.reference, s.code AS shop, l.created_at
       FROM loyalty_ledger l JOIN shops s ON s.id = l.shop_id
      WHERE l.member_id = $1 ORDER BY l.created_at DESC`, [req.params.id]);
  res.json({ entries: r.rows.map(e => ({ type: e.type, points: Number(e.points), balance_after: Number(e.balance_after), shop: e.shop, reference: e.reference })) });
});
app.get('/v1/config', auth, async (req, res) => {
  const c = await shopCfg(req.shop.shop_id);
  res.json({ shop: req.shop.shop_code, earn_per_amount: Number(c.earn_per_amount), earn_per_unit: Number(c.earn_per_unit), redeem_ratio: Number(c.redeem_ratio), min_redemption: c.min_redemption, payment_bonus: c.payment_bonus });
});

const PORT = process.env.PORT || 5055;
app.listen(PORT, () => console.log(`balce-rewards listening on :${PORT}`));
