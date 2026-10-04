// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- VitePress client declarations are type-only.
/// <reference path="../../client.d.ts" />

import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import ArticleLayout from './ArticleLayout.vue';
import ReadingTable from './ReadingTable.vue';

import './style.css';
import './styles/reading-tokens.css';
import './styles/reading.css';

const theme: Theme = {
  extends: DefaultTheme,
  Layout: ArticleLayout,
  enhanceApp: ({ app }) => {
    app.component('ReadingTable', ReadingTable);
  },
};

export default theme;
