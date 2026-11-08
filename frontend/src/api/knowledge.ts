import { apiDelete, apiGet, apiPost, apiUpload } from './client'
import type { Document, DocumentChunk, RetrievedChunk } from '../types/knowledge'
import type { KnowledgeStatus } from '../types/rag'

export function uploadDocument(file: File): Promise<Document> {
  return apiUpload<Document>('/api/knowledge/documents', file)
}

export function listDocuments(): Promise<Document[]> {
  return apiGet<Document[]>('/api/knowledge/documents')
}

export function searchKnowledge(query: string, topK = 5): Promise<RetrievedChunk[]> {
  return apiPost<RetrievedChunk[]>('/api/knowledge/search', { query, top_k: topK })
}

export function fetchKnowledgeStatus(): Promise<KnowledgeStatus> {
  return apiGet<KnowledgeStatus>('/api/knowledge/status')
}

export function fetchDocumentChunks(documentId: string): Promise<DocumentChunk[]> {
  return apiGet<DocumentChunk[]>(`/api/knowledge/documents/${documentId}/chunks`)
}

/** 用当前向量模型重算一份文档（换 embedding 后端后必须做） */
export function reindexDocument(documentId: string): Promise<Document> {
  return apiPost<Document>(`/api/knowledge/documents/${documentId}/reindex`, {})
}

export function reindexStaleDocuments(): Promise<{
  model: string
  total: number
  done: number
  failed: number
}> {
  return apiPost('/api/knowledge/reindex', {})
}

export function deleteDocument(documentId: string): Promise<{ deleted: boolean }> {
  return apiDelete<{ deleted: boolean }>(`/api/knowledge/documents/${documentId}`)
}
