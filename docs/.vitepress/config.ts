import { defineConfig } from 'vitepress';

import enConfig from '../en/config';
import zhConfig from '../zh/config';
import { resolveDocumentationOrigin } from './build-metadata';
import { configureReadingMarkdown } from './reading-markdown';

const base = '/repos/limina/';
const documentationOrigin = resolveDocumentationOrigin();

export default defineConfig({
  base,
  sitemap: documentationOrigin
    ? { hostname: new URL(base, documentationOrigin).href }
    : undefined,
  title: 'Limina',
  description:
    'TypeScript project graph and architecture governance for single-package projects and workspaces',
  cleanUrls: true,
  lastUpdated: true,
  markdown: {
    theme: {
      light: 'vitesse-light',
      dark: 'vitesse-dark',
    },
    config: configureReadingMarkdown,
  },
  head: [
    [
      'link',
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: `${base}logo.svg`,
      },
    ],
    ['meta', { name: 'theme-color', content: '#111827' }],
  ],
  rewrites: {
    'en/:rest*': ':rest*',
  },
  locales: {
    root: enConfig,
    zh: zhConfig,
  },
  themeConfig: {
    logo: '/logo.svg',
    outline: [2, 3],
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: {
            translations: {
              button: {
                buttonText: '搜索',
                buttonAriaLabel: '搜索文档',
              },
              modal: {
                noResultsText: '没有结果',
                resetButtonTitle: '重置搜索',
                footer: {
                  selectText: '选择',
                  navigateText: '导航',
                  closeText: '关闭',
                },
              },
            },
          },
        },
      },
    },
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/senaoxi/limina',
      },
      { icon: 'npm', link: 'https://npmjs.com/package/limina' },
    ],
  },
});
