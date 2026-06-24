<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { LockOutlined, UserOutlined } from '@ant-design/icons-vue'
import IotisticaLogo from '@/components/IotisticaLogo.vue'
import { authApi } from '@/api/auth'
import { useAuth } from '@/composables/useAuth'

const router = useRouter()
const { checkAuth } = useAuth()

const username = ref('')
const password = ref('')
const loading = ref(false)
const errorMsg = ref('')

async function submit() {
  errorMsg.value = ''
  if (!username.value.trim() || !password.value) {
    errorMsg.value = 'Please enter your username and password.'
    return
  }
  loading.value = true
  try {
    await authApi.login(username.value.trim(), password.value)
    await checkAuth()
    router.push('/')
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number }
    if (e.status === 401) {
      errorMsg.value = 'Invalid username or password.'
    } else {
      errorMsg.value = e.message ?? 'Login failed. Check agent connection.'
    }
    message.error(errorMsg.value)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">
          <IotisticaLogo :size="40" />
          <span>Iotistica</span>
        </div>
        <p class="login-sub">Sign in to continue</p>
      </div>

      <a-alert
        v-if="errorMsg"
        type="error"
        :message="errorMsg"
        show-icon
        style="margin-bottom: 20px"
      />

      <a-form layout="vertical" @finish="submit">
        <a-form-item label="Username">
          <a-input
            v-model:value="username"
            size="large"
            placeholder="Username"
            autocomplete="username"
            @pressEnter="submit"
          >
            <template #prefix><UserOutlined style="color: #bbb" /></template>
          </a-input>
        </a-form-item>

        <a-form-item label="Password" style="margin-bottom: 24px">
          <a-input-password
            v-model:value="password"
            size="large"
            placeholder="Password"
            autocomplete="current-password"
            @pressEnter="submit"
          >
            <template #prefix><LockOutlined style="color: #bbb" /></template>
          </a-input-password>
        </a-form-item>

        <a-button
          type="primary"
          size="large"
          :loading="loading"
          block
          @click="submit"
        >
          Sign in
        </a-button>
      </a-form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f0f2f5;
}

.login-card {
  width: 360px;
  background: #fff;
  border-radius: 8px;
  padding: 40px 36px 36px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
}

.login-header {
  text-align: center;
  margin-bottom: 32px;
}

.login-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 22px;
  font-weight: 700;
  color: #1677ff;
  letter-spacing: -0.3px;
  margin-bottom: 6px;
}

.login-sub {
  color: #888;
  font-size: 13px;
  margin: 0;
}
</style>
