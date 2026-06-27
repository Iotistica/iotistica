<script setup lang="ts">
import { ref, computed } from 'vue'
import { message } from 'ant-design-vue'
import { UserOutlined, LockOutlined, SaveOutlined } from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { useAuth } from '@/composables/useAuth'
import { usersApi } from '@/api/users'

const { currentUser } = useAuth()

const changingPassword = ref(false)
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const saving = ref(false)

const passwordMismatch = computed(
  () => confirmPassword.value.length > 0 && newPassword.value !== confirmPassword.value,
)

async function savePassword() {
  if (!newPassword.value || newPassword.value !== confirmPassword.value) return
  if (!currentUser.value) return
  saving.value = true
  try {
    await usersApi.update(currentUser.value.username, { password: newPassword.value })
    message.success('Password updated')
    changingPassword.value = false
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to update password')
  } finally {
    saving.value = false
  }
}

function cancelPasswordChange() {
  changingPassword.value = false
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
}
</script>

<template>
  <AppLayout title="Profile">
    <div class="profile-page">

      <!-- Account info -->
      <a-card class="profile-card" title="Account">
        <div class="profile-field">
          <span class="field-label">Username</span>
          <div class="field-value">
            <UserOutlined class="field-icon" />
            {{ currentUser?.username }}
          </div>
        </div>
        <div class="profile-field">
          <span class="field-label">Role</span>
          <div class="field-value">
            <a-tag :color="currentUser?.is_superuser ? 'blue' : 'default'">
              {{ currentUser?.is_superuser ? 'Administrator' : 'User' }}
            </a-tag>
          </div>
        </div>
      </a-card>

      <!-- Change password -->
      <a-card class="profile-card" title="Password">
        <template v-if="!changingPassword">
          <p class="password-hint">Your password is managed locally on this device.</p>
          <a-button @click="changingPassword = true">
            <template #icon><LockOutlined /></template>
            Change Password
          </a-button>
        </template>

        <template v-else>
          <a-form layout="vertical" style="max-width: 400px" @finish="savePassword">
            <a-form-item
              label="New Password"
              :validate-status="newPassword.length > 0 && newPassword.length < 6 ? 'error' : ''"
              :help="newPassword.length > 0 && newPassword.length < 6 ? 'Minimum 6 characters' : ''"
            >
              <a-input-password
                v-model:value="newPassword"
                size="large"
                placeholder="New password"
                autocomplete="new-password"
              >
                <template #prefix><LockOutlined style="color: #555" /></template>
              </a-input-password>
            </a-form-item>

            <a-form-item
              label="Confirm New Password"
              :validate-status="passwordMismatch ? 'error' : ''"
              :help="passwordMismatch ? 'Passwords do not match' : ''"
            >
              <a-input-password
                v-model:value="confirmPassword"
                size="large"
                placeholder="Confirm new password"
                autocomplete="new-password"
              >
                <template #prefix><LockOutlined style="color: #555" /></template>
              </a-input-password>
            </a-form-item>

            <a-space>
              <a-button
                type="primary"
                :loading="saving"
                :disabled="!newPassword || newPassword.length < 6 || passwordMismatch"
                @click="savePassword"
              >
                <template #icon><SaveOutlined /></template>
                Save Password
              </a-button>
              <a-button @click="cancelPasswordChange">Cancel</a-button>
            </a-space>
          </a-form>
        </template>
      </a-card>

    </div>
  </AppLayout>
</template>

<style scoped>
.profile-page {
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.profile-field {
  display: flex;
  align-items: center;
  gap: 2rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.profile-field:last-child {
  border-bottom: none;
}

.field-label {
  width: 100px;
  font-size: 0.88rem;
  color: rgba(0, 0, 0, 0.45);
  flex-shrink: 0;
}

.field-value {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 500;
}

.field-icon {
  color: rgba(0, 0, 0, 0.25);
}

.password-hint {
  color: rgba(0, 0, 0, 0.45);
  font-size: 0.9rem;
  margin-bottom: 1rem;
}
</style>
