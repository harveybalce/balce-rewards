/*
 * Seed two mock shops (WATER + LIHAM) with their own config + an API key.
 * Prints the raw keys as JSON and writes keys.json (raw keys are shown once).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const genKey = (code) => 'sk_' + code.toLowerCase() + '_' + crypto.randomBytes(12).toString('hex');

const shops = [
  { name: 'Balce Aquafinity (Water)', code: 'WATER',
    cfg: { earn_per_amount: 0, earn_per_unit: 2, redeem_ratio: 0.10, min_redemption: 20, payment_bonus: {} } },
  { name: 'Liham Cafe', code: 'LIHAM',
    cfg: { earn_per_amount: 0.1, earn_per_unit: 0, redeem_ratio: 0.10, min_redemption: 0, payment_bonus: { qrph: 3, card: 3 } } },
];

(async () => {
  const out = {};
  for (const s of shops) {
    const sh = await pool.query('INSERT INTO shops (name, code) VALUES ($1,$2) RETURNING id', [s.name, s.code]);
    const id = sh.rows[0].id;
    await pool.query(
      `INSERT INTO shop_loyalty_config (shop_id, earn_per_amount, earn_per_unit, redeem_ratio, min_redemption, payment_bonus)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, s.cfg.earn_per_amount, s.cfg.earn_per_unit, s.cfg.redeem_ratio, s.cfg.min_redemption, JSON.stringify(s.cfg.payment_bonus)]);
    const key = genKey(s.code);
    await pool.query('INSERT INTO shop_api_keys (shop_id, key_prefix, key_hash) VALUES ($1,$2,$3)', [id, key.slice(0, 16), sha256(key)]);
    out[s.code] = key;
  }
  fs.writeFileSync(path.join(__dirname, 'keys.json'), JSON.stringify(out, null, 2));
  console.log('seeded shops:', shops.map(s => s.code).join(', '));
  await pool.end();
})();
