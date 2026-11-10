<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{
  condition: 'base' | 'skill';
  passed: number;
  executions: number;
}>();
const value = computed(() =>
  props.executions > 0 ? props.passed / props.executions : null,
);
</script>

<template>
  <span class="eval-rate" :class="condition">
    <span class="rate-value">{{
      value == null ? 'N/A' : `${(value * 100).toFixed(1)}%`
    }}</span>
    <span v-if="value != null" class="rate-track" aria-hidden="true">
      <span class="rate-fill" :style="{ width: `${value * 100}%` }" />
    </span>
    <small>{{ passed }}/{{ executions }}</small>
  </span>
</template>

<style scoped>
.eval-rate {
  display: inline-grid;
  width: 6rem;
  gap: 5px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.rate-value {
  font-weight: 500;
  line-height: 1.2;
}
.rate-track {
  display: block;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--vp-c-divider);
}
.rate-fill {
  display: block;
  height: 100%;
  background: var(--vp-c-text-3);
}
.skill .rate-fill {
  background: var(--vp-c-brand-1);
}
small {
  font-size: 11px;
  line-height: 1.2;
  color: var(--vp-c-text-2);
}
</style>
