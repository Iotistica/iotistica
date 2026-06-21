import { ref } from 'vue'
import { authApi, type AuthUser } from '@/api/auth'

const currentUser = ref<AuthUser | null>(null)

export function useAuth() {
  async function checkAuth(): Promise<boolean> {
    try {
      currentUser.value = await authApi.me()
      return true
    } catch {
      currentUser.value = null
      return false
    }
  }

  async function logout(): Promise<void> {
    try { await authApi.logout() } catch { /* ignore */ }
    currentUser.value = null
  }

  return { currentUser, checkAuth, logout }
}
