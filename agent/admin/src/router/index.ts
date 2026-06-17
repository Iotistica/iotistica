import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: [
    { path: '/', redirect: '/endpoints' },
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
      path: '/endpoints',
      component: () => import('@/views/EndpointsView.vue'),
      meta: { title: 'Endpoints' },
    },
    {
      path: '/discovery-rules',
      component: () => import('@/views/DiscoveryRulesView.vue'),
      meta: { title: 'Discovery' },
    },
    {
      path: '/anomaly',
      component: () => import('@/views/AnomalyView.vue'),
      meta: { title: 'Anomaly Detection' },
    },
    {
      path: '/settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: 'Settings' },
    },
  ],
})

export default router
