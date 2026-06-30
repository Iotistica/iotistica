import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: [
    { path: '/login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
    { path: '/', redirect: '/dashboard' },
    {
      path: '/dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { title: 'Dashboard' },
    },
    {
      path: '/destinations',
      component: () => import('@/views/DestinationsView.vue'),
      meta: { title: 'Destinations' },
    },
    {
      path: '/subscriptions',
      component: () => import('@/views/SubscriptionsView.vue'),
      meta: { title: 'Subscriptions' },
    },
    {
      path: '/sources',
      component: () => import('@/views/SourcesView.vue'),
      meta: { title: 'Sources' },
    },
    {
      path: '/devices',
      component: () => import('@/views/DevicesView.vue'),
      meta: { title: 'Devices' },
    },
    {
      path: '/discovery-rules',
      component: () => import('@/views/DiscoveryRulesView.vue'),
      meta: { title: 'Discovery' },
    },
    {
      path: '/applications',
      component: () => import('@/views/ContainersView.vue'),
      meta: { title: 'Applications' },
    },
    {
      path: '/anomaly',
      component: () => import('@/views/AnomalyView.vue'),
      meta: { title: 'Anomaly Detection' },
    },
    {
      path: '/terminal',
      component: () => import('@/views/TerminalView.vue'),
      meta: { title: 'Terminal' },
    },
    {
      path: '/bacnet-sim',
      component: () => import('@/views/BACnetSimView.vue'),
      meta: { title: 'BACnet Simulator' },
    },
    {
      path: '/logs',
      component: () => import('@/views/LogsView.vue'),
      meta: { title: 'Logs' },
    },
    {
      path: '/settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: 'Settings' },
    },
    {
      path: '/admin/users',
      component: () => import('@/views/UsersView.vue'),
      meta: { title: 'Users' },
    },
    {
      path: '/admin/mqtt-users',
      component: () => import('@/views/MqttUsersView.vue'),
      meta: { title: 'MQTT Users' },
    },
    {
      path: '/admin/backups',
      component: () => import('@/views/BackupsView.vue'),
      meta: { title: 'Backups' },
    },
    {
      path: '/user/profile',
      component: () => import('@/views/ProfileView.vue'),
      meta: { title: 'Profile' },
    },
    {
      path: '/support',
      component: () => import('@/views/SupportView.vue'),
      meta: { title: 'Support' },
    },
    {
      path: '/mqtt-broker',
      component: () => import('@/views/MqttBrokerView.vue'),
      meta: { title: 'MQTT Broker' },
    },
  ],
})

let authChecked = false

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  if (!authChecked) {
    const { checkAuth } = useAuth()
    await checkAuth()
    authChecked = true
  }
  const { currentUser } = useAuth()
  if (!currentUser.value) return { path: '/login' }
  return true
})

export default router
