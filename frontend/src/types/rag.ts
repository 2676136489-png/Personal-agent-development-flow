/** 与后端 app/rag 的接口约定（见 app/api/routes/rag.py）。 */

export interface RagParamDef {
  label: string
  type: 'int' | 'float' | 'bool'
  min?: number
  max?: number
  step?: number
  default: number | boolean
  hint?: string
}

export interface RagMethodOption {
  id: string
  label: string
  summary: string
  doc_label: string
  doc_url: string
  params: string[]
  needs_embedding: boolean
  best_for: string
}

export interface RagEmbedderOption {
  id: string
  label: string
  provider: string
  model: string
  dims: number | null
  semantic: boolean
  note: string
  endpoint: string
  available: boolean
  recommended: boolean
  doc_label: string
  doc_url: string
}

export interface RagOptions {
  chunkers: RagMethodOption[]
  embedders: RagEmbedderOption[]
  retrievers: RagMethodOption[]
  params: Record<string, RagParamDef>
  defaults: {
    chunking: { strategy: string; chunk_size: number; overlap: number }
    retrieval: { method: string; top_k: number; candidate_k: number }
  }
}

export interface RagChunk {
  index: number
  content: string
  preview: string
  chars: number
  tokens: number
  char_start: number | null
  char_end: number | null
  page: number | null
  heading: string | null
}

export interface RagOverlap {
  left: number
  right: number
  chars: number
  start: number
  end: number
}

export interface RagHit {
  index: number
  score: number
  dense: number
  bm25: number
  dense_rank: number
  bm25_rank: number
  selected: boolean
  preview: string
  heading?: string | null
  page?: number | null
  content?: string
  rank?: number
}

export interface RagPoint {
  x: number
  y: number
  index: number
}

export interface RagParseDetail {
  chars: number
  paragraphs: number
  pages: number | null
  sentences: number
  preview: string
  truncated: boolean
  title: string
}

export interface RagChunkDetail {
  strategy: string
  chunks: RagChunk[]
  overlaps: RagOverlap[]
  avg_chars: number
  avg_tokens: number
  total_tokens: number
  used_embedding_for_split: boolean
}

export interface RagEmbedDetail {
  spec_id: string
  label: string
  model: string
  semantic: boolean
  dims: number
  count: number
  stats: {
    norm_min: number
    norm_max: number
    norm_mean: number
    value_min: number
    value_max: number
  }
  heatmap: { rows: number; cols: number; values: number[][]; scale: number; total_chunks: number }
  projection: RagPoint[]
  query_point: { x: number; y: number } | null
  query_preview: number[]
}

export interface RagRetrieveDetail {
  method: string
  selected: RagHit[]
  candidates: RagHit[]
  meta: Record<string, number | string | number[]>
}

export interface RagPromptDetail {
  text: string
  chars: number
  tokens: number
  context_chars: number
  entries: {
    n: number
    index: number
    score: number
    page: number | null
    heading: string | null
    chars: number
    tokens: number
  }[]
}

export type RagStageDetail = Partial<
  RagParseDetail &
    RagChunkDetail &
    RagEmbedDetail &
    RagRetrieveDetail &
    RagPromptDetail
>

export interface RagStage {
  key: 'parse' | 'chunk' | 'embed' | 'retrieve' | 'assemble' | string
  label: string
  ms: number
  summary: string
  detail: RagStageDetail
}

export interface RagRunConfig {
  chunking: {
    strategy: string
    chunk_size: number
    overlap: number
    min_chunk: number
    keep_heading: boolean
    breakpoint_percentile: number
  }
  embedding: { spec_id: string; model: string; label: string; semantic: boolean; dims: number }
  retrieval: {
    method: string
    top_k: number
    candidate_k: number
    rrf_k: number
    alpha: number
    mmr_lambda: number
    min_score: number
  }
}

export interface RagRunResult {
  run_id: string
  query: string
  title: string
  config: RagRunConfig
  stages: RagStage[]
  warnings: string[]
  total_ms: number
}

export interface RagRunRequest {
  query: string
  corpus: { kind: 'document' | 'text'; document_id?: string; text?: string; title?: string }
  chunking: {
    strategy: string
    chunk_size: number
    overlap: number
    min_chunk: number
    keep_heading: boolean
    breakpoint_percentile: number
  }
  embedding: { spec_id?: string | null }
  retrieval: {
    method: string
    top_k: number
    candidate_k: number
    rrf_k: number
    alpha: number
    mmr_lambda: number
    min_score: number
  }
}

/** /api/knowledge/status */
export interface KnowledgeStatus {
  active: RagEmbedderOption
  semantic: boolean
  degraded_reason: string | null
  candidates: RagEmbedderOption[]
  documents: number
  chunks: number
  stale_documents: number
  active_model: string
  chunk_strategy: string
  chunk_size: number
  chunk_overlap: number
}
