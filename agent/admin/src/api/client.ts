import axios from 'axios'

export const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '',
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
})

export interface ApiError {
  status: number
  message: string
}

client.interceptors.response.use(
  (res) => res,
  (err) => {
    const status: number = err.response?.status ?? 0
    const message: string =
      err.response?.data?.message ?? err.response?.data?.error ?? err.message ?? 'Unknown error'
    if (status === 401 && !err.config?.url?.includes('/auth/')) {
      window.location.href = '/admin/login'
    }
    return Promise.reject({ status, message } satisfies ApiError)
  },
)
