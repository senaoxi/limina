import type { DefaultTheme, LocaleSpecificConfig } from 'vitepress';

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Limina',
    items: [
      {
        text: 'Overview',
        link: '/limina',
      },
      {
        text: 'Why Limina',
        link: '/why',
      },
      {
        text: 'Getting Started',
        link: '/getting-started',
      },
      {
        text: 'Core Concepts',
        link: '/concepts',
      },
      {
        text: 'Monorepo',
        link: '/monorepo',
      },
      {
        text: 'Built-in Tasks',
        link: '/built-in-tasks',
      },
      {
        text: 'Options',
        items: [
          {
            text: 'Config File',
            link: '/options/config',
          },
          {
            text: 'Checker Entries',
            link: '/options/checkers',
          },
          {
            text: 'Source Coverage',
            link: '/options/source',
          },
          {
            text: 'Graph Rules',
            link: '/options/graph-rules',
          },
          {
            text: 'Paths',
            link: '/options/paths',
          },
          {
            text: 'Proof Allowlist',
            link: '/options/proof-allowlist',
          },
          {
            text: 'Package Checks',
            link: '/options/package-checks',
          },
          {
            text: 'Pipelines',
            link: '/options/pipelines',
          },
        ],
      },
      {
        text: 'Reference',
        link: '/reference',
      },
    ],
  },
];

const config: LocaleSpecificConfig<DefaultTheme.Config> & {
  label: string;
} = {
  label: 'English',
  lang: 'en-US',
  title: 'Limina',
  description:
    'Keep TypeScript monorepos consistent from source graph to published packages.',
  themeConfig: {
    nav: [
      {
        text: 'Guide',
        link: '/getting-started',
      },
      {
        text: 'Reference',
        link: '/reference',
      },
      {
        text: 'npm',
        link: 'https://www.npmjs.com/package/limina',
      },
    ],
    sidebar,
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026-present Limina contributors',
    },
  },
};

export default config;
