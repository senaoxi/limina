import pkg from 'limina/package.json';
import type { DefaultTheme, LocaleSpecificConfig } from 'vitepress';
import { resolveCommitId } from '../.vitepress/build-metadata';

const commitId = resolveCommitId();
const footerMessage = commitId
  ? `依据 MIT 许可证发布（${commitId}）。`
  : '依据 MIT 许可证发布（开发版）。';

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: '入门',
    items: [
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
      {
        text: '故障排查',
        link: '/zh/troubleshooting',
      },
    ],
  },
  {
    text: '深入',
    collapsed: true,
    items: [
      {
        text: '多包仓库约束',
        link: '/zh/monorepo-constraints',
      },
      {
        text: '为什么导入不能直接等于引用',
        link: '/zh/why-import-is-not-references',
      },
      {
        text: '从导入解析到声明构建图',
        link: '/zh/import-resolution-to-declaration-build-graph',
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
        text: '治理区域',
        link: '/zh/config/regions',
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
      {
        text: '执行并发',
        link: '/zh/config/execution',
      },
    ],
  },
  {
    text: '命令行参考',
    items: [
      {
        text: '命令行命令',
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
  description: '支持单包项目与工作区的 TypeScript 项目图与架构治理命令行工具。',
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
        text: '命令行',
        link: '/zh/cli',
      },
      {
        text: pkg.version,
        items: [
          {
            text: '更新日志',
            link: 'https://github.com/senaoxi/limina/blob/main/packages/limina/CHANGELOG.md',
          },
          {
            text: '参与贡献',
            link: 'https://github.com/senaoxi/limina/blob/main/CONTRIBUTING.md',
          },
        ],
      },
    ],
    sidebar,
    footer: {
      message: footerMessage,
      copyright: '版权所有 © 2026 至今 Limina 贡献者',
    },
    docFooter: {
      prev: '上一页',
      next: '下一页',
    },
    outline: {
      label: '页面导航',
      level: [2, 3],
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
    notFound: {
      title: '未找到页面',
      quote: '请检查地址，或返回首页继续浏览。',
      linkLabel: '前往中文首页',
      linkText: '返回首页',
    },
  },
};

export default config;
