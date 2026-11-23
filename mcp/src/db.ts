// Postgres pool (same database as the Lumen Concierge app). On Vercel use the pooled connection string.
import pg from 'pg'
import { config, serverless } from './config.js'

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  ...(serverless ? { idleTimeoutMillis: 10_000 } : {}),
})

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  const result = await pool.query<T>(text, params)
  return result.rows
}
