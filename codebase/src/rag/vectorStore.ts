// LangChain PGVectorStore over the local PostgreSQL + pgvector database.
// Table: lumen_policies (id uuid, text text, metadata jsonb, embedding vector(768)).
import { PGVectorStore } from '@langchain/pgvector'
import { config } from '../config.js'
import { pool } from '../db/pool.js'
import { policyEmbeddings } from '../llm/embeddings.js'

export const policyStoreArgs = {
  pool,
  tableName: config.policyIndex,
  distanceStrategy: 'cosine' as const,
  // Return 1 - cosine distance, so higher = more similar.
  scoreNormalization: 'similarity' as const,
}

export const policyVectorStore = new PGVectorStore(policyEmbeddings, policyStoreArgs)
