// RAG ingestion: policy documents -> chunks -> local embeddings -> pgvector (LangChain PGVectorStore).
// Run: npm run ingest   (re-run whenever a policy document changes)
import fs from 'node:fs/promises'
import path from 'node:path'
import { Document } from '@langchain/core/documents'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { PGVectorStore } from '@langchain/pgvector'
import { config } from '../config.js'
import { pool } from '../db/pool.js'
import { policyEmbeddings } from '../llm/embeddings.js'
import { policyStoreArgs } from './vectorStore.js'

const policiesDir = path.resolve(import.meta.dirname, '../../data/policies')

// Long sections are split further; most policy sections fit in one chunk.
const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1500, chunkOverlap: 150 })

function readMeta(markdown: string) {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? 'Untitled policy'
  const version = markdown.match(/Version\s+([\d.]+)/i)?.[1] ?? null
  const effective = markdown.match(/(?:Effective|Updated)\s+([0-9]{1,2}\s+\w+\s+\d{4})/i)?.[1] ?? null
  return { title, version, effective }
}

// One chunk per "##" section, each prefixed with "<document title> – <section>",
// so a chunk still makes sense (and embeds well) on its own.
async function chunkPolicy(file: string, markdown: string): Promise<Document[]> {
  const meta = readMeta(markdown)
  const parts = markdown.split(/^(?=##\s)/m)
  const docs: Document[] = []
  for (const part of parts) {
    const heading = part.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? null
    const body = (heading ? part.replace(/^##\s+.+$/m, '') : part.replace(/^#\s+.+$/m, '')).trim()
    if (body.length < 40) continue
    const label = heading ? `${meta.title} – ${heading}` : meta.title
    for (const piece of await splitter.splitText(body)) {
      docs.push(new Document({
        pageContent: `${label}\n${piece}`,
        metadata: { source: file, title: meta.title, section: heading, version: meta.version, effective: meta.effective, chunk: docs.length },
      }))
    }
  }
  return docs
}

async function main() {
  const files = (await fs.readdir(policiesDir)).filter((f) => f.endsWith('.md')).sort()

  const docs: Document[] = []
  for (const file of files) {
    const chunks = await chunkPolicy(file, await fs.readFile(path.join(policiesDir, file), 'utf8'))
    console.log(`  ${file}: ${chunks.length} chunks`)
    docs.push(...chunks)
  }

  // Rebuild the index from scratch so removed or edited text doesn't linger.
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
  await pool.query(`DROP TABLE IF EXISTS ${config.policyIndex}`)
  const store = await PGVectorStore.initialize(policyEmbeddings, { ...policyStoreArgs, dimensions: config.embeddingDim })
  await store.addDocuments(docs)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${config.policyIndex}_embedding_idx ON ${config.policyIndex} USING hnsw (embedding vector_cosine_ops)`,
  )

  console.log(`Ingested ${files.length} policy documents (${docs.length} chunks) into table "${config.policyIndex}".`)
  // store.end() releases the client initialize() checked out, then closes the shared pool.
  await store.end()
}

main().catch(async (err) => {
  console.error(err)
  await pool.end()
  process.exit(1)
})
