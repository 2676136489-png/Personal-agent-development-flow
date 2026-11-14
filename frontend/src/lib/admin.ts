import { useCallback, useEffect, useState } from 'react'

import { fetchAdminStatus } from '../api/admin'

interface AdminAccess {
  /** 后端是否配置了管理员令牌 */
  configured: boolean
  /** 当前令牌是否已通过后端校验 */
  authenticated: boolean
  loading: boolean
  refresh: () => Promise<void>
}

/**
 * 读取当前管理员权限状态。
 *
 * 多个页面（知识库、历史运行、设置）都要根据它决定是否显示写操作，
 * 因此统一走这个 hook：令牌变更时由 client.ts 派发 `arw-admin-changed`，
 * 所有挂载中的页面会自动重新校验，不需要刷新浏览器。
 */
export function useAdminAccess(): AdminAccess {
  const [state, setState] = useState<Omit<AdminAccess, 'refresh'>>({
    configured: false,
    authenticated: false,
    loading: true,
  })

  const refresh = useCallback(async () => {
    try {
      const status = await fetchAdminStatus()
      setState({ configured: status.configured, authenticated: status.authenticated, loading: false })
    } catch {
      // 状态接口失败时按「无权限」处理：宁可多挡一次，也不误开写操作
      setState({ configured: false, authenticated: false, loading: false })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onChange = () => void refresh()
    window.addEventListener('arw-admin-changed', onChange)
    return () => window.removeEventListener('arw-admin-changed', onChange)
  }, [refresh])

  return { ...state, refresh }
}
