// LangSmith tracing. Enabled with LANGSMITH_TRACING=true + LANGSMITH_API_KEY (see .env.example).
// Every chat turn becomes one trace: chat_turn → lumen_concierge graph → router / agent → LLM + tool runs.
// Traces are grouped per chat in LangSmith's Threads view (metadata thread_id = session ID).
// PII is masked (src/pii.ts) by the client before anything is sent to LangSmith.
import { Client } from 'langsmith'
import { createAnonymizer } from 'langsmith/anonymizer'
import { maskPII } from './pii.js'

export const tracingEnabled = ['true', '1'].includes(
  (process.env.LANGSMITH_TRACING ?? process.env.LANGCHAIN_TRACING_V2 ?? '').toLowerCase(),
)

export const langsmithClient = new Client({
  anonymizer: createAnonymizer((value) => maskPII(value)),
})

export const langsmithProject = process.env.LANGSMITH_PROJECT ?? 'default'
