// Creates the business tables and loads synthetic sample data.
// Run: npm run seed
import fs from 'node:fs/promises'
import path from 'node:path'
import { pool } from './pool.js'

const root = path.resolve(import.meta.dirname, '../..')
const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(root, 'data/seed', file), 'utf8'))

// Order dates in orders.json are offsets in days from today ("-20" = 20 days ago),
// so return-window tests behave the same whatever day you run the demo.
function dayOffset(offset: string | null): string | null {
  if (offset === null) return null
  const d = new Date()
  d.setDate(d.getDate() + Number(offset))
  return d.toISOString().slice(0, 10)
}

// Deterministic pseudo-random stock so every run gives the same numbers.
function stockFor(productId: string, size: string, location: string): number {
  let h = 0
  for (const ch of productId + size + location) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const n = h % 9 // 0..8
  return n <= 1 ? 0 : n // some items out of stock
}

async function main() {
  const schema = await fs.readFile(path.join(import.meta.dirname, 'schema.sql'), 'utf8')
  await pool.query(schema)

  const customers = await readJson('customers.json')
  const products = await readJson('products.json')
  const orders = await readJson('orders.json')

  for (const c of customers) {
    await pool.query('INSERT INTO customers VALUES ($1,$2,$3,$4,$5)', [c.customer_id, c.full_name, c.email, c.phone, c.city])
  }

  const locations = ['Online Warehouse', 'Mumbai Store', 'Bengaluru Store']
  for (const p of products) {
    await pool.query(
      `INSERT INTO products
         (product_id, name, brand, category, price_inr, sizes, description, rating, return_window_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        p.product_id, p.name, p.brand, p.category, p.price_inr, p.sizes, p.description, p.rating, p.return_window_days,
      ],
    )
    const sizes: string[] = p.sizes.length ? p.sizes : ['ONE']
    for (const size of sizes) {
      for (const loc of locations) {
        await pool.query('INSERT INTO inventory VALUES ($1,$2,$3,$4)', [p.product_id, size, loc, stockFor(p.product_id, size, loc)])
      }
    }
  }
  await pool.query(
    `SELECT setval('product_seq', COALESCE((SELECT max(substring(product_id from '[0-9]+$')::int)
       FROM products WHERE product_id ~ '^LUM-PRD-[0-9]+$'), 0) + 1, false)`,
  )
  // Guarantee a known test case: Stride Pro size 9 in stock online, size 11 sold out everywhere.
  await pool.query(`UPDATE inventory SET quantity = 6 WHERE product_id='LUM-PRD-0001' AND size='9' AND location='Online Warehouse'`)
  await pool.query(`UPDATE inventory SET quantity = 0 WHERE product_id='LUM-PRD-0001' AND size='11'`)

  for (const o of orders) {
    const total = o.items.reduce((sum: number, i: any) => sum + i.price_inr * i.quantity, 0)
    await pool.query('INSERT INTO orders VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      o.order_id, o.customer_id, o.status, dayOffset(o.order_date), dayOffset(o.delivery_date),
      o.courier, o.tracking_ref, o.delivery_city, total,
    ])
    for (const i of o.items) {
      await pool.query('INSERT INTO order_items VALUES ($1,$2,$3,$4,$5)', [o.order_id, i.product_id, i.size, i.quantity, i.price_inr])
    }
  }

  const [{ count }] = (await pool.query('SELECT count(*) FROM inventory')).rows
  console.log(`Seeded ${customers.length} customers, ${products.length} products, ${count} inventory rows, ${orders.length} orders.`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
