<script setup lang="ts">
import { useData } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { computed } from 'vue';
import DocContext from './DocContext.vue';
import HomeBrand from './HomeBrand.vue';
import HomeFeatures from './HomeFeatures.vue';
import HomeInstall from './HomeInstall.vue';
import { useReadingEnhancements } from './use-reading-enhancements';

const { frontmatter, page, lang } = useData();
const isArticle = computed(
  () => !page.value.isNotFound && (frontmatter.value.layout ?? 'doc') === 'doc',
);
useReadingEnhancements(isArticle);
</script>

<template>
  <DefaultTheme.Layout :class="{ 'limina-reading': isArticle }" :lang="lang">
    <template #home-hero-info-before><HomeBrand /></template>
    <template #home-hero-actions-after><HomeInstall /></template>
    <template #home-hero-after><HomeFeatures /></template>
    <template #doc-before><DocContext /></template>
  </DefaultTheme.Layout>
</template>
