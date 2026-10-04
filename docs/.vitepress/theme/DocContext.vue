<script setup lang="ts">
import { useData } from 'vitepress';
import { useSidebar } from 'vitepress/theme';
import { computed } from 'vue';

const { page } = useData();
const { sidebar } = useSidebar();
const section = computed(() => {
  const path = `/${page.value.relativePath
    .replace(/^en\//, '')
    .replace(/(?:\/index)?\.md$/, '')}`;
  return sidebar.value.find((group) =>
    group.items?.some((item) => item.link?.replace(/\/$/, '') === path),
  )?.text;
});
</script>

<template>
  <div v-if="section" class="limina-doc-context">
    <span>{{ section }}</span>
    <span aria-hidden="true"> / </span>
    <span>{{ page.title }}</span>
  </div>
</template>
