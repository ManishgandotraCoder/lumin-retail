// MCP tools over the Lumen database. SQL matches the Lumen Concierge agents' tools.
//
// Security rule: order tools act only for config.customerId (LUMEN_CUSTOMER_ID, set by whoever runs
// the server). The caller can never choose the customer.
import { z } from 'zod'
import { config } from './config.js'
import { pool, query } from './db.js'
import { searchPolicies } from './policies.js'

export const PRODUCT_CATEGORIES = ['Footwear', 'Topwear', 'Bottomwear', 'Accessories'] as const

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string
  title: string
  description: string
  readOnly: boolean
  schema: S
  run: (args: z.infer<S>) => Promise<unknown>
}
const defineTool = <S extends z.ZodObject>(def: ToolDef<S>) => def as unknown as ToolDef

function requireCustomer(): string {
  if (!config.customerId) throw new Error('No customer is configured for this server.')
  return config.customerId
}

export const searchProducts = defineTool({
  name: 'search_products',
  title: 'Search products',
  readOnly: true,
  description:
    'Search the Lumen product catalogue. Use for product discovery, recommendations and comparisons. ' +
    'Filter by keywords, category, brand, maximum price (INR) and size.',
  schema: z.object({
    keywords: z.string().optional().describe('Words to match in name or description, e.g. "running shoe", "noise cancelling"'),
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    brand: z.string().optional(),
    maxPriceInr: z.number().positive().optional(),
    size: z.string().optional().describe('Footwear or apparel size, e.g. "9" or "M"'),
    limit: z.number().int().min(1).max(10).optional().describe('Maximum results (default 5)'),
  }),
  async run({ keywords, category, brand, maxPriceInr, size, limit = 5 }) {
    const where: string[] = []
    const params: unknown[] = []
    const add = (sql: string, value: unknown) => {
      params.push(value)
      where.push(sql.replace('?', `$${params.length}`))
    }
    if (keywords) {
      // Match any meaningful keyword in name, brand or description.
      const words = keywords.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
      if (words.length) {
        const ors = words.map((w) => {
          params.push(`%${w.replace(/s$/, '')}%`)
          const p = `$${params.length}`
          return `(p.name ILIKE ${p} OR p.description ILIKE ${p} OR p.brand ILIKE ${p})`
        })
        where.push(`(${ors.join(' OR ')})`)
      }
    }
    if (category) add('p.category = ?', category)
    if (brand) add('p.brand ILIKE ?', brand)
    if (maxPriceInr) add('p.price_inr <= ?', maxPriceInr)
    if (size) add('? = ANY(p.sizes)', size)

    params.push(limit)
    const rows = await query(
      `SELECT p.product_id, p.name, p.brand, p.category, p.price_inr::float AS price_inr, p.sizes, p.description, p.rating::float AS rating,
              COALESCE(SUM(i.quantity), 0)::int AS total_stock
         FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        GROUP BY p.product_id
        ORDER BY p.rating DESC, p.price_inr ASC
        LIMIT $${params.length}`,
      params,
    )
    return { count: rows.length, products: rows }
  },
})

export const checkInventory = defineTool({
  name: 'check_inventory',
  title: 'Check inventory',
  readOnly: true,
  description: 'Check live stock for one product, optionally for a specific size, across the online warehouse and stores.',
  schema: z.object({
    productId: z.string().describe('Product ID, e.g. LUM-PRD-0001'),
    size: z.string().optional(),
  }),
  async run({ productId, size }) {
    const [product] = await query('SELECT product_id, name, sizes FROM products WHERE product_id = $1', [productId])
    if (!product) return { found: false, message: `No product with ID ${productId}.` }

    const rows = await query(
      `SELECT size, location, quantity FROM inventory
        WHERE product_id = $1 ${size ? 'AND size = $2' : ''}
        ORDER BY size, location`,
      size ? [productId, size] : [productId],
    )
    if (size && rows.length === 0) {
      return { found: true, product: product.name, size, available: false, message: `Size ${size} is not made for this product.`, sizesOffered: product.sizes }
    }
    const inStock = rows.filter((r) => r.quantity > 0)
    return { found: true, product: product.name, size: size ?? 'all', available: inStock.length > 0, locations: rows }
  },
})

export const searchPoliciesTool = defineTool({
  name: 'search_policies',
  title: 'Search store policies (RAG)',
  readOnly: true,
  description:
    'Search Lumen Retail approved policy documents (returns, refunds, delivery, warranty, promotions, FAQ, privacy, consumer rights). ' +
    'Always use this before answering any policy question, and cite the source title.',
  schema: z.object({
    question: z.string().describe('The policy question in plain words'),
  }),
  async run({ question }) {
    const passages = await searchPolicies(question)
    if (passages.length === 0) return { found: false, message: 'No approved policy covers this question.' }
    return { found: true, passages }
  },
})

export const getOrderStatus = defineTool({
  name: 'get_order_status',
  title: 'Get order status',
  readOnly: true,
  description:
    "Get status, delivery date, courier and items for one of the configured customer's orders. " +
    'If no order ID is given, list the customer’s recent orders.',
  schema: z.object({
    orderId: z.string().optional().describe('Order number, e.g. LUM-ORD-20261101-0001'),
  }),
  async run({ orderId }) {
    const customerId = requireCustomer()
    if (!orderId) {
      const orders = await query(
        `SELECT order_id, status, order_date::text, delivery_date::text, total_inr::float AS total_inr
           FROM orders WHERE customer_id = $1 ORDER BY order_date DESC LIMIT 5`,
        [customerId],
      )
      return { orders }
    }

    const [order] = await query(
      `SELECT order_id, status, order_date::text, delivery_date::text, courier, tracking_ref, delivery_city, total_inr::float AS total_inr
         FROM orders WHERE order_id = $1 AND customer_id = $2`,
      [orderId.trim().toUpperCase(), customerId],
    )
    // Same answer whether the order doesn't exist or belongs to someone else: no data leak.
    if (!order) return { found: false, message: 'No order with that number was found on your account.' }

    const items = await query(
      `SELECT oi.product_id, p.name, p.category, oi.size, oi.quantity, oi.price_inr::float AS price_inr
         FROM order_items oi JOIN products p ON p.product_id = oi.product_id WHERE oi.order_id = $1`,
      [order.order_id],
    )
    const returns = await query('SELECT return_id, product_id, status FROM returns WHERE order_id = $1', [order.order_id])
    return { found: true, order, items, returns }
  },
})

export const prepareReturnRequest = defineTool({
  name: 'prepare_return_request',
  title: 'Prepare a return request (pending staff approval)',
  readOnly: false,
  description:
    'Create a return request for an item in one of the customer’s delivered orders. ' +
    'The request is saved as PENDING APPROVAL; a Lumen staff member approves or rejects it. ' +
    'This tool never approves returns or issues refunds. Confirm the item and reason with the customer before calling.',
  schema: z.object({
    orderId: z.string(),
    productId: z.string(),
    reason: z.string().min(3).describe('Customer’s reason for the return'),
  }),
  async run({ orderId, productId, reason }) {
    const customerId = requireCustomer()
    const [order] = await query(
      `SELECT order_id, status, delivery_date, (CURRENT_DATE - delivery_date) AS days_since_delivery
         FROM orders WHERE order_id = $1 AND customer_id = $2`,
      [orderId.trim().toUpperCase(), customerId],
    )
    if (!order) return { created: false, message: 'No order with that number was found on your account.' }
    if (order.status !== 'delivered') {
      return { created: false, message: `This order is "${order.status}". Returns can start after delivery.` }
    }

    const [item] = await query(
      `SELECT oi.product_id, p.name, p.category, p.return_window_days
         FROM order_items oi JOIN products p ON p.product_id = oi.product_id
        WHERE oi.order_id = $1 AND oi.product_id = $2`,
      [order.order_id, productId],
    )
    if (!item) return { created: false, message: 'That product is not part of this order.' }

    const windowDays = item.return_window_days
    if (order.days_since_delivery > windowDays) {
      return {
        created: false,
        message: `The ${windowDays}-day return window for ${item.category} ended (delivered ${order.days_since_delivery} days ago). The customer can contact support for warranty help.`,
      }
    }
    const [existing] = await query(
      `SELECT return_id, status FROM returns WHERE order_id = $1 AND product_id = $2 AND status <> 'rejected'`,
      [order.order_id, productId],
    )
    if (existing) return { created: false, message: `A return already exists: ${existing.return_id} (${existing.status}).` }

    const { rows } = await pool.query(
      `INSERT INTO returns (return_id, order_id, product_id, customer_id, reason)
       VALUES ('LUM-RET-' || lpad(nextval('return_seq')::text, 6, '0'), $1, $2, $3, $4)
       RETURNING return_id, status`,
      [order.order_id, productId, customerId, reason],
    )
    return {
      created: true,
      returnId: rows[0].return_id,
      status: 'pending_approval',
      product: item.name,
      message: 'Return request created. A Lumen team member will review it; the customer is notified after approval.',
    }
  },
})

export const publicTools = [searchProducts, checkInventory, searchPoliciesTool]
export const customerTools = [getOrderStatus, prepareReturnRequest]
