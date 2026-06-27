import { ref } from 'vue'
import { deviceApi } from '@/api/device'

const proInstalled = ref<boolean>(false)

export function useProStatus() {
  async function fetchProStatus(): Promise<void> {
    try {
      const info = await deviceApi.getInfo()
      proInstalled.value = info.pro_installed ?? false
    } catch {
      proInstalled.value = false
    }
  }

  return { proInstalled, fetchProStatus }
}
