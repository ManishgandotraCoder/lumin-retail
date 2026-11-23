import pg from 'pg'
import { config } from '../config.js'

// One shared connection pool for business data (products, orders, returns, audit).
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 })

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  const result = await pool.query<T>(text, params)
  return result.rows
}
