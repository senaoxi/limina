// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- VitePress client declarations are type-only.
/// <reference path="../../client.d.ts" />

import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';

import './style.css';

const theme: Theme = {
  extends: DefaultTheme,
};

export default theme;
