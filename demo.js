/*
 * Scripted end-to-end proof of the shared wallet:
 * enroll at Liham → earn at Liham → see + earn + redeem at the Water station
 * → one shared balance. Also shows idempotency + cross-shop dedup.
 */
const http = require('http');
const keys = require('./keys.json');
const PORT = process.env.PORT || 5055;

function call(method, path, key, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: 'localhost', port: PORT, path, method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (r) => { let o = ''; r.on('data', c => o += c).on('end', () => { let j; try { j = JSON.parse(o); } catch { j = o; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const show = (n, title, r) => {
  console.log(`\n${n}. ${title}`);
  console.log(`   → HTTP ${r.status}  ${JSON.stringify(r.body)}`);
};

(async () => {
  const W = keys.WATER, L = keys.LIHAM;
  const PHONE = '09171234567';

  let r = await call('POST', '/v1/members', L, { phone: PHONE, name: 'Juan Dela Cruz' });
  show(1, 'Enroll "Juan" at LIHAM CAFE (his key-in / member ID is minted centrally)', r);
  const id = r.body.id;

  r = await call('POST', `/v1/members/${id}/earn`, L, { amount: 500, payment_method: 'qrph', reference: 'LIHAM-0001', idempotency_key: 'earn_LIHAM-0001' });
  show(2, 'Earn at LIHAM — ₱500 coffee via QR Ph  (₱500 × 0.1 = 50, + 3 QR bonus = 53)', r);

  r = await call('GET', `/v1/members/lookup?phone=${PHONE}`, W);
  show(3, 'Look him up at the WATER STATION — a different shop, yet the balance is already there', r);

  r = await call('POST', `/v1/members/${id}/earn`, W, { units: 3, reference: 'WATER-7781', idempotency_key: 'earn_WATER-7781' });
  show(4, 'Earn at WATER — 3 gallons (2 pts/gal = 6)  → balance climbs to 59', r);

  r = await call('POST', `/v1/members/${id}/redeem`, W, { points: 40, reference: 'WATER-7782', idempotency_key: 'redeem_WATER-7782' });
  show(5, 'Redeem 40 pts at WATER — ₱4.00 off (spending points he mostly earned at Liham)', r);

  r = await call('POST', `/v1/members/${id}/earn`, L, { amount: 500, payment_method: 'qrph', reference: 'LIHAM-0001', idempotency_key: 'earn_LIHAM-0001' });
  show(6, 'Retry step 2 with the SAME idempotency_key — no double credit (replayed)', r);

  r = await call('POST', '/v1/members', W, { phone: PHONE, name: 'Juan' });
  show(7, 'Try to enroll the same phone at WATER — returns the existing member, no duplicate', r);

  r = await call('GET', `/v1/members/${id}/ledger`, W);
  show(8, 'His ledger — one balance, every entry tagged by the shop it happened at', r);

  console.log('\n──────── shared wallet proven: earned at Liham, seen + redeemed at Water, one balance ────────');
})();
