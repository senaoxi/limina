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
  ? `根据 MIT 许可证发布。 (${commitId})`
  : '根据 MIT 许可证发布。 (dev)';

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: '入门',
    items: [
      {
        text: '什么是 Limina',
        link: '/zh/limina',
      },
      {
        text: '为什么需要 Limina',
        link: '/zh/why',
      },
      {
        text: '快速开始',
        link: '/zh/getting-started',
      },
    ],
  },
  {
    text: '指南',
    items: [
      {
        text: '核心概念',
        link: '/zh/concepts',
      },
      {
        text: '内置任务',
        link: '/zh/built-in-tasks',
      },
      {
        text: '工作流',
        link: '/zh/workflows',
      },
    ],
  },
  {
    text: '深入',
    collapsed: true,
    items: [
      {
        text: '架构一致性',
        link: '/zh/architecture-conformance',
      },
      {
        text: 'Monorepo 约束',
        link: '/zh/monorepo-constraints',
      },
      {
        text: '从 import 到 references',
        link: '/zh/import-to-references',
      },
      {
        text: '从解析到架构图',
        link: '/zh/resolution-to-architecture-graph',
      },
    ],
  },
  {
    text: '配置参考',
    items: [
      {
        text: '概览',
        link: '/zh/config/',
      },
      {
        text: '配置文件',
        link: '/zh/config/config-file',
      },
      {
        text: '检查器入口',
        link: '/zh/config/checkers',
      },
      {
        text: '源码边界',
        link: '/zh/config/source-boundary',
      },
      {
        text: '源码检查',
        link: '/zh/config/source-checks',
      },
      {
        text: '图规则',
        link: '/zh/config/graph-rules',
      },
      {
        text: '条件域',
        link: '/zh/config/condition-domains',
      },
      {
        text: '覆盖证明允许清单',
        link: '/zh/config/proof-allowlist',
      },
      {
        text: '包检查',
        link: '/zh/config/package-checks',
      },
      {
        text: '发布检查',
        link: '/zh/config/release-checks',
      },
      {
        text: '流水线',
        link: '/zh/config/pipelines',
      },
    ],
  },
  {
    text: 'CLI 参考',
    items: [
      {
        text: 'CLI 命令',
        link: '/zh/cli',
      },
    ],
  },
];

const config: LocaleSpecificConfig<DefaultTheme.Config> & {
  label: string;
  link: string;
} = {
  label: '简体中文',
  lang: 'zh-CN',
  link: '/zh/',
  title: 'Limina',
  description: '面向 TypeScript monorepo 的项目引用图编译器与架构治理 CLI。',
  themeConfig: {
    nav: [
      {
        text: '指南',
        link: '/zh/getting-started',
      },
      {
        text: '配置',
        link: '/zh/config/',
      },
      {
        text: 'CLI',
        link: '/zh/cli',
      },
      {
        text: pkg.version,
        items: [
          {
            text: '更新日志',
            link: 'https://github.com/senaoxi/docs-islands/blob/main/packages/limina/CHANGELOG.md',
          },
          {
            text: '参与贡献',
            link: 'https://github.com/senaoxi/docs-islands/blob/main/.github/CONTRIBUTING.md',
          },
        ],
      },
    ],
    sidebar,
    footer: {
      message: footerMessage,
      copyright: '版权所有 © 2026-present Limina contributors',
    },
    docFooter: {
      prev: '上一页',
      next: '下一页',
    },
    outline: {
      label: '页面导航',
      level: 'deep',
    },
    lastUpdated: {
      text: '最后更新于',
    },
    langMenuLabel: '多语言',
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    skipToContentLabel: '跳转到内容',
  },
};

export default config;
