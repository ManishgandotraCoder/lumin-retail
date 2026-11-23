// Policy query embeddings (BAAI/bge-base-en-v1.5, 768-dim, CLS pooling, normalized).
// Vectors are written by the main app's `npm run ingest` (FastEmbed); this project only embeds queries.
//
//   EMBEDDING_PROVIDER=local        FastEmbed on CPU (optional dependency, loaded lazily)
//   EMBEDDING_PROVIDER=huggingface  Hugging Face Inference API (HF_TOKEN); use on Vercel
//
// Both use FastEmbed's "query: " / "passage: " prefixes, so they match the stored vectors.
import { Embeddings } from '@langchain/core/embeddings'
import type { FlagEmbedding } from 'fastembed'
import { config } from './config.js'

class LocalBgeEmbeddings extends Embeddings {
  private modelPromise: Promise<FlagEmbedding> | undefined

  constructor() {
    super({})
  }

  private model(): Promise<FlagEmbedding> {
    this.modelPromise ??= import('fastembed')
      .catch(() => {
        throw new Error('fastembed is not installed. Run npm install, or set EMBEDDING_PROVIDER=huggingface and HF_TOKEN.')
      })
      .then(({ EmbeddingModel, FlagEmbedding }) =>
        FlagEmbedding.init({ model: EmbeddingModel.BGEBaseENV15, cacheDir: config.embeddingCacheDir }),
      )
    return this.modelPromise
  }

  // passageEmbed/queryEmbed add the BGE prefixes themselves.
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const model = await this.model()
    const vectors: number[][] = []
    for await (const batch of model.passageEmbed(texts)) vectors.push(...batch.map((v) => Array.from(v)))
    return vectors
  }

  async embedQuery(text: string): Promise<number[]> {
    return Array.from(await (await this.model()).queryEmbed(text))
  }
}

class HuggingFaceBgeEmbeddings extends Embeddings {
  constructor() {
    super({})
  }

  private async embed(inputs: string[]): Promise<number[][]> {
    const response = await fetch(config.hfEmbeddingUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.hfToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ inputs, normalize: true }),
    })
    if (!response.ok) {
      throw new Error(`Hugging Face embeddings failed: ${response.status} ${(await response.text()).slice(0, 300)}`)
    }
    const data = (await response.json()) as unknown
    if (!Array.isArray(data) || !data.every((v) => Array.isArray(v) && v.length === config.embeddingDim && typeof v[0] === 'number')) {
      throw new Error(`Hugging Face embeddings returned an unexpected shape (expected ${inputs.length} x ${config.embeddingDim})`)
    }
    return data as number[][]
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = []
    for (let i = 0; i < texts.length; i += 32) {
      vectors.push(...(await this.embed(texts.slice(i, i + 32).map((t) => `passage: ${t}`))))
    }
    return vectors
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([`query: ${text}`])
    return vector
  }
}

export const policyEmbeddings: Embeddings =
  config.embeddingProvider === 'huggingface' ? new HuggingFaceBgeEmbeddings() : new LocalBgeEmbeddings()
