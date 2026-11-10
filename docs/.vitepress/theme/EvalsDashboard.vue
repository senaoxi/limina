<script setup lang="ts">
import { useData } from 'vitepress';
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue';
import EvalsRate from './EvalsRate.vue';
import EvalsTaskTable from './EvalsTaskTable.vue';
import type { PublicBankCalibration } from './evals-calibration-types';
import type { PublicCampaign, PublishedAverage } from './evals-campaign-types';
import index from './evals-campaigns.json';
import { bindPublishedCohort } from './evals-cohorts';
import {
  combinedCampaignEntries,
  combinedModelRows,
  type CombinedModelRow,
} from './evals-combined';
import currentSolI03Summary from './evals-current-i03-gpt-6.1-sol-results.json';
import currentI03Summary from './evals-current-i03-results.json';
import currentSummary from './evals-current-results.json';
import currentSolI03Task from './evals-i03-gpt-6.1-sol-task-result.json';
import currentI03Task from './evals-i03-task-result.json';
import latestBank from './evals-latest-bank.json';
import type { PublicCurrentSummary } from './evals-summary-types';
import type { PublicTaskResult } from './evals-task-result-types';
import latestTask from './evals-task-result.json';
const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const bank = latestBank as PublicBankCalibration;
const selections = [
  {
    summary: currentSummary as PublicCurrentSummary,
    task: latestTask as PublicTaskResult,
  },
  {
    summary: currentI03Summary as PublicCurrentSummary,
    task: currentI03Task as PublicTaskResult,
  },
  {
    summary: currentSolI03Summary as PublicCurrentSummary,
    task: currentSolI03Task as PublicTaskResult,
  },
];
const entries = combinedCampaignEntries(
  index.campaigns,
  bank,
  selections.map((selection) => selection.summary),
);
const conditions = ['base', 'skill'] as const;
const snapshots = import.meta.glob('./evals-campaigns/*.json', {
  import: 'default',
}) as Record<string, () => Promise<PublicCampaign>>;
const modelRows = shallowRef<CombinedModelRow[]>([]);
const loadError = ref(false);
const loading = ref(entries.length > 0);
const expandedModels = ref<string[]>([]);
function toggleModel(key: string) {
  expandedModels.value = expandedModels.value.includes(key)
    ? expandedModels.value.filter((value) => value !== key)
    : [...expandedModels.value, key];
}
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});
onMounted(async () => {
  try {
    const loaded = await Promise.all(
      entries.map(async (entry) => {
        if (!snapshots[entry.file]) throw new Error('Campaign is unavailable');
        return bindPublishedCohort(entry, await snapshots[entry.file]!());
      }),
    );
    if (!disposed)
      modelRows.value = combinedModelRows(loaded, bank, selections);
  } catch {
    if (!disposed) loadError.value = true;
  } finally {
    if (!disposed) loading.value = false;
  }
});
const text = computed(() =>
  zh.value
    ? {
        title: 'Limina 评测',
        pending: '当前题库尚无完整执行的评测结果。',
        loading: '正在读取评测结果…',
        loadError: '结果来源不一致或无法读取，暂不展示成绩。',
        model: '模型',
        agent: 'Agent',
        duration: '平均耗时',
        cost: '平均 API 等价成本',
        measured: '测量覆盖',
        passedExecutions: '成功 / 全部执行',
        lift: '差值（百分点）',
        tasks: '任务与独立尝试',
        controls: '负控',
        determinate: '可判',
        unresolved: '未决',
      }
    : {
        title: 'Limina Evals',
        pending:
          'No fully executed evaluation results are available for this bank.',
        loading: 'Loading evaluation results…',
        loadError:
          'The result is unavailable or its source identity differs. Scores are withheld.',
        model: 'Model',
        agent: 'Agent',
        duration: 'Avg duration',
        cost: 'Avg API-equivalent cost',
        measured: 'Measurement coverage',
        passedExecutions: 'Passed / all executions',
        lift: 'Difference (pp)',
        tasks: 'Tasks and independent attempts',
        controls: 'Negative controls',
        determinate: 'Determinate',
        unresolved: 'Unresolved',
      },
);
const percentage = (v: number | null | undefined) =>
  v == null ? 'N/A' : `${(100 * v).toFixed(1)}%`;
const points = (v: number | null | undefined) =>
  v == null ? 'N/A' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
const duration = (m: PublishedAverage | undefined) =>
  m?.mean == null ? 'N/A' : `${(m.mean / 1000).toFixed(2)}s`;
const money = (m: PublishedAverage | undefined) =>
  m?.mean == null ? 'N/A' : `$${m.mean.toFixed(4)}`;
const coverage = (m: PublishedAverage | undefined) =>
  m ? `${m.measured}/${m.executions} · ${percentage(m.coverage)}` : 'N/A';
</script>
<template>
  <div class="evals-page">
    <div class="evals-cohorts">
      <h1 id="evals-model-title">
        {{ text.title
        }}<span class="bank-version">{{ bank.bankRevision }}</span>
      </h1>
      <p v-if="loadError" role="alert">{{ text.loadError }}</p>
      <p v-else-if="loading" role="status">{{ text.loading }}</p>
    </div>
    <section
      v-if="!loadError && !loading"
      class="evals-matrix"
      aria-labelledby="evals-model-title"
    >
      <div
        class="matrix-scroll"
        tabindex="0"
        role="region"
        :aria-label="
          zh ? '模型结果表，可横向滚动' : 'Model results, horizontal scroll'
        "
      >
        <table>
          <thead>
            <tr>
              <th>{{ text.model }}</th>
              <th>{{ text.agent }}</th>
              <th>{{ text.duration }}</th>
              <th>{{ text.cost }}</th>
              <th>
                Base<small>{{ text.passedExecutions }}</small>
              </th>
              <th>
                Skill<small>{{ text.passedExecutions }}</small>
              </th>
              <th>{{ text.lift }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="modelRows.length === 0" class="empty-model-results">
              <td colspan="7" role="status">{{ text.pending }}</td>
            </tr>
            <template v-for="m in modelRows" :key="m.key">
              <tr class="model-row">
                <th scope="row">
                  <button
                    type="button"
                    class="model-toggle"
                    :aria-expanded="expandedModels.includes(m.key)"
                    :aria-controls="`model-${m.key}`"
                    @click="toggleModel(m.key)"
                  >
                    <svg
                      class="row-chevron"
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="m6 4 4 4-4 4" />
                    </svg>
                    <span class="model-name">{{ m.profile.displayName }}</span>
                  </button>
                </th>
                <td class="agent-cell">
                  Codex<small>{{ m.profile.codexVersion ?? 'N/A' }}</small>
                </td>
                <td>
                  {{ duration(m.main.measurements.agentMs)
                  }}<small :title="text.measured">{{
                    coverage(m.main.measurements.agentMs)
                  }}</small>
                </td>
                <td>
                  {{ money(m.main.measurements.apiEquivalentUsd)
                  }}<small :title="text.measured">{{
                    coverage(m.main.measurements.apiEquivalentUsd)
                  }}</small>
                </td>
                <td v-for="condition in conditions" :key="condition">
                  <EvalsRate
                    :condition="condition"
                    :passed="m.main.attempts[condition]!.passed"
                    :executions="m.main.attempts[condition]!.executions"
                  />
                  <small class="determinate-coverage"
                    ><span v-if="m.main.attempts[condition]!.unknown > 0"
                      >{{ text.unresolved }}
                      {{ m.main.attempts[condition]!.unknown }} · </span
                    >{{ text.determinate }}
                    {{ m.main.attempts[condition]!.valid }}/{{
                      m.main.attempts[condition]!.executions
                    }}
                    ·
                    {{
                      percentage(m.main.attempts[condition]!.coverage)
                    }}</small
                  >
                </td>
                <td>
                  <span
                    class="lift-value"
                    :class="{
                      positive: (m.main.differencePercentagePoints ?? 0) > 0,
                      negative: (m.main.differencePercentagePoints ?? 0) < 0,
                    }"
                    >{{ points(m.main.differencePercentagePoints) }}</span
                  >
                </td>
              </tr>
              <tr v-if="expandedModels.includes(m.key)" class="model-expanded">
                <td colspan="7">
                  <div :id="`model-${m.key}`" class="model-details">
                    <h2>
                      {{ text.tasks
                      }}<span class="task-count">{{
                        m.main.tasks.length
                      }}</span>
                    </h2>
                    <EvalsTaskTable :tasks="m.main.tasks" :label="text.tasks" />
                    <div class="control-heading">
                      <h2>
                        {{ text.controls
                        }}<span class="task-count">{{
                          m.negativeControls.tasks.length
                        }}</span>
                      </h2>
                      <div class="control-counts">
                        <span v-for="condition in conditions" :key="condition"
                          >{{ condition === 'base' ? 'Base' : 'Skill' }}
                          <strong
                            >{{
                              m.negativeControls.attempts[condition]!.passed
                            }}/{{
                              m.negativeControls.attempts[condition]!.executions
                            }}</strong
                          >
                          ·
                          {{
                            percentage(
                              m.negativeControls.attempts[condition]!.rate,
                            )
                          }}<small
                            ><span
                              v-if="
                                m.negativeControls.attempts[condition]!
                                  .unknown > 0
                              "
                              >{{ text.unresolved }}
                              {{
                                m.negativeControls.attempts[condition]!.unknown
                              }}
                              · </span
                            >{{ text.determinate }}
                            {{
                              m.negativeControls.attempts[condition]!.valid
                            }}/{{
                              m.negativeControls.attempts[condition]!.executions
                            }}
                            ·
                            {{
                              percentage(
                                m.negativeControls.attempts[condition]!
                                  .coverage,
                              )
                            }}</small
                          ></span
                        >
                      </div>
                    </div>
                    <EvalsTaskTable
                      :tasks="m.negativeControls.tasks"
                      :label="text.controls"
                    />
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
<style scoped>
.evals-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 40px 40px 64px;
  color: var(--vp-c-text-1);
}
.evals-cohorts,
.evals-matrix {
  margin: 0;
  padding: 0;
}
.evals-cohorts {
  position: relative;
}
.evals-cohorts h1 {
  margin: 0 0 24px;
  font-size: 28px;
  font-weight: 550;
  line-height: 1.3;
  letter-spacing: -0.025em;
}
.bank-version {
  display: inline-block;
  margin-left: 12px;
  padding: 2px 7px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  color: var(--vp-c-text-2);
  font-size: 11px;
  font-weight: 400;
  vertical-align: middle;
  letter-spacing: 0;
}
small {
  color: var(--vp-c-text-2);
  overflow-wrap: anywhere;
  display: block;
  font-weight: 400;
}
.matrix-scroll {
  overflow-x: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
table {
  border-collapse: collapse;
  width: 100%;
  min-width: 36rem;
  text-align: left;
  font-size: 14px;
}
.evals-matrix > .matrix-scroll table,
.empty-model-results table {
  min-width: 58rem;
}
.agent-cell {
  white-space: nowrap;
}
.model-toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
  text-align: left;
  font-weight: 500;
  line-height: 20px;
  vertical-align: middle;
  cursor: pointer;
  border-radius: 4px;
}
.model-toggle:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 4px;
}
.row-chevron {
  display: block;
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--vp-c-text-2);
  transform-origin: center;
  transition: transform 160ms ease;
}
.model-toggle[aria-expanded='true'] .row-chevron {
  transform: rotate(90deg);
}
.model-name {
  display: block;
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .row-chevron {
    transition: none;
  }
}
.model-row:hover {
  background: var(--vp-c-bg-soft);
}
.lift-value {
  font-weight: 500;
}
.lift-value.positive {
  color: var(--vp-c-tip-1);
}
.lift-value.negative {
  color: var(--vp-c-danger-1);
}
.model-row small {
  font-size: 12px;
  white-space: nowrap;
}
.evals-matrix > .matrix-scroll > table > tbody > .model-expanded > td {
  text-align: left;
  padding: 20px 24px;
  background: var(--vp-c-bg-soft);
}
.evals-matrix > .matrix-scroll > table > tbody > .model-row > .agent-cell {
  text-align: left;
}
.model-details h2 {
  margin: 20px 0 12px;
  font-size: 16px;
  font-weight: 600;
}
.model-details > h2:first-child {
  margin-top: 0;
}
@media (max-width: 639px) {
  .evals-page {
    padding: 28px 20px 40px;
  }
  .evals-cohorts h1 {
    font-size: 24px;
  }
}
th,
td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--vp-c-divider);
}
tbody th {
  min-width: 12rem;
}
thead th {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-weight: 500;
  white-space: nowrap;
}
thead th:not(:first-child) {
  text-align: right;
}
.evals-matrix > .matrix-scroll > table > tbody > tr > td {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
tbody tr:last-child > * {
  border-bottom: 0;
}
.empty-model-results td {
  text-align: center;
  padding: 36px 24px;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}
.model-details {
  padding: 0;
}
.task-count {
  margin-left: 8px;
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 400;
}
.determinate-coverage {
  margin-top: 6px;
}
.model-row .determinate-coverage {
  font-size: 11px;
}
.control-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin: 28px 0 12px;
}
.control-heading h2 {
  margin: 0;
}
.control-counts {
  display: flex;
  gap: 20px;
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.control-counts strong {
  color: var(--vp-c-text-1);
  font-weight: 500;
}
</style>
