import { apiGet, apiPost } from './client'
import type { RagOptions, RagRunRequest, RagRunResult } from '../types/rag'

export function fetchRagOptions(): Promise<RagOptions> {
  return apiGet<RagOptions>('/api/rag/options')
}

/**
 * 跑一次完整 RAG。
 *
 * 超时放宽到 5 分钟：语义切分 + 向量化会在服务端打几十次 embedding，
 * 云端模型 200 块左右大约 10~30 秒，云厂商偶发慢响应也不该被判成失败。
 */
export function runRagPipeline(body: RagRunRequest): Promise<RagRunResult> {
  return apiPost<RagRunResult>('/api/rag/pipeline', body)
}
