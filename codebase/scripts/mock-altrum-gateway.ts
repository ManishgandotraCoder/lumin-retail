// MOCK Altrum gateway + MOCK LLM - for local testing only, no API keys needed.
//
// This is NOT Altrum and NOT a real model. It imitates an OpenAI-compatible gateway so
// you can run and demo the whole app offline:
//   - /v1/embeddings       -> simple word-hashing vectors (lexical, deterministic)
//   - /v1/chat/completions -> a rule-based "model" that calls the right tools
//   - guardrails           -> blocks prompt injection / abuse (403 + x-altrum-action: block)
//                             masks card numbers (x-altrum-action: mask)
// For the real setup, point ALTRUM_BASE_URL at the Altrum gateway instead.
//
// Run: npm run mock-gateway   (listens on http://localhost:4000/v1)
import express from 'express'

const PORT = Number(process.env.MOCK_GATEWAY_PORT ?? 4000)
const DIM = Number(process.env.EMBEDDING_DIM ?? 1536)
const app = express()
app.use(express.json({ limit: '2mb' }))
app.get('/health', (_req, res) => res.json({ ok: true, mode: 'mock' }))

// ---------------- guardrails (imitation) ----------------
const BLOCK_RULES: Array<[RegExp, string]> = [
  [/ignore (all|any|your|the|previous|prior)[^.]{0,30}(rules|instructions|policies|prompt)/i, 'prompt injection'],
  [/(reveal|show|print)[^.]{0,20}(system prompt|instructions)/i, 'prompt extraction'],
  [/\b(jailbreak|DAN mode|developer mode)\b/i, 'jailbreak attempt'],
  [/\b(idiot|stupid bot|kill you|hate you)\b/i, 'abusive content'],
]
const CARD = /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g

const textOf = (content: any): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join(' ') : ''

// ---------------- embeddings ----------------
const STOP = new Set('the and for are you your can use how long take what when where which who does this that with from have has will not but our all any may lumen retail policy also into only per'.split(' '))
function embedText(text: string): number[] {
  const v = new Array(DIM).fill(0)
  const words = text.toLowerCase().replace(/[^a-z0-9₹ ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
  for (const raw of words) {
    const w = raw.replace(/(ing|ed|es|s)$/, '')
    let h = 2166136261
    for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
    v[h % DIM] += 1
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

app.post('/v1/embeddings', (req, res) => {
  const input: string[] = Array.isArray(req.body.input) ? req.body.input : [req.body.input]
  res.set('x-altrum-action', 'allow').json({
    object: 'list',
    model: req.body.model,
    data: input.map((t, index) => ({ object: 'embedding', index, embedding: embedText(String(t)) })),
    usage: { prompt_tokens: 0, total_tokens: 0 },
  })
})

// ---------------- rule-based "model" ----------------
type Msg = { role: string; content: any; tool_calls?: any[]; tool_call_id?: string }
type Decision = { text: string } | { tool: string; args: Record<string, unknown> }

const POLICY_WORDS = /\b(return|refund|exchange|policy|warranty|guarantee|deliver|shipping|ship|cod|cash on delivery|voucher|coupon|promo|discount|code|privacy|data|complain|grievance|cancel)\w*/i
const ORDER_ID = /LUM-ORD-\d{8}-\d{4}/i
const PRODUCT_ID = /LUM-PRD-\d{4}/gi

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return textOf(messages[i].content)
  return ''
}
function allUserText(messages: Msg[]): string {
  return messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n')
}
function budgetFrom(text: string): number | undefined {
  const m = text.match(/(?:under|below|less than|upto|up to|within|budget(?: is| of)?|max)\s*(?:rs\.?|inr|₹)?\s*([\d,]{3,7})/i)
  return m ? Number(m[1].replace(/,/g, '')) : undefined
}
function sizeFrom(text: string): string | undefined {
  return text.match(/\bsize\s*([0-9]{1,2}|xs|s|m|l|xl|xxl)\b/i)?.[1]?.toUpperCase()
}
function categoryFrom(text: string): string | undefined {
  if (/shoe|sneaker|footwear|trainer|oxford/i.test(text)) return 'Footwear'
  if (/jeans|trouser|pants|shorts|leggings|bottomwear/i.test(text)) return 'Bottomwear'
  if (/shirt|t-shirt|jacket|kurta|topwear|apparel|clothes/i.test(text)) return 'Topwear'
  if (/headphone|earbud|laptop|watch|power bank|electronic|accessor|coffee|purifier|chair|cookware|mat|home/i.test(text)) return 'Accessories'
}

// Tool results since the model last spoke to the user (this turn's tool loop).
function toolResultsThisTurn(messages: Msg[]): Array<{ name: string; result: any }> {
  const out: Array<{ name: string; result: any }> = []
  const names = new Map<string, string>()
  let lastUser = -1
  messages.forEach((m, i) => m.role === 'user' && (lastUser = i))
  for (const m of messages.slice(lastUser + 1)) {
    for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function?.name)
    if (m.role === 'tool') {
      let result: any = textOf(m.content)
      try { result = JSON.parse(result) } catch {}
      out.push({ name: names.get(m.tool_call_id ?? '') ?? 'unknown', result })
    }
  }
  return out
}

function productIdsFromLastAssistant(messages: Msg[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      const ids = textOf(messages[i].content).match(PRODUCT_ID)
      if (ids?.length) return ids.map((s) => s.toUpperCase())
    }
  }
  return []
}

function decide(messages: Msg[], toolNames: string[]): Decision {
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n')
  const user = lastUserText(messages)

  // Router call
  if (toolNames.length === 0 && /Classify the customer's latest message/.test(system)) {
    const msg = user.split('Customer message:').pop() ?? user
    const prev = user.match(/Previous agent: (\w+)/)?.[1]
    if (POLICY_WORDS.test(msg) || ORDER_ID.test(msg) || /\b(order|where is my|track|human|agent|support)\b/i.test(msg)) return { text: 'support' }
    if (/^(and |what about|how about|is it|the (first|second|third))/i.test(msg.trim()) && prev === 'support') return { text: 'support' }
    return { text: 'shopping' }
  }

  const results = toolResultsThisTurn(messages)
  const has = (t: string) => toolNames.includes(t)
  const called = (t: string) => results.some((r) => r.name === t)

  // Multi-step return flow: order looked up -> create the return request.
  if (has('prepare_return_request') && /\breturn\b/i.test(user) && called('get_order_status') && !called('prepare_return_request')) {
    const order = results.find((r) => r.name === 'get_order_status')?.result
    if (order?.found && /because|reason|too (small|big|large|tight)|damaged|defective|don'?t (like|want)/i.test(user)) {
      const wantedCategory = categoryFrom(user)
      const item = order.items.find((i: any) => !wantedCategory || i.category === wantedCategory) ?? order.items[0]
      return { tool: 'prepare_return_request', args: { orderId: order.order.order_id, productId: item.product_id, reason: user.slice(0, 200) } }
    }
  }

  if (results.length > 0) return { text: compose(results, user) }

  // First step of a turn: pick a tool.
  if (has('get_order_status') && (ORDER_ID.test(user) || /\b(my orders?|where is my|track|order status)\b/i.test(user))) {
    const orderId = user.match(ORDER_ID)?.[0]
    return { tool: 'get_order_status', args: orderId ? { orderId } : {} }
  }
  if (has('search_policies') && (POLICY_WORDS.test(user) || /\?/.test(user))) {
    return { tool: 'search_policies', args: { question: user } }
  }
  if (has('check_inventory') && /\b(available|in stock|stock|availability|have it)\b/i.test(user)) {
    const ids = user.match(PRODUCT_ID)?.map((s) => s.toUpperCase()) ?? productIdsFromLastAssistant(messages)
    const ordinal = /\bsecond\b|\b2nd\b/i.test(user) ? 1 : /\bthird\b|\b3rd\b/i.test(user) ? 2 : 0
    const productId = ids[ordinal] ?? ids[0]
    if (productId) return { tool: 'check_inventory', args: { productId, ...(sizeFrom(user) ? { size: sizeFrom(user) } : {}) } }
  }
  if (has('search_products')) {
    // Conversation memory: budget/size/category from earlier messages if not in this one.
    const history = allUserText(messages)
    const args: Record<string, unknown> = {}
    const category = categoryFrom(user) ?? categoryFrom(history)
    const maxPriceInr = budgetFrom(user) ?? budgetFrom(history)
    const size = sizeFrom(user) ?? sizeFrom(history)
    if (category) args.category = category
    if (maxPriceInr) args.maxPriceInr = maxPriceInr
    if (size) args.size = size
    if (/running/i.test(user + history)) args.keywords = 'running'
    return { tool: 'search_products', args }
  }
  return { text: "I can help with products, orders, returns and Lumen policies. What would you like to know?" }
}

const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN')}`

function compose(results: Array<{ name: string; result: any }>, user: string): string {
  const parts: string[] = []
  if (/\[CARD\]/.test(user)) parts.push('Please never share card details in chat; Lumen will never ask for them.')
  for (const { name, result: r } of results) {
    if (name === 'search_products') {
      if (!r.count) parts.push("I couldn't find products matching that. Could you change the budget or category?")
      else parts.push('Here are some options:\n' + r.products.slice(0, 3).map((p: any) =>
        `- ${p.name} by ${p.brand}, ${inr(p.price_inr)} [${p.product_id}] - rated ${p.rating}★${p.total_stock ? '' : ' (currently out of stock)'}`).join('\n'))
    } else if (name === 'check_inventory') {
      if (!r.found) parts.push(r.message)
      else if (r.message) parts.push(r.message)
      else if (r.available) {
        const where = r.locations.filter((l: any) => l.quantity > 0).map((l: any) => `${l.location} (${l.quantity})`).join(', ')
        parts.push(`Yes, ${r.product}${r.size !== 'all' ? ` in size ${r.size}` : ''} is available at: ${where}.`)
      } else parts.push(`Sorry, ${r.product}${r.size !== 'all' ? ` in size ${r.size}` : ''} is out of stock right now.`)
    } else if (name === 'search_policies') {
      if (!r.found) parts.push("I couldn't find an approved Lumen policy that covers this. I can connect you to Lumen support.")
      else {
        // A real LLM reads all passages; the mock just quotes the top two.
        const top = r.passages.slice(0, 2)
        const body = top.map((p: any) => p.text.replace(/^#\s.*$/gm, '').replace(/\n{2,}/g, '\n').trim().slice(0, 450)).join('\n\n')
        parts.push(`${body}\n\nSource: ${[...new Set(top.map((p: any) => p.title))].join('; ')}`)
      }
    } else if (name === 'get_order_status') {
      if (r.orders) parts.push('Your recent orders:\n' + r.orders.map((o: any) => `- ${o.order_id}: ${o.status}, ${inr(o.total_inr)}`).join('\n'))
      else if (!r.found) parts.push(r.message)
      else {
        const o = r.order
        const items = r.items.map((i: any) => `${i.name}${i.size ? ` (size ${i.size})` : ''}`).join(', ')
        parts.push(`Order ${o.order_id} is **${o.status.replace(/_/g, ' ')}**. Items: ${items}. ` +
          (o.status === 'delivered' ? `Delivered on ${o.delivery_date}.` : `Expected delivery: ${o.delivery_date}.`) +
          (o.courier ? ` Courier: ${o.courier}, tracking ${o.tracking_ref}.` : ''))
      }
    } else if (name === 'prepare_return_request') {
      parts.push(r.created
        ? `I've created return request ${r.returnId} for ${r.product}. Its status is PENDING APPROVAL - a Lumen team member will review it and you'll be notified.`
        : r.message)
    }
  }
  return parts.join('\n\n')
}

// ---------------- HTTP: chat completions (stream + non-stream) ----------------
app.post('/v1/chat/completions', (req, res) => {
  const messages: Msg[] = req.body.messages ?? []
  const toolNames: string[] = (req.body.tools ?? []).map((t: any) => t.function?.name).filter(Boolean)
  const user = lastUserText(messages)

  // Input guardrail (only on the customer's text, as a real gateway would).
  for (const [re, reason] of BLOCK_RULES) {
    if (re.test(user)) {
      return res.status(403).set('x-altrum-action', 'block').set('x-altrum-request-id', `mock-${Date.now()}`)
        .json({ error: { type: 'guardrail_violation', message: `Blocked by guardrail: ${reason}` } })
    }
  }
  let action = 'allow'
  for (const m of messages) {
    if (m.role === 'user' && textOf(m.content).match(CARD)) {
      m.content = textOf(m.content).replace(CARD, '[CARD]')
      action = 'mask'
    }
  }

  const decision = decide(messages, toolNames)
  const id = `chatcmpl-mock-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const model = req.body.model
  const toolCall = 'tool' in decision
    ? { id: `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: decision.tool, arguments: JSON.stringify(decision.args) } }
    : null
  const finish = toolCall ? 'tool_calls' : 'stop'
  const usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }

  res.set('x-altrum-action', action).set('x-altrum-request-id', `mock-${Date.now()}`)

  if (!req.body.stream) {
    return res.json({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: toolCall ? null : (decision as any).text, ...(toolCall ? { tool_calls: [toolCall] } : {}) } }],
      usage,
    })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }] })

  chunk({ role: 'assistant', content: '' })
  if (toolCall) chunk({ tool_calls: [{ index: 0, ...toolCall }] })
  else for (const piece of (decision as any).text.match(/[\s\S]{1,40}/g) ?? ['']) chunk({ content: piece })
  chunk({}, finish)
  if (req.body.stream_options?.include_usage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })
  res.write('data: [DONE]\n\n')
  res.end()
})

app.listen(PORT, () => console.log(`MOCK Altrum gateway (test only) on http://localhost:${PORT}/v1`))
