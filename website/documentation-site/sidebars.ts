import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Agent',
      items: [
        'agent/overview',
        'agent/quickstart',
        'agent/configuration',
        'agent/dashboard',
        'agent/endpoints',
        'agent/destinations',
        'agent/subscriptions',
        'agent/data-publishing',
        'agent/discovery',
        'agent/applications',
        'agent/audit',
        'agent/alerts',
        'agent/settings',
        'agent/cloud-sync',
        'agent/security',
        'agent/cli',
        'agent/api',
      ],
    },
    {
      type: 'category',
      label: 'Iotistica API',
      items: [
        'api/overview',
        'api/authentication',
        'api/endpoints',
        'api/ingestion',
        'deployment/kubernetes',
      ],
    },
  ],
};

export default sidebars;
