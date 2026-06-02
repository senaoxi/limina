import type { DefaultTheme, LocaleSpecificConfig } from 'vitepress';

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Limina',
    items: [
      {
        text: '概览',
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
      {
        text: '核心概念',
        link: '/zh/concepts',
      },
      {
        text: 'Monorepo',
        link: '/zh/monorepo',
      },
      {
        text: '内置任务',
        link: '/zh/built-in-tasks',
      },
      {
        text: '配置项',
        items: [
          {
            text: '配置文件',
            link: '/zh/options/config',
          },
          {
            text: 'Checker entries',
            link: '/zh/options/checkers',
          },
          {
            text: 'Source coverage',
            link: '/zh/options/source',
          },
          {
            text: 'Graph rules',
            link: '/zh/options/graph-rules',
          },
          {
            text: 'Paths',
            link: '/zh/options/paths',
          },
          {
            text: 'Proof allowlist',
            link: '/zh/options/proof-allowlist',
          },
          {
            text: 'Package checks',
            link: '/zh/options/package-checks',
          },
          {
            text: 'Pipelines',
            link: '/zh/options/pipelines',
          },
        ],
      },
      {
        text: '参考',
        link: '/zh/reference',
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
  description: '让 TypeScript monorepo 从源码依赖到发布产物都保持一致。',
  themeConfig: {
    nav: [
      {
        text: '指南',
        link: '/zh/getting-started',
      },
      {
        text: '参考',
        link: '/zh/reference',
      },
      {
        text: 'npm',
        link: 'https://www.npmjs.com/package/limina',
      },
    ],
    sidebar,
    footer: {
      message: '根据 MIT 许可证发布。',
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
