// Support agent tools: policy search (RAG), order status and return requests.
//
// Security rule: the customer ID always comes from the server-side session
// (LangGraph runtime context), never from the model. The model cannot look up another
// customer's orders even if a prompt tells it to.
import { tool, type ToolRuntime } from '@langchain/core/tools'
import { z } from 'zod'
import { query, pool } from '../db/pool.js'
import { searchPolicies } from '../rag/search.js'
import type { TurnContext } from '../agents/context.js'

type Runtime = ToolRuntime<unknown, TurnContext>

function customerIdFrom(runtime: Runtime): string {
  const id = runtime.context?.customerId
  if (!id) throw new Error('No authenticated customer for this session.')
  return id
}

export const searchPoliciesTool = tool(
  async ({ question }) => {
    const passages = await searchPolicies(question)
    if (passages.length === 0) return JSON.stringify({ found: false, message: 'No approved policy covers this question.' })
    return JSON.stringify({ found: true, passages })
  },
  {
    name: 'search_policies',
    description:
      'Search Lumen Retail approved policy documents (returns, refunds, delivery, warranty, promotions, FAQ, privacy, consumer rights). ' +
      'Always use this before answering any policy question, and cite the source title.',
    schema: z.object({
      question: z.string().describe('The policy question in plain words'),
    }),
  },
)

export const getOrderStatusTool = tool(
  async ({ orderId }, runtime: Runtime) => {
    const customerId = customerIdFrom(runtime)

    if (!orderId) {
      const orders = await query(
        `SELECT order_id, status, order_date::text, delivery_date::text, total_inr::float AS total_inr
           FROM orders WHERE customer_id = $1 ORDER BY order_date DESC LIMIT 5`,
        [customerId],
      )
      return JSON.stringify({ orders })
    }

    const [order] = await query(
      `SELECT order_id, status, order_date::text, delivery_date::text, courier, tracking_ref, delivery_city, total_inr::float AS total_inr
         FROM orders WHERE order_id = $1 AND customer_id = $2`,
      [orderId.trim().toUpperCase(), customerId],
    )
    // Same answer whether the order doesn't exist or belongs to someone else: no data leak.
    if (!order) return JSON.stringify({ found: false, message: 'No order with that number was found on your account.' })

    const items = await query(
      `SELECT oi.product_id, p.name, p.category, oi.size, oi.quantity, oi.price_inr::float AS price_inr
         FROM order_items oi JOIN products p ON p.product_id = oi.product_id WHERE oi.order_id = $1`,
      [order.order_id],
    )
    const returns = await query('SELECT return_id, product_id, status FROM returns WHERE order_id = $1', [order.order_id])
    return JSON.stringify({ found: true, order, items, returns })
  },
  {
    name: 'get_order_status',
    description:
      "Get status, delivery date, courier and items for one of the logged-in customer's orders. " +
      'If no order ID is given, list the customer’s recent orders.',
    schema: z.object({
      orderId: z.string().optional().describe('Order number, e.g. LUM-ORD-20261101-0001'),
    }),
  },
)

export const prepareReturnRequestTool = tool(
  async ({ orderId, productId, reason }, runtime: Runtime) => {
    const customerId = customerIdFrom(runtime)
    const [order] = await query(
      `SELECT order_id, status, delivery_date, (CURRENT_DATE - delivery_date) AS days_since_delivery
         FROM orders WHERE order_id = $1 AND customer_id = $2`,
      [orderId.trim().toUpperCase(), customerId],
    )
    if (!order) return JSON.stringify({ created: false, message: 'No order with that number was found on your account.' })
    if (order.status !== 'delivered') {
      return JSON.stringify({ created: false, message: `This order is "${order.status}". Returns can start after delivery.` })
    }

    const [item] = await query(
      `SELECT oi.product_id, p.name, p.category, p.return_window_days
         FROM order_items oi JOIN products p ON p.product_id = oi.product_id
        WHERE oi.order_id = $1 AND oi.product_id = $2`,
      [order.order_id, productId],
    )
    if (!item) return JSON.stringify({ created: false, message: 'That product is not part of this order.' })

    const windowDays = item.return_window_days
    if (order.days_since_delivery > windowDays) {
      return JSON.stringify({
        created: false,
        message: `The ${windowDays}-day return window for ${item.category} ended (delivered ${order.days_since_delivery} days ago). The customer can contact support for warranty help.`,
      })
    }
    const [existing] = await query(
      `SELECT return_id, status FROM returns WHERE order_id = $1 AND product_id = $2 AND status <> 'rejected'`,
      [order.order_id, productId],
    )
    if (existing) return JSON.stringify({ created: false, message: `A return already exists: ${existing.return_id} (${existing.status}).` })

    const { rows } = await pool.query(
      `INSERT INTO returns (return_id, order_id, product_id, customer_id, reason)
       VALUES ('LUM-RET-' || lpad(nextval('return_seq')::text, 6, '0'), $1, $2, $3, $4)
       RETURNING return_id, status`,
      [order.order_id, productId, customerId, reason],
    )
    return JSON.stringify({
      created: true,
      returnId: rows[0].return_id,
      status: 'pending_approval',
      product: item.name,
      message: 'Return request created. A Lumen team member will review it; the customer is notified after approval.',
    })
  },
  {
    name: 'prepare_return_request',
    description:
      'Create a return request for an item in one of the customer’s delivered orders. ' +
      'The request is saved as PENDING APPROVAL; a Lumen staff member approves or rejects it. ' +
      'This tool never approves returns or issues refunds. Confirm the item and reason with the customer before calling.',
    schema: z.object({
      orderId: z.string(),
      productId: z.string(),
      reason: z.string().min(3).describe('Customer’s reason for the return'),
    }),
  },
)
