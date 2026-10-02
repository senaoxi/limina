// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- VitePress client declarations are type-only.
/// <reference path="../../client.d.ts" />

import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import HomeBrand from './HomeBrand.vue';
import HomeInstall from './HomeInstall.vue';
import HomeShowcase from './HomeShowcase.vue';

import './style.css';

const theme: Theme = {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-info-before': () => h(HomeBrand),
      'home-hero-actions-after': () => h(HomeInstall),
      'home-hero-after': () => h(HomeShowcase),
    }),
};

export default theme;
