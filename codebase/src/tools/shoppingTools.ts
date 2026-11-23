// Shopping agent tools: product search and stock check (PostgreSQL).
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { PRODUCT_CATEGORIES } from '../productCategories.js'

export const searchProductsTool = tool(
  async ({ keywords, category, brand, maxPriceInr, size, limit = 5 }) => {
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
    return JSON.stringify({ count: rows.length, products: rows })
  },
  {
    name: 'search_products',
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
  },
)

export const checkInventoryTool = tool(
  async ({ productId, size }) => {
    const [product] = await query('SELECT product_id, name, sizes FROM products WHERE product_id = $1', [productId])
    if (!product) return JSON.stringify({ found: false, message: `No product with ID ${productId}.` })

    const rows = await query(
      `SELECT size, location, quantity FROM inventory
        WHERE product_id = $1 ${size ? 'AND size = $2' : ''}
        ORDER BY size, location`,
      size ? [productId, size] : [productId],
    )
    if (size && rows.length === 0) {
      return JSON.stringify({ found: true, product: product.name, size, available: false, message: `Size ${size} is not made for this product.`, sizesOffered: product.sizes })
    }
    const inStock = rows.filter((r) => r.quantity > 0)
    return JSON.stringify({
      found: true,
      product: product.name,
      size: size ?? 'all',
      available: inStock.length > 0,
      locations: rows,
    })
  },
  {
    name: 'check_inventory',
    description: 'Check live stock for one product, optionally for a specific size, across the online warehouse and stores.',
    schema: z.object({
      productId: z.string().describe('Product ID, e.g. LUM-PRD-0001'),
      size: z.string().optional(),
    }),
  },
)
