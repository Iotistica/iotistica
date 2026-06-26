import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'Iotistica',
  tagline: 'Documentation for the Iotistica IoT platform',
  favicon: 'img/favicon.svg',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  url: 'https://docs.iotistica.com',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'iotistica',
  projectName: 'iotistica',

  onBrokenLinks: 'throw',

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  themes: [
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        language: ['en'],
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          showLastUpdateTime: true,
          showLastUpdateAuthor: false,
          editUrl:
            'https://github.com/Iotistica/iotistic/tree/master/website/documentation-site/',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.jpg',
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'Iotistica',
      logo: {
        alt: 'Iotistica',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {to: '/docs/intro', label: 'Get Started', position: 'left'},
        {to: '/docs/agent/overview', label: 'Agent', position: 'left'},
        {to: '/docs/deployment/kubernetes', label: 'Deployment', position: 'left'},
        {
          href: 'https://iotistica.com/#contact',
          label: 'Contact Us',
          position: 'right',
          className: 'navbar-contact-btn',
        },
        {
          href: 'https://github.com/iotistica/iotistica',
          position: 'right',
          className: 'header-github-link',
          'aria-label': 'GitHub repository',
        },
      ],
    },
    footer: {
      style: 'dark',
      logo: {
        alt: 'Iotistica',
        src: 'img/logo-256.png',
        href: 'https://iotistica.com',
        width: 36,
        height: 36,
      },
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Quickstart',
              to: '/docs/intro',
            },
            {
              label: 'Agent',
              to: '/docs/agent/overview',
            },
          ],
        },
        {
          title: 'Product',
          items: [
            {
              label: 'Platform Overview',
              href: 'https://iotistica.com/solutions.html',
            },
            {
              label: 'Install Guide',
              href: 'https://iotistica.com/install-guide.html',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'Company Website',
              href: 'https://iotistica.com',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/iotistica/iotistica',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} <span class="footer-brand">Iotistica</span>.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
