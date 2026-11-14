import { apiGet } from './client'

export interface AdminStatus {
  /** 后端是否配置了 ADMIN_TOKEN（false = 只读演示，写操作永久禁用） */
  configured: boolean
  /** 当前浏览器携带的令牌是否有效 */
  authenticated: boolean
}

export function fetchAdminStatus(): Promise<AdminStatus> {
  return apiGet<AdminStatus>('/api/admin/status')
}
