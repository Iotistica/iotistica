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
  ],
})

export default router
