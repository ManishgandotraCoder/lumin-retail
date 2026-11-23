// Lumen Concierge AI - Express API + static HTML frontend.
import crypto from 'node:crypto'
import path from 'node:path'
import express, { type Request, type Response, type NextFunction } from 'express'
import { config, type AltrumProvider } from './config.js'
import { query, pool } from './db/pool.js'
import { deleteMemory, setupMemory } from './agents/memory.js'
import { handleChatTurn } from './concierge.js'
import { audit } from './audit.js'
import { isProductCategory, PRODUCT_CATEGORIES } from './productCategories.js'
import { langsmithProject, tracingEnabled } from './observability.js'

const app = express()
app.use(express.json({ limit: '20kb' }))
app.use(express.static(path.resolve(import.meta.dirname, '../public')))

const altrumProviders: AltrumProvider[] = ['openai', 'anthropic', 'gemini']
const altrumModelOptions = {
  openai: [config.altrum.defaultModels.openai],
  anthropic: [config.altrum.defaultModels.anthropic],
  gemini: [...new Set([config.altrum.defaultModels.gemini, 'gemini/gemini-3.6-flash'])],
}

function isAltrumProvider(value: unknown): value is AltrumProvider {
  return typeof value === 'string' && altrumProviders.includes(value as AltrumProvider)
}

app.get('/api/llm-options', (_req, res) => {
  res.json({
    providers: altrumProviders,
    defaultProvider: config.altrum.provider,
    defaultModels: config.altrum.defaultModels,
    models: altrumModelOptions,
  })
})

async function getSession(sessionId: unknown) {
  if (typeof sessionId !== 'string') return null
  const [s] = await query('SELECT session_id, customer_id FROM sessions WHERE session_id = $1', [sessionId])
  return s ?? null
}

// --- Demo login: pick one of the synthetic customers ---
// In production this would be the website's real login.
app.get('/api/customers', async (_req, res) => {
  res.json(await query('SELECT customer_id, full_name, city FROM customers ORDER BY customer_id'))
})

app.post('/api/session', async (req, res) => {
  const { customerId } = req.body ?? {}
  const [customer] = await query('SELECT customer_id, full_name FROM customers WHERE customer_id = $1', [customerId])
  if (!customer) return res.status(400).json({ error: 'Unknown customer' })
  const sessionId = crypto.randomUUID()
  const greeting = `Hi ${customer.full_name.split(' ')[0]}! I'm Lumen Concierge. I can help you find products, check stock, track orders and start returns. What can I do for you?`
  await query('INSERT INTO sessions (session_id, customer_id) VALUES ($1, $2)', [sessionId, customer.customer_id])
  await query(
    'INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)',
    [sessionId, 'assistant', greeting],
  )
  res.json({ sessionId, customer, greeting })
})

app.get('/api/sessions', async (req, res) => {
  const customerId = req.query.customerId
  if (typeof customerId !== 'string') return res.status(400).json({ error: 'customerId is required' })
  res.json(await query(
    `SELECT session_id, title, created_at, updated_at
       FROM sessions WHERE customer_id = $1 ORDER BY updated_at DESC, created_at DESC`,
    [customerId],
  ))
})

app.get('/api/session/:sessionId/messages', async (req, res) => {
  const customerId = req.query.customerId
  if (typeof customerId !== 'string') return res.status(400).json({ error: 'customerId is required' })
  const session = await getSession(req.params.sessionId)
  if (!session || session.customer_id !== customerId) return res.status(404).json({ error: 'Chat not found' })
  res.json(await query(
    `SELECT role, content, info, created_at
       FROM chat_messages WHERE session_id = $1 ORDER BY id`,
    [session.session_id],
  ))
})

// --- Chat ---
app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body ?? {}
  const session = await getSession(sessionId)
  if (!session) return res.status(401).json({ error: 'Session not found. Start a new chat.' })
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'Message is required' })
  if (message.length > 2000) return res.status(400).json({ error: 'Message is too long (max 2000 characters)' })

  const provider = req.body.provider === undefined ? config.altrum.provider : req.body.provider
  if (!isAltrumProvider(provider)) return res.status(400).json({ error: 'provider must be openai, anthropic, or gemini' })
  const model = req.body.model === undefined
    ? config.altrum.defaultModels[provider]
    : typeof req.body.model === 'string' ? req.body.model.trim() : ''
  const modelId = typeof model === 'string' && model.startsWith(`${provider}/`)
    ? model.slice(provider.length + 1)
    : ''
  if (!modelId || modelId.length > 150 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(modelId) || modelId.includes('..')) {
    return res.status(400).json({ error: `model must be a valid ${provider}/ model ID` })
  }

  const result = await handleChatTurn({
    sessionId: session.session_id,
    customerId: session.customer_id,
    message: message.trim(),
    provider,
    model,
  })
  await query(
    `INSERT INTO chat_messages (session_id, role, content, info)
     VALUES ($1, 'user', $2, NULL), ($1, 'assistant', $3, $4)`,
    [session.session_id, message.trim(), result.reply, JSON.stringify(result)],
  )
  await query(
    `UPDATE sessions SET title = COALESCE(title, left($2, 60)), updated_at = now()
      WHERE session_id = $1`,
    [session.session_id, message.trim()],
  )
  res.json(result)
})

// Customer right to erasure: delete this chat's memory.
app.delete('/api/session/:sessionId/memory', async (req, res) => {
  const session = await getSession(req.params.sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  await deleteMemory(session.session_id) // LangGraph checkpoints for this chat (no-op if none yet)
  await query('DELETE FROM chat_messages WHERE session_id = $1', [session.session_id])
  await query('UPDATE sessions SET title = NULL, updated_at = now() WHERE session_id = $1', [session.session_id])
  await audit(session.session_id, 'memory_deleted', { customerId: session.customer_id })
  res.json({ deleted: true })
})

// --- Staff: human approval of return requests ---
function requireStaff(req: Request, res: Response, next: NextFunction) {
  if (req.header('x-staff-token') !== config.staffToken) return res.status(401).json({ error: 'Staff token required' })
  next()
}

function validateProduct(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Product details are required'
  const body = value as Record<string, unknown>
  const { name, brand, category, price_inr, sizes, description, rating } = body
  if (typeof name !== 'string' || !name.trim()) return 'name is required'
  if (typeof brand !== 'string' || !brand.trim()) return 'brand is required'
  if (!isProductCategory(category)) return `category must be one of: ${PRODUCT_CATEGORIES.join(', ')}`
  if (typeof price_inr !== 'number' || !Number.isFinite(price_inr) || price_inr < 0) return 'price_inr must be a non-negative number'
  if (!Array.isArray(sizes) || sizes.some((size) => typeof size !== 'string')) return 'sizes must be an array of strings'
  if (typeof description !== 'string' || !description.trim()) return 'description is required'
  if (rating != null && (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 5)) {
    return 'rating must be between 0 and 5, or null'
  }
  return null
}

app.get('/api/staff/products', requireStaff, async (_req, res) => {
  res.json(await query(
    `SELECT product_id, name, brand, category, price_inr, sizes, description, rating
       FROM products ORDER BY product_id`,
  ))
})

app.post('/api/staff/products', requireStaff, async (req, res) => {
  const body = req.body as Record<string, unknown>
  const validationError = validateProduct(body)
  if (validationError) return res.status(400).json({ error: validationError })

  const { rows: sequenceRows } = await pool.query<{ id: number }>("SELECT nextval('product_seq') AS id")
  const productId = `LUM-PRD-${String(sequenceRows[0].id).padStart(4, '0')}`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO products (product_id, name, brand, category, price_inr, sizes, description, rating)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [productId, body.name, body.brand, body.category, body.price_inr, body.sizes, body.description, body.rating],
    )
    const sizes = (body.sizes as string[]).length ? body.sizes as string[] : ['ONE']
    for (const size of sizes) {
      for (const location of ['Online Warehouse', 'Mumbai Store', 'Bengaluru Store']) {
        await client.query(
          'INSERT INTO inventory (product_id, size, location, quantity) VALUES ($1, $2, $3, 0)',
          [productId, size, location],
        )
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  const [product] = await query('SELECT * FROM products WHERE product_id = $1', [productId])
  res.status(201).json(product)
})

app.put('/api/staff/products/:productId', requireStaff, async (req, res) => {
  const body = req.body as Record<string, unknown>
  const validationError = validateProduct(body)
  if (validationError) return res.status(400).json({ error: validationError })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const updated = await client.query(
      `UPDATE products
          SET name = $2, brand = $3, category = $4, price_inr = $5, sizes = $6, description = $7, rating = $8
        WHERE product_id = $1
        RETURNING product_id, name, brand, category, price_inr, sizes, description, rating`,
      [req.params.productId, body.name, body.brand, body.category, body.price_inr, body.sizes, body.description, body.rating],
    )
    if (!updated.rowCount) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Product not found' })
    }
    const sizes = (body.sizes as string[]).length ? body.sizes as string[] : ['ONE']
    await client.query(
      'DELETE FROM inventory WHERE product_id = $1 AND NOT (size = ANY($2::text[]))',
      [req.params.productId, sizes],
    )
    for (const size of sizes) {
      for (const location of ['Online Warehouse', 'Mumbai Store', 'Bengaluru Store']) {
        await client.query(
          `INSERT INTO inventory (product_id, size, location, quantity) VALUES ($1, $2, $3, 0)
           ON CONFLICT (product_id, size, location) DO NOTHING`,
          [req.params.productId, size, location],
        )
      }
    }
    await client.query('COMMIT')
    res.json(updated.rows[0])
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

app.delete('/api/staff/products/:productId', requireStaff, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const product = await client.query('SELECT product_id FROM products WHERE product_id = $1 FOR UPDATE', [req.params.productId])
    if (!product.rowCount) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Product not found' })
    }
    const references = await client.query(
      `SELECT EXISTS (SELECT 1 FROM order_items WHERE product_id = $1)
           OR EXISTS (SELECT 1 FROM returns WHERE product_id = $1) AS in_use`,
      [req.params.productId],
    )
    if (references.rows[0].in_use) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Products in orders or return requests cannot be deleted' })
    }
    await client.query('DELETE FROM inventory WHERE product_id = $1', [req.params.productId])
    await client.query('DELETE FROM products WHERE product_id = $1', [req.params.productId])
    await client.query('COMMIT')
    res.json({ deleted: true })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

app.get('/api/staff/returns', requireStaff, async (_req, res) => {
  res.json(
    await query(
      `SELECT r.return_id, r.order_id, r.product_id, p.name AS product_name, r.customer_id, c.full_name,
              r.reason, r.status, r.created_at, r.reviewed_by, r.reviewed_at
         FROM returns r JOIN products p ON p.product_id = r.product_id JOIN customers c ON c.customer_id = r.customer_id
        ORDER BY r.created_at DESC`,
    ),
  )
})

app.post('/api/staff/returns/:returnId', requireStaff, async (req, res) => {
  const { decision, staffName } = req.body ?? {}
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' })
  if (!staffName) return res.status(400).json({ error: 'staffName is required' })
  const rows = await query(
    `UPDATE returns SET status = $1, reviewed_by = $2, reviewed_at = now()
      WHERE return_id = $3 AND status = 'pending_approval' RETURNING return_id, status`,
    [decision, staffName, req.params.returnId],
  )
  if (!rows.length) return res.status(404).json({ error: 'No pending return with that ID' })
  await audit(null, 'staff_decision', { returnId: req.params.returnId, decision, staffName })
  res.json(rows[0])
})

app.get('/api/staff/audit', requireStaff, async (_req, res) => {
  res.json(await query('SELECT id, ts, session_id, event, detail FROM audit_log ORDER BY id DESC LIMIT 100'))
})

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1')
  res.json({ ok: true })
})

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err)
  res.status(500).json({ error: 'Internal error' })
})

async function initializeUiSchema() {
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS return_window_days INTEGER NOT NULL DEFAULT 30')
  await pool.query(
    `UPDATE products SET return_window_days = 10
      WHERE lower(category) = 'electronics' AND return_window_days = 30`,
  )
  await pool.query(
    `UPDATE products
        SET category = CASE
          WHEN lower(category) = 'footwear' THEN 'Footwear'
          WHEN lower(category) = 'apparel' THEN
            CASE WHEN name ~* '(jeans|trouser|pants|shorts|leggings|bottomwear)' THEN 'Bottomwear' ELSE 'Topwear' END
          WHEN lower(category) IN ('electronics', 'home') THEN 'Accessories'
          WHEN category IN ('Footwear', 'Topwear', 'Bottomwear', 'Accessories') THEN category
          ELSE 'Accessories'
        END
      WHERE category NOT IN ('Footwear', 'Topwear', 'Bottomwear', 'Accessories')`,
  )
  await pool.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'products_category_check' AND conrelid = 'products'::regclass
       ) THEN
         ALTER TABLE products ADD CONSTRAINT products_category_check
           CHECK (category IN ('Footwear', 'Topwear', 'Bottomwear', 'Accessories'));
       END IF;
     END $$`,
  )
  await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT')
  await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()')
  await pool.query(
    `CREATE TABLE IF NOT EXISTS chat_messages (
       id BIGSERIAL PRIMARY KEY,
       session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
       role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
       content TEXT NOT NULL,
       info JSONB,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  )
  await pool.query('CREATE SEQUENCE IF NOT EXISTS product_seq START 1')
  await pool.query(
    `SELECT setval(
       'product_seq',
       GREATEST(
         COALESCE((SELECT max(substring(product_id from '[0-9]+$')::bigint)
           FROM products WHERE product_id ~ '^LUM-PRD-[0-9]+$'), 0),
         (SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END FROM product_seq)
       ) + 1,
       false
     )`,
  )
}

async function startServer() {
  if (config.ignoresLegacyLlmModel) {
    console.warn(`[altrum] LLM_MODEL does not match ${config.altrum.provider}; using the default model for that provider.`)
  }
  console.info(`[altrum] Default provider: ${config.altrum.provider}; chat-page selections can override it per request.`)
  if (config.altrum.usesSharedShoppingKey) {
    console.warn('[altrum] ALTRUM_SUPPORT_API_KEY is unset; Shopping Agent is using ALTRUM_API_KEY.')
  }
  if (config.altrum.usesSharedSupportKey) {
    console.warn('[altrum] ALTRUM_SHOPPING_API_KEY is unset; Support Agent is using ALTRUM_API_KEY.')
  }
  await initializeUiSchema()
  await setupMemory()
  console.info(tracingEnabled
    ? `[langsmith] Tracing to project "${langsmithProject}" (PII masked before upload).`
    : '[langsmith] Tracing is off. Set LANGSMITH_TRACING=true and LANGSMITH_API_KEY to enable it.')
  const server = app.listen(config.port, () => {
    console.log(`Lumen Concierge running at http://localhost:${config.port}`)
    console.log(`Staff page:            http://localhost:${config.port}/staff.html`)
    console.log(`Default LLM calls go through: ${config.altrum.baseURL}`)
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))))
  }
}

startServer().catch(async (err) => {
  console.error('[startup] failed to initialize database schema', err)
  await pool.end()
  process.exitCode = 1
})
