import { loadEnv } from '@docs-islands/utils/env';
import pkg from 'limina/package.json';
import { execSync } from 'node:child_process';
import type { DefaultTheme, LocaleSpecificConfig } from 'vitepress';

const { env } = loadEnv();
const isBuild = env === 'production';

function resolveCommitId(): string | null {
  if (!isBuild) {
    return 'dev';
  }

  try {
    return execSync('git rev-parse --short=7 HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const commitId = resolveCommitId();
const footerMessage = commitId
  ? `Released under the MIT License. (${commitId})`
  : 'Released under the MIT License. (dev)';

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
        text: pkg.version,
        items: [
          {
            text: 'Changelog',
            link: 'https://github.com/XiSenao/docs-islands/blob/main/packages/limina/CHANGELOG.md',
          },
          {
            text: 'Contributing',
            link: 'https://github.com/XiSenao/docs-islands/blob/main/.github/CONTRIBUTING.md',
          },
        ],
      },
    ],
    sidebar,
    footer: {
      message: footerMessage,
      copyright: 'Copyright © 2026-present Limina contributors',
    },
  },
};

export default config;
