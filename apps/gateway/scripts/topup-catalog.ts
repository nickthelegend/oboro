// Checks that Bitrefill accepts a named phone package: creates an UNPAID invoice (auto_pay false; nothing is charged)
// for one Jio plan to OBORO_SHOP_PHONE, prints its status and price, and leaves it to expire.
import '../src/env.js';

const key = process.env.BITREFILL_API_KEY; const phone = process.env.OBORO_SHOP_PHONE;
if (!key || !phone) throw new Error('Setup required: BITREFILL_API_KEY and OBORO_SHOP_PHONE');
const product_id = 'reliance-jio-india-bundles'; const name = process.argv[2] ?? '6GB – 7 Day Data Pack';
const res = await fetch('https://api.bitrefill.com/v2/invoices', {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ products: [{ product_id, package_id: `${product_id}<&>${name}`, quantity: 1, phone_number: phone }], payment_method: 'balance', auto_pay: false }),
});
const body = (await res.json()) as { data?: { id?: string; status?: string; price?: unknown; payment?: unknown }; error?: unknown; message?: unknown };
console.log(res.status, JSON.stringify({ id: body.data?.id, status: body.data?.status, price: body.data?.price, payment: body.data?.payment, error: body.error ?? body.message }).slice(0, 600));
