<script setup lang="ts">
import { useData } from 'vitepress';
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';

defineProps<{ wide: boolean }>();

const { lang } = useData();
const scroller = ref<HTMLDivElement>();
// SSR keeps the scroll region discoverable without JavaScript. Hydration removes
// the extra tab stop and hint from tables that fit, including after a resize.
const overflowing = ref(true);
const hintId = `limina-table-${useId()}`;
const chinese = computed(() => lang.value.startsWith('zh'));
let observer: ResizeObserver | undefined;

function updateOverflow(): void {
  const element = scroller.value;
  overflowing.value =
    !!element && element.scrollWidth > element.clientWidth + 1;
}

onMounted(() => {
  updateOverflow();
  observer = new ResizeObserver(updateOverflow);
  if (scroller.value) observer.observe(scroller.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="limina-table" :class="{ 'is-wide': wide }">
    <p v-if="overflowing" :id="hintId" class="limina-table-hint">
      <span aria-hidden="true">↔</span>
      {{
        chinese
          ? '横向滚动查看完整表格；聚焦后可用方向键。'
          : 'Scroll horizontally to see all columns; use arrow keys when focused.'
      }}
    </p>
    <div
      ref="scroller"
      class="limina-table-scroll"
      :tabindex="overflowing ? 0 : undefined"
      :role="overflowing ? 'region' : undefined"
      :aria-label="
        overflowing
          ? chinese
            ? '可横向滚动的表格'
            : 'Scrollable table'
          : undefined
      "
      :aria-describedby="overflowing ? hintId : undefined"
    >
      <slot />
    </div>
  </div>
</template>
