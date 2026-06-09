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
    text: 'Introduction',
    items: [
      {
        text: 'What is Limina',
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
    ],
  },
  {
    text: 'Guide',
    items: [
      {
        text: 'Core Concepts',
        link: '/concepts',
      },
      {
        text: 'Built-in Tasks',
        link: '/built-in-tasks',
      },
      {
        text: 'Workflows',
        link: '/workflows',
      },
    ],
  },
  {
    text: 'In Depth',
    collapsed: true,
    items: [
      {
        text: 'Architecture Conformance',
        link: '/architecture-conformance',
      },
    ],
  },
  {
    text: 'Config Reference',
    items: [
      {
        text: 'Overview',
        link: '/config/',
      },
      {
        text: 'Config File',
        link: '/config/config-file',
      },
      {
        text: 'Checker Entries',
        link: '/config/checkers',
      },
      {
        text: 'Source Boundary',
        link: '/config/source-boundary',
      },
      {
        text: 'Source Checks',
        link: '/config/source-checks',
      },
      {
        text: 'Graph Rules',
        link: '/config/graph-rules',
      },
      {
        text: 'Condition Domains',
        link: '/config/condition-domains',
      },
      {
        text: 'Proof Allowlist',
        link: '/config/proof-allowlist',
      },
      {
        text: 'Package Checks',
        link: '/config/package-checks',
      },
      {
        text: 'Release Checks',
        link: '/config/release-checks',
      },
      {
        text: 'Pipelines',
        link: '/config/pipelines',
      },
    ],
  },
  {
    text: 'CLI Reference',
    items: [
      {
        text: 'CLI Commands',
        link: '/cli',
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
        text: 'Config',
        link: '/config/',
      },
      {
        text: 'CLI',
        link: '/cli',
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
