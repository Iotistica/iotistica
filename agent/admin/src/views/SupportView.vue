<script setup lang="ts">
import AppLayout from '@/components/layout/AppLayout.vue'
import { useProStatus } from '@/composables/useProStatus'
import {
  GithubOutlined,
  FileTextOutlined,
  CustomerServiceOutlined,
  MailOutlined,
  GlobalOutlined,
} from '@ant-design/icons-vue'

const { proInstalled } = useProStatus()

const resources = [
  {
    title: 'Documentation',
    description: 'Guides, API reference, and configuration options for the Iotistica agent.',
    href: 'https://iotistica.com/docs',
    icon: FileTextOutlined,
    color: '#1677ff',
  },
  {
    title: 'GitHub Issues',
    description: 'Report bugs or request features on the Community Edition repository.',
    href: 'https://github.com/Iotistica/iotistica/issues',
    icon: GithubOutlined,
    color: '#24292f',
  },
  {
    title: 'Solutions & Pricing',
    description: 'Compare Community, Agent Pro, and Pro + Ingestion to find the right fit.',
    href: 'https://iotistica.com/solutions.html',
    icon: GlobalOutlined,
    color: '#00d4aa',
  },
]
</script>

<template>
  <AppLayout title="Support">

    <!-- Community upsell banner -->
    <a-alert
      v-if="!proInstalled"
      type="info"
      show-icon
      style="margin-bottom: 24px"
    >
      <template #message>Priority support requires Agent Pro</template>
      <template #description>
        Upgrade to <strong>Iotistica Agent Pro</strong> to access priority email support,
        guaranteed response times, and direct access to the engineering team.
        <a
          href="https://iotistica.com/solutions.html"
          target="_blank"
          rel="noopener"
          style="margin-left: 12px; white-space: nowrap"
        >View Pro plans →</a>
      </template>
    </a-alert>

    <!-- Pro support panel -->
    <a-card v-if="proInstalled" style="margin-bottom: 24px">
      <template #title>
        <CustomerServiceOutlined style="margin-right: 8px" />
        Priority Support
      </template>
      <p style="color: #666; margin-bottom: 20px">
        As an Agent Pro customer you have direct access to our engineering team.
        We aim to respond within one business day.
      </p>
      <a-space direction="vertical" style="width: 100%" :size="12">
        <a-button type="primary" href="mailto:support@iotistica.com">
          <template #icon><MailOutlined /></template>
          Email Support
        </a-button>
        <a-button href="https://iotistica.com/contact.html" target="_blank">
          <template #icon><GlobalOutlined /></template>
          Open a Support Ticket
        </a-button>
      </a-space>
    </a-card>

    <!-- Community resources — visible to everyone -->
    <a-card>
      <template #title>
        <FileTextOutlined style="margin-right: 8px" />
        Community Resources
      </template>
      <a-list :data-source="resources" item-layout="horizontal">
        <template #renderItem="{ item }">
          <a-list-item>
            <a-list-item-meta>
              <template #avatar>
                <a-avatar :style="{ background: item.color }">
                  <template #icon><component :is="item.icon" /></template>
                </a-avatar>
              </template>
              <template #title>
                <a :href="item.href" target="_blank" rel="noopener">{{ item.title }}</a>
              </template>
              <template #description>{{ item.description }}</template>
            </a-list-item-meta>
          </a-list-item>
        </template>
      </a-list>
    </a-card>

  </AppLayout>
</template>
