<script setup lang="ts">
import { useData } from 'vitepress';
import { computed } from 'vue';
import type { PublishedAverage } from './evals-campaign-types';
import type { PublicTaskResult } from './evals-task-result-types';
import result from './evals-task-result.json';
import downloadUrl from './evals-task-result.json?url';

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const data = result as PublicTaskResult;
const duration = (value: PublishedAverage) =>
  value.mean === null ? 'N/A' : `${(value.mean / 1000).toFixed(2)}s`;
const money = (value: PublishedAverage) =>
  value.mean === null ? 'N/A' : `$${value.mean.toFixed(4)}`;
</script>

<template>
  <section class="task-results" aria-labelledby="evals-task-title">
    <h2 id="evals-task-title">{{ zh ? '任务结果' : 'Task results' }}</h2>
    <p class="task-scope">
      {{ data.taskId }} · Skill ·
      {{ zh ? '1 项任务 · 3 次独立执行' : '1 task · 3 independent executions' }}
      · {{ data.bankRevision }} · Bank {{ data.bankId.slice(0, 12) }}
    </p>
    <div class="task-scroll">
      <table>
        <thead>
          <tr>
            <th>{{ zh ? '模型' : 'Model' }}</th>
            <th>Agent</th>
            <th>{{ zh ? '平均耗时' : 'Avg duration' }}</th>
            <th>{{ zh ? '平均 API 等价成本' : 'Avg API-equivalent cost' }}</th>
            <th>{{ zh ? '成功 / 执行' : 'Passed / executions' }}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">{{ data.profile.displayName }}</th>
            <td>
              Codex<small>{{ data.profile.codexVersion ?? 'N/A' }}</small>
            </td>
            <td>
              {{ duration(data.measurements.agentMs)
              }}<small
                >{{ data.measurements.agentMs.measured }}/{{
                  data.measurements.agentMs.executions
                }}</small
              >
            </td>
            <td>
              {{ money(data.measurements.apiEquivalentUsd)
              }}<small
                >{{ data.measurements.apiEquivalentUsd.measured }}/{{
                  data.measurements.apiEquivalentUsd.executions
                }}</small
              >
            </td>
            <td>
              {{ data.counts.passed }}/{{ data.counts.executions
              }}<small
                >{{
                  ((data.counts.passed / data.counts.executions) * 100).toFixed(
                    1,
                  )
                }}%</small
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <details>
      <summary>
        {{ zh ? '逐次结果与数据来源' : 'Individual results and sources' }}
      </summary>
      <ol>
        <li v-for="attempt in data.repetitions" :key="attempt.repetition">
          {{ zh ? '执行' : 'Attempt' }} {{ attempt.repetition }} ·
          {{
            attempt.status === 'passed'
              ? zh
                ? '通过'
                : 'Passed'
              : zh
                ? '未通过'
                : 'Failed'
          }}
        </li>
      </ol>
      <p>
        {{ zh ? '端到端平均耗时' : 'Avg end-to-end duration' }}
        {{ duration(data.measurements.endToEndMs) }} ·
        {{ zh ? '实际费用' : 'Actual charges' }}
        {{ money(data.measurements.settledUsd) }}
      </p>
      <p>
        Bank {{ data.bankId }}<br />Campaign {{ data.campaignId
        }}<br />Experiment {{ data.experimentIdentity }}<br />Report
        {{ data.reportIdentity }}
      </p>
      <a :href="downloadUrl" download>{{
        zh ? '下载本组数据' : 'Download result data'
      }}</a>
    </details>
  </section>
</template>

<style scoped>
.task-results {
  margin: 0 0 40px;
}
h2 {
  margin: 0 0 12px;
  font-size: 28px;
  font-weight: 550;
  line-height: 1.3;
  letter-spacing: -0.025em;
}
.task-scope,
small,
details {
  color: var(--vp-c-text-2);
}
.task-scope {
  font-size: 14px;
  margin: 0 0 16px;
}
.task-scroll {
  overflow-x: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
table {
  width: 100%;
  min-width: 48rem;
  border-collapse: collapse;
  text-align: left;
  font-size: 14px;
}
th,
td {
  padding: 16px;
  border-bottom: 1px solid var(--vp-c-divider);
  vertical-align: top;
}
thead th {
  font-weight: 500;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
}
tbody th {
  font-weight: 500;
}
tbody tr:last-child > * {
  border-bottom: 0;
}
small {
  display: block;
  font-size: 12px;
  font-weight: 400;
  margin-top: 4px;
}
details {
  margin-top: 14px;
  font-size: 13px;
  line-height: 1.7;
}
details p {
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
}
a {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}
</style>
