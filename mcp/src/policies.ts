// Policy RAG: LangChain PGVectorStore over lumen_policies (id uuid, text text, metadata jsonb, embedding vector(768)).
import { PGVectorStore } from '@langchain/pgvector'
import { config } from './config.js'
import { pool, query } from './db.js'
import { policyEmbeddings } from './embeddings.js'

const policyVectorStore = new PGVectorStore(policyEmbeddings, {
  pool,
  tableName: config.policyIndex,
  distanceStrategy: 'cosine',
  // Return 1 - cosine distance, so higher = more similar.
  scoreNormalization: 'similarity',
})

export interface PolicyPassage {
  text: string
  source: string
  title: string
  section: string | null
  version: string | null
  score: number
}

// Full-text search: any meaningful word of the question may match (OR), ranked by ts_rank_cd,
// so "return window for shoes" finds the return-window passage without an embedding model.
async function searchPoliciesFullText(question: string, topK: number): Promise<PolicyPassage[]> {
  const rows = await query(
    `WITH q AS (
       SELECT to_tsquery('english', replace(plainto_tsquery('english', $1)::text, ' & ', ' | ')) AS tsq
     )
     SELECT p.text, p.metadata, ts_rank_cd(to_tsvector('english', p.text), q.tsq, 32) AS score
       FROM ${config.policyIndex} p, q
      WHERE q.tsq IS NOT NULL AND to_tsvector('english', p.text) @@ q.tsq
      ORDER BY score DESC
      LIMIT $2`,
    [question, topK],
  )
  return rows.map((r) => ({
    text: r.text,
    source: r.metadata?.source,
    title: r.metadata?.title,
    section: r.metadata?.section ?? null,
    version: r.metadata?.version ?? null,
    score: Number(Number(r.score).toFixed(3)),
  }))
}

// Retrieve the most relevant approved policy passages for a question.
export async function searchPolicies(question: string, topK = 4, minScore = 0.2): Promise<PolicyPassage[]> {
  if (config.policySearch === 'fulltext') return searchPoliciesFullText(question, topK)
  const results = await policyVectorStore.similaritySearchWithScore(question, topK)
  return results
    .filter(([, score]) => score >= minScore)
    .map(([doc, score]) => ({
      text: doc.pageContent,
      source: doc.metadata.source,
      title: doc.metadata.title,
      section: doc.metadata.section ?? null,
      version: doc.metadata.version ?? null,
      score: Number(score.toFixed(3)),
    }))
}
