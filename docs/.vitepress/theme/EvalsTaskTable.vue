<script setup lang="ts">
import { useData } from 'vitepress';
import { computed } from 'vue';
import type { PublishedAverage } from './evals-campaign-types';
import type { CombinedTask } from './evals-combined';
defineProps<{ tasks: readonly CombinedTask[]; label: string }>();
const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const text = computed(() =>
  zh.value
    ? {
        task: '任务',
        inputTokens: '平均输入 Token',
        duration: '平均耗时',
        cost: '平均 API 等价成本',
        passedExecutions: '成功 / 执行',
        controls: '负控',
        regression: '回归数',
        repeat: '重复',
      }
    : {
        task: 'Task',
        inputTokens: 'Avg input tokens',
        duration: 'Avg duration',
        cost: 'Avg API-equivalent cost',
        passedExecutions: 'Passed / executions',
        controls: 'Negative controls',
        regression: 'Regressions',
        repeat: 'Repeat',
      },
);
const percentage = (v: number | null | undefined) =>
  v == null ? 'N/A' : `${(100 * v).toFixed(1)}%`;
const duration = (m: PublishedAverage | undefined) =>
  m?.mean == null ? 'N/A' : `${(m.mean / 1000).toFixed(2)}s`;
const money = (m: PublishedAverage | undefined) =>
  m?.mean == null ? 'N/A' : `$${m.mean.toFixed(4)}`;
const tokens = (m: PublishedAverage | undefined) =>
  m?.mean == null
    ? 'N/A'
    : m.mean.toLocaleString('en-US', { maximumFractionDigits: 0 });
const coverage = (m: PublishedAverage | undefined) =>
  m ? `${m.measured}/${m.executions} · ${percentage(m.coverage)}` : 'N/A';
function attemptMark(status: string) {
  if (status === 'passed') return '✓';
  if (
    [
      'assertion_failed',
      'unsafe_mutation',
      'agent_error',
      'agent_timeout',
    ].includes(status)
  )
    return '×';
  return '?';
}
function stageName(stage: string) {
  if (stage === 'development') return zh.value ? '开发集' : 'Development';
  if (stage === 'sealed') return zh.value ? '验收集' : 'Sealed';
  return zh.value ? '确认集' : 'Confirmation';
}
</script>
<template>
  <div
    class="matrix-scroll task-scroll"
    tabindex="0"
    role="region"
    :aria-label="label"
  >
    <table class="task-table">
      <thead>
        <tr>
          <th scope="col">{{ text.task }}</th>
          <th scope="col">{{ text.inputTokens }}</th>
          <th scope="col">{{ text.duration }}</th>
          <th scope="col">{{ text.cost }}</th>
          <th scope="col" class="attempt-heading">
            Base<small>{{ text.passedExecutions }}</small>
          </th>
          <th scope="col" class="attempt-heading">
            Skill<small>{{ text.passedExecutions }}</small>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="task in tasks" :key="task.id" class="task-row">
          <th scope="row" class="task-name">
            <strong>{{ task.id }}</strong
            ><span
              v-if="task.comparison.valid && task.comparison.regressed > 0"
              class="regression-count"
              :title="text.regression"
              :aria-label="`${text.regression}: ${task.comparison.regressed}`"
              >↓{{ task.comparison.regressed }}</span
            >
            <small
              >{{ stageName(task.stage) }} ·
              {{
                task.role === 'negative-control' ? text.controls : task.domain
              }}</small
            >
          </th>
          <td class="task-metric">
            {{ tokens(task.measurements?.inputTokens) }}
            <small>{{ coverage(task.measurements?.inputTokens) }}</small>
          </td>
          <td class="task-metric">
            {{ duration(task.measurements?.agentMs) }}
            <small>{{ coverage(task.measurements?.agentMs) }}</small>
          </td>
          <td class="task-metric">
            {{ money(task.measurements?.apiEquivalentUsd) }}
            <small>{{ coverage(task.measurements?.apiEquivalentUsd) }}</small>
          </td>
          <td v-for="condition in ['base', 'skill']" :key="condition">
            <div v-if="task.conditions[condition]" class="attempt-summary">
              <span class="attempt-marks">
                <template
                  v-for="run in task.conditions[condition]!.repetitions"
                  :key="run.repetition"
                >
                  <span
                    v-for="attempt in run.attempts.length
                      ? run.attempts
                      : [
                          {
                            id: `${condition}-${run.repetition}`,
                            status: run.status,
                            ordinal: 1,
                          },
                        ]"
                    :key="attempt.id"
                    class="attempt-dot"
                    :class="{
                      passed: attemptMark(attempt.status) === '✓',
                      failed: attemptMark(attempt.status) === '×',
                    }"
                    role="img"
                    :aria-label="`${condition} · ${text.repeat} ${run.repetition} · ${attempt.ordinal} · ${attempt.status}`"
                    :title="`${condition} · ${text.repeat} ${run.repetition} · ${attempt.ordinal} · ${attempt.status}`"
                    >{{ attemptMark(attempt.status) }}</span
                  >
                </template>
              </span>
              <small
                >{{ task.conditions[condition]!.passed }}/{{
                  task.conditions[condition]!.executions ??
                  task.conditions[condition]!.planned
                }}</small
              >
            </div>
            <span v-else>N/A</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
<style scoped>
.task-scroll {
  overflow-x: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
table {
  width: 100%;
  min-width: 64rem;
  border-collapse: collapse;
  text-align: left;
  font-size: 14px;
}
th,
td {
  border-bottom: 1px solid var(--vp-c-divider);
}
thead th {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-weight: 500;
}
thead th:not(:first-child) {
  text-align: right;
}
tbody tr:last-child > * {
  border-bottom: 0;
}
small {
  display: block;
  color: var(--vp-c-text-2);
  overflow-wrap: anywhere;
  font-weight: 400;
}
.task-table {
  table-layout: fixed;
}
.task-table thead th {
  width: 16%;
  font-size: 11px;
  line-height: 1.5;
  white-space: normal;
}
.task-table thead th:first-child {
  width: 24%;
}
.task-table thead th.attempt-heading {
  width: 14%;
}
.task-table th,
.task-table td {
  padding: 12px;
}
.task-name {
  font-weight: 500;
}
.task-metric {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.task-metric > small {
  margin-top: 4px;
  font-size: 10px;
}
.task-name small {
  margin-top: 2px;
  font-size: 11px;
}
.regression-count {
  margin-left: 8px;
  font-size: 11px;
  color: var(--vp-c-danger-1);
}
.attempt-summary,
.attempt-marks {
  display: flex;
  align-items: center;
  gap: 4px;
}
.attempt-summary {
  justify-content: flex-end;
  gap: 8px;
}
.attempt-summary > small {
  font-size: 11px;
}
.attempt-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 3px;
  background: var(--vp-c-bg);
  font-size: 12px;
  line-height: 1;
  color: var(--vp-c-text-2);
}
.attempt-dot.passed {
  background: var(--vp-c-tip-soft);
  color: var(--vp-c-tip-1);
}
.attempt-dot.failed {
  background: var(--vp-c-danger-soft);
  color: var(--vp-c-danger-1);
}
</style>
