<script setup lang="ts">
import { useData } from 'vitepress';
import { computed } from 'vue';
import results from './evals-development-retest.json';
import snapshotUrl from './evals-development-retest.json?url';
const { lang } = useData();
const chinese = computed(() => lang.value.startsWith('zh'));
const batch = results.batch;
const conditionIds = ['base', 'skill'] as const;
const estimates = (
  results as {
    estimatedCost?: {
      conditions: Record<
        (typeof conditionIds)[number],
        { observedUsd: number; totalUsd: number | null; pricedRequests: number }
      >;
    };
  }
).estimatedCost;
const domainLabels: Record<string, [string, string]> = {
  initialization: ['Initialization', '初始化'],
  configuration: ['Configuration', '配置'],
  'reference-graph': ['Reference graph', '引用图'],
  checker: ['Checker', '类型检查器'],
  'source-governance': ['Source governance', '源码治理'],
  workflow: ['CLI & workflow', '命令行与工作流'],
  troubleshooting: ['Troubleshooting', '故障排查'],
  'package-release': ['Package & release', '打包与发布'],
};
const copy = computed(() =>
  chinese.value
    ? {
        eyebrow: '工程任务 · 独立评测',
        intro:
          '同一模型、同一输入，比较安装与未安装 Limina Skill 的工程任务表现。',
        snapshot: '最近评测',
        exploratory: '探索性结果',
        download: '下载数据',
        tasks: 'Limina 任务',
        controls: '负控任务',
        attempts: '比较槽位',
        repetitions: '每条件重复',
        results: '当前批次结果',
        resultIntro: '同一模型与项目输入，每项任务每组独立运行三次。',
        development: '开发集',
        taskUnit: '项任务',
        attemptUnit: '次执行',
        configurations: '对照条件',
        condition: '条件',
        baseDescription: '不安装 Limina Skill',
        skillDescription: '安装完整 Limina Skill，自然触发',
        agentTime: '平均 Agent 耗时',
        input: '已观察输入 Token',
        estimatedCost: 'Estimated Cost',
        costNote: 'API 等价值估算，非实际扣费。',
        unknown: '未知',
        rate: '八领域成功率',
        passed: 'Limina 尝试通过',
        scroll: '可横向滑动查看完整表格',
        scope:
          '成功率按八领域等权，负控单列；耗时、Token 与估算成本包含全部执行。',
        usageNote: '* Token 或估算成本为已观察之和，统计不完整。',
        domains: '按领域查看',
        domainIntro: '展开查看逐项结果。',
        domain: '领域',
        task: '任务',
        count: '通过 / 尝试',
        taskTime: '平均 Agent 耗时 · Base / Skill',
        negative: '负控任务',
        negativeIntro: '不计入八领域成功率。',
        outcome: '两组均通过，本轮未观察到成功率增益。',
        accounting: `实际执行 ${results.recordedAttempts} 次，其中技术补跑 ${results.executionResolution.replacementAttempts} 次。`,
        method:
          '干净工作区独立执行，按真实项目状态和语义断言评分。每项仅三次重复，结论限于本批任务。',
      }
    : {
        eyebrow: 'ENGINEERING TASKS · INDEPENDENT EVALS',
        intro:
          'The same model. The same inputs. A measured comparison with and without the Limina Skill.',
        snapshot: 'Last measured',
        exploratory: 'Exploratory',
        download: 'Download data',
        tasks: 'Limina tasks',
        controls: 'Negative controls',
        attempts: 'Comparison slots',
        repetitions: 'Runs per condition',
        results: 'Current batch results',
        resultIntro:
          'Same model and project inputs. Three independent attempts per task and condition.',
        development: 'Development',
        taskUnit: 'tasks',
        attemptUnit: 'executions',
        configurations: 'Comparison conditions',
        condition: 'Condition',
        baseDescription: 'Without the Limina Skill',
        skillDescription: 'Full Limina Skill, naturally triggered',
        agentTime: 'Avg agent time',
        input: 'Observed input tokens',
        estimatedCost: 'Estimated Cost',
        costNote: 'API-equivalent estimate, not actual charges.',
        unknown: 'Unknown',
        rate: '8-domain pass rate',
        passed: 'Limina attempts passed',
        scroll: 'Scroll horizontally to see the full table',
        scope:
          'Eight domains are equally weighted; controls are separate. Time, tokens and estimates include every execution.',
        usageNote: '* Observed token or cost sums have incomplete coverage.',
        domains: 'Explore by domain',
        domainIntro: 'Expand for individual task results.',
        domain: 'Domain',
        task: 'Task',
        count: 'Passed / attempts',
        taskTime: 'Avg agent time · Base / Skill',
        negative: 'Negative controls',
        negativeIntro: 'Excluded from the eight-domain pass rate.',
        outcome:
          'Both conditions passed. No pass-rate gain was observed in this batch.',
        accounting: `Recorded executions: ${results.recordedAttempts}; infrastructure replacements: ${results.executionResolution.replacementAttempts}.`,
        method:
          'Independent runs start from clean workspaces and are graded on real project state and semantic assertions. Three repetitions per task limit conclusions to this batch.',
      },
);

function percent(value: number, digits = 2) {
  return `${Number((value * 100).toFixed(digits))}%`;
}
function tokens(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(2))}K`;
  return String(value);
}

function estimatedCost(id: (typeof conditionIds)[number]) {
  const value = estimates?.conditions[id];
  return value && value.pricedRequests > 0
    ? `$${value.observedUsd.toFixed(2)}`
    : copy.value.unknown;
}
function duration(value: number | null) {
  return value === null
    ? copy.value.unknown
    : `${Number((value / 1000).toFixed(1))}s`;
}
function domainName(id: string) {
  return domainLabels[id]?.[chinese.value ? 1 : 0] ?? id;
}
</script>
<template>
  <div class="evals-dashboard">
    <header class="evals-hero">
      <p class="evals-eyebrow">
        <span class="evals-status-dot" />{{ copy.eyebrow }}
      </p>
      <h1>Limina Skill <span>Evals</span></h1>
      <p class="evals-intro">{{ copy.intro }}</p>
      <div class="evals-meta">
        <span
          >{{ copy.snapshot }}
          <time :datetime="results.measuredOn">{{
            results.measuredOn
          }}</time></span
        >
        <span class="evals-meta-divider" aria-hidden="true" />
        <span
          >{{ results.model }}
          <span class="evals-muted"
            >/ {{ results.reasoningEffort }} / {{ results.speed }}</span
          ></span
        >
        <span class="evals-tag">{{ copy.exploratory }}</span>
      </div>
      <div class="evals-actions">
        <a :href="snapshotUrl" download="limina-development-retest.json"
          >{{ copy.download }} <span aria-hidden="true">↗</span></a
        >
      </div>
    </header>

    <dl class="evals-census">
      <div>
        <dt>{{ copy.tasks }}</dt>
        <dd>{{ batch.taskCount - batch.negativeControls.length }}</dd>
      </div>
      <div>
        <dt>{{ copy.controls }}</dt>
        <dd>{{ batch.negativeControls.length.toString().padStart(2, '0') }}</dd>
      </div>
      <div>
        <dt>{{ copy.attempts }}</dt>
        <dd>{{ results.comparisonAttempts }}</dd>
      </div>
      <div>
        <dt>{{ copy.repetitions }}</dt>
        <dd>{{ results.repetitions.toString().padStart(2, '0') }}</dd>
      </div>
    </dl>

    <section class="evals-section" aria-labelledby="current-results">
      <div class="evals-section-head">
        <div>
          <p class="evals-eyebrow">01 / RESULTS</p>
          <h2 id="current-results">
            {{ copy.results }}
          </h2>
          <p class="evals-muted">
            {{ copy.resultIntro }}
          </p>
        </div>
      </div>

      <div id="eval-results-panel">
        <p class="evals-mobile-hint">
          {{ copy.scroll }} <span aria-hidden="true">→</span>
        </p>
        <div
          class="evals-table-scroll"
          tabindex="0"
          :aria-label="copy.configurations"
        >
          <table class="evals-comparison-table">
            <caption class="evals-sr-only">
              {{
                copy.development
              }}
              ·
              {{
                copy.configurations
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">{{ copy.condition }}</th>
                <th scope="col">{{ copy.agentTime }}</th>
                <th scope="col">{{ copy.input }}</th>
                <th scope="col">{{ copy.estimatedCost }}</th>
                <th scope="col">{{ copy.rate }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="id in conditionIds"
                :key="id"
                :class="{ 'evals-skill-row': id === 'skill' }"
              >
                <th scope="row">
                  <span class="evals-condition"
                    ><span
                      class="evals-condition-dot"
                      :class="{ skill: id === 'skill' }"
                    />{{ id === 'base' ? 'Base' : '+ Limina Skill' }}</span
                  ><span class="evals-cell-detail">{{
                    id === 'base' ? copy.baseDescription : copy.skillDescription
                  }}</span
                  ><span class="evals-cell-detail evals-mono"
                    >{{ batch.conditions[id].attempts }}
                    {{ copy.attemptUnit }}</span
                  >
                </th>
                <td>
                  <span class="evals-number">{{
                    duration(batch.conditions[id].meanAgentMs)
                  }}</span>
                </td>
                <td>
                  <span class="evals-number"
                    >{{ tokens(batch.conditions[id].input.observed)
                    }}<a
                      v-if="batch.conditions[id].input.total === null"
                      href="#measurement-notes"
                      :aria-label="copy.usageNote"
                      >*</a
                    ></span
                  >
                </td>

                <td>
                  <span class="evals-number"
                    >{{ estimatedCost(id)
                    }}<a
                      v-if="
                        estimates && estimates.conditions[id].totalUsd === null
                      "
                      href="#measurement-notes"
                      :aria-label="copy.usageNote"
                      >*</a
                    ></span
                  >
                </td>
                <td>
                  <span class="evals-score">{{
                    percent(batch.conditions[id].macroPassRate)
                  }}</span
                  ><span class="evals-score-track" aria-hidden="true"
                    ><span
                      :style="{
                        width: `${batch.conditions[id].macroPassRate * 100}%`,
                      }" /></span
                  ><span class="evals-cell-detail"
                    >{{ batch.conditions[id].mainPassed }}/{{
                      batch.conditions[id].mainAttempts
                    }}
                    {{ copy.passed }}</span
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="evals-table-notes">
          <p
            v-if="
              batch.conditions.base.macroPassRate === 1 &&
              batch.conditions.skill.macroPassRate === 1
            "
            class="evals-conclusion"
          >
            {{ copy.outcome }}
          </p>
          <p>{{ copy.scope }} {{ copy.accounting }}</p>
          <p id="measurement-notes">{{ copy.costNote }} {{ copy.usageNote }}</p>
        </div>
      </div>
    </section>

    <section class="evals-section" aria-labelledby="domain-results">
      <div class="evals-section-head">
        <div>
          <p class="evals-eyebrow">02 / BREAKDOWN</p>
          <h2 id="domain-results">{{ copy.domains }}</h2>
          <p class="evals-muted">{{ copy.domainIntro }}</p>
        </div>
        <div class="evals-legend">
          <span><i />Base</span><span><i class="skill" />Skill</span>
        </div>
      </div>
      <div class="evals-domain-head">
        <span>{{ copy.domain }}</span
        ><span>Base</span><span>Skill</span>
      </div>
      <div class="evals-domains">
        <details
          v-for="domain in batch.domains"
          :key="domain.id"
          class="evals-domain"
        >
          <summary>
            <span class="evals-domain-title"
              ><svg
                class="evals-chevron"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path d="m6 3 5 5-5 5" /></svg
              >{{ domainName(domain.id)
              }}<span class="evals-task-count"
                >{{ domain.tasks.length }} {{ copy.taskUnit }}</span
              ></span
            ><span class="evals-mini-rate"
              ><span class="evals-mini-track" aria-hidden="true"
                ><i :style="{ width: `${domain.baseRate * 100}%` }" /></span
              ><span>{{ percent(domain.baseRate, 1) }}</span></span
            ><span class="evals-mini-rate skill"
              ><span class="evals-mini-track" aria-hidden="true"
                ><i :style="{ width: `${domain.skillRate * 100}%` }" /></span
              ><span>{{ percent(domain.skillRate, 1) }}</span></span
            >
          </summary>
          <div class="evals-domain-content">
            <div
              class="evals-table-scroll"
              tabindex="0"
              :aria-label="domainName(domain.id)"
            >
              <table class="evals-task-table">
                <caption class="evals-sr-only">
                  {{
                    domainName(domain.id)
                  }}
                  ·
                  {{
                    copy.count
                  }}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{{ copy.task }}</th>
                    <th scope="col">Base</th>
                    <th scope="col">Skill</th>
                    <th scope="col">{{ copy.taskTime }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="task in domain.tasks" :key="task.id">
                    <th scope="row" class="evals-mono">{{ task.id }}</th>
                    <td>{{ task.base.passed }}/{{ task.base.attempts }}</td>
                    <td
                      :class="{
                        'evals-negative':
                          task.skill.passed < task.skill.attempts,
                      }"
                    >
                      {{ task.skill.passed }}/{{ task.skill.attempts }}
                    </td>
                    <td class="evals-mono">
                      {{ duration(task.base.meanAgentMs) }}
                      <span class="evals-muted">/</span>
                      {{ duration(task.skill.meanAgentMs) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </details>
      </div>
      <div class="evals-negative-controls">
        <div>
          <h3>{{ copy.negative }}</h3>
          <p>{{ copy.negativeIntro }}</p>
        </div>
        <div
          v-for="task in batch.negativeControls"
          :key="task.id"
          class="evals-control-result"
        >
          <span class="evals-mono">{{ task.id }}</span
          ><span
            >Base <b>{{ task.base.passed }}/{{ task.base.attempts }}</b></span
          ><span
            >Skill
            <b>{{ task.skill.passed }}/{{ task.skill.attempts }}</b></span
          >
        </div>
      </div>
    </section>

    <p class="evals-method-note">{{ copy.method }}</p>
  </div>
</template>
<style scoped>
.evals-dashboard {
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 32px 80px;
  color: var(--limina-c-ink);
}
.evals-hero {
  padding: 80px 0 48px;
  text-align: center;
}
.evals-eyebrow {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--vp-c-brand-1);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  line-height: 1.8;
}
.evals-hero .evals-eyebrow {
  justify-content: center;
}
.evals-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
}
h1 {
  margin: 16px 0;
  font-size: clamp(36px, 4.8vw, 60px);
  font-weight: 500;
  line-height: 1.15;
  letter-spacing: -0.055em;
}
h1 span {
  color: var(--vp-c-brand-1);
}
.evals-intro {
  max-width: 650px;
  margin: 0 auto;
  color: var(--limina-c-terminal-text);
  font-size: 17px;
  line-height: 1.8;
  text-wrap: balance;
}
.evals-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 25px;
  font-size: 12px;
}
.evals-meta time {
  margin-left: 7px;
  font-variant-numeric: tabular-nums;
}
.evals-meta-divider {
  height: 12px;
  width: 1px;
  background: var(--limina-c-line);
}
.evals-tag {
  padding: 2px 8px;
  border: 1px solid var(--limina-c-line);
  border-radius: 4px;
  color: var(--limina-c-terminal-text);
  font-size: 10px;
  line-height: 1.8;
}
.evals-muted {
  color: var(--limina-c-terminal-text);
}
.evals-actions {
  display: flex;
  justify-content: center;
  gap: 24px;
  margin-top: 20px;
  font-size: 12px;
}
.evals-actions a {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.evals-actions a:hover {
  color: var(--vp-c-brand-1);
}
.evals-census {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin: 0;
  padding: 27px 0;
  border-top: 1px solid var(--limina-c-line);
  border-bottom: 1px solid var(--limina-c-line);
}
.evals-census > div {
  display: flex;
  flex-direction: column;
  padding: 0 30px;
  border-right: 1px solid var(--limina-c-line);
}
.evals-census > div:last-child {
  border-right: 0;
}
.evals-census dd {
  margin: 0 0 5px;
  font-family: var(--vp-font-family-mono);
  font-size: 28px;
  line-height: 1.25;
  letter-spacing: -0.04em;
}
.evals-census dt {
  order: 1;
  color: var(--limina-c-terminal-text);
  font-size: 12px;
}
.evals-section {
  margin-top: 60px;
  scroll-margin-top: 96px;
}
.evals-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 24px;
}
h2 {
  margin: 5px 0 9px;
  font-size: 26px;
  font-weight: 500;
  line-height: 1.4;
  letter-spacing: -0.035em;
}
.evals-section-head p:not(.evals-eyebrow) {
  font-size: 13px;
  line-height: 1.7;
}
.evals-table-scroll {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}
.evals-table-scroll:focus:not(:focus-visible) {
  outline: none;
}
.evals-comparison-table {
  width: 100%;
  min-width: 800px;
  border-collapse: separate;
  border-spacing: 0;
  border: 1px solid var(--limina-c-line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--limina-doc-surface);
  text-align: left;
}
table th {
  font-weight: 400;
}
.evals-comparison-table thead {
  background: var(--limina-c-terminal);
  color: var(--limina-c-terminal-text);
  font-size: 11px;
}
.evals-comparison-table thead th {
  padding: 14px 18px;
  border-bottom: 1px solid var(--limina-c-line);
  white-space: nowrap;
}
.evals-comparison-table tbody th,
.evals-comparison-table tbody td {
  padding: 21px 18px;
  vertical-align: middle;
}
.evals-comparison-table tbody th {
  width: 31%;
}
.evals-comparison-table tbody tr + tr > * {
  border-top: 1px solid var(--limina-c-line);
}
.evals-skill-row {
  background: var(--vp-c-brand-soft);
}
.evals-condition {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 14px;
  font-weight: 500;
}
.evals-condition-dot,
.evals-legend i {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--limina-c-terminal-text);
}
.evals-condition-dot.skill,
.evals-legend i.skill {
  background: var(--vp-c-brand-1);
}
.evals-cell-detail {
  display: block;
  margin-top: 5px;
  color: var(--limina-c-terminal-text);
  font-size: 10px;
  font-weight: 400;
  line-height: 1.6;
  white-space: nowrap;
}
.evals-cell-detail.evals-mono {
  margin-top: 8px;
  font-size: 9px;
}
.evals-number,
.evals-score,
.evals-mono {
  font-family: var(--vp-font-family-mono);
  font-variant-numeric: tabular-nums;
}
.evals-number {
  font-size: 14px;
  letter-spacing: -0.04em;
}
.evals-number a {
  margin-left: 3px;
  color: var(--vp-c-brand-1);
  font-size: 11px;
}
.evals-score {
  font-size: 19px;
  line-height: 1.4;
  letter-spacing: -0.04em;
}
.evals-skill-row .evals-score {
  color: var(--vp-c-brand-1);
}
.evals-score-track {
  display: block;
  height: 3px;
  width: 108px;
  margin: 7px 0;
  border-radius: 2px;
  background: var(--limina-c-line);
  overflow: hidden;
}
.evals-score-track > span {
  display: block;
  height: 100%;
  background: var(--limina-c-terminal-text);
}
.evals-skill-row .evals-score-track > span {
  background: var(--vp-c-brand-1);
}
.evals-table-notes {
  max-width: 960px;
  margin-top: 14px;
  color: var(--limina-c-terminal-text);
  font-size: 11px;
  line-height: 1.8;
}
.evals-table-notes p + p {
  margin-top: 4px;
}
#measurement-notes {
  scroll-margin-top: 100px;
}
.evals-negative {
  color: var(--limina-c-warning);
}
.evals-legend {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--limina-c-terminal-text);
  font-size: 11px;
}
.evals-legend span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.evals-domain-head,
.evals-domain > summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px 180px;
  align-items: center;
  column-gap: 24px;
}
.evals-domain-head {
  padding: 0 20px 12px;
  color: var(--limina-c-terminal-text);
  font-size: 11px;
}
.evals-domain-head > span:not(:first-child) {
  text-align: right;
}
.evals-domains {
  border: 1px solid var(--limina-c-line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--limina-doc-surface);
}
.evals-domain + .evals-domain {
  border-top: 1px solid var(--limina-c-line);
}
.evals-domain > summary {
  min-height: 63px;
  padding: 14px 20px;
  list-style: none;
  cursor: pointer;
}
.evals-domain > summary::-webkit-details-marker {
  display: none;
}
.evals-domain > summary:hover {
  background: var(--vp-c-brand-soft);
}
.evals-domain-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
}
.evals-chevron {
  flex: 0 0 12px;
  width: 12px;
  height: 12px;
  fill: none;
  stroke: var(--limina-c-terminal-text);
  stroke-width: 1.5;
}
.evals-domain[open] > summary .evals-chevron {
  transform: rotate(90deg);
}
.evals-task-count {
  margin-left: auto;
  color: var(--limina-c-terminal-text);
  font-size: 10px;
  font-weight: 400;
  white-space: nowrap;
}
.evals-mini-rate {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
}
.evals-mini-rate > span:last-child {
  width: 50px;
  text-align: right;
}
.evals-mini-track {
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--limina-c-line);
}
.evals-mini-track i {
  display: block;
  height: 100%;
  background: var(--limina-c-terminal-text);
}
.evals-mini-rate.skill .evals-mini-track i {
  background: var(--vp-c-brand-1);
}
.evals-domain-content {
  padding: 0 20px 17px 42px;
}
.evals-task-table {
  width: 100%;
  min-width: 580px;
  border-collapse: collapse;
  text-align: left;
  font-size: 12px;
}
.evals-task-table thead th {
  padding: 10px 12px;
  color: var(--limina-c-terminal-text);
  font-size: 10px;
}
.evals-task-table tbody > tr > * {
  padding: 12px;
  border-top: 1px solid var(--limina-c-line);
}
.evals-task-table .evals-mono {
  font-size: 11px;
}
.evals-task-table .evals-cell-detail {
  font-size: 9px;
}
.evals-negative-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 19px;
  padding: 20px;
  border: 1px dashed var(--limina-c-line);
  border-radius: 7px;
}
h3 {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.8;
}
.evals-negative-controls p {
  margin-top: 5px;
  color: var(--limina-c-terminal-text);
  font-size: 11px;
  line-height: 1.8;
}
.evals-control-result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 25px;
  font-size: 12px;
}
.evals-control-result > .evals-mono {
  color: var(--limina-c-terminal-text);
  font-size: 11px;
}
.evals-control-result b {
  margin-left: 7px;
  font-family: var(--vp-font-family-mono);
  font-weight: 500;
}
.evals-mobile-hint {
  display: none;
}
.evals-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
:is(a, button, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
@media (max-width: 959px) {
  .evals-domain-head,
  .evals-domain > summary {
    grid-template-columns: minmax(0, 1fr) 130px 130px;
    gap: 18px;
  }
  .evals-mini-rate {
    gap: 9px;
  }
}
@media (max-width: 639px) {
  .evals-dashboard {
    padding: 0 20px 48px;
  }
  .evals-hero {
    padding: 50px 0 34px;
  }
  .evals-eyebrow {
    font-size: 10px;
    letter-spacing: 0.09em;
  }
  .evals-intro {
    font-size: 15px;
  }
  .evals-meta {
    gap: 10px;
    margin-top: 19px;
    font-size: 11px;
  }
  .evals-meta-divider {
    display: none;
  }
  .evals-meta > span:nth-child(3) {
    width: 100%;
  }
  .evals-census {
    grid-template-columns: repeat(2, 1fr);
    gap: 24px 0;
    padding: 24px 0;
  }
  .evals-census > div {
    padding: 0 20px;
  }
  .evals-census > div:nth-child(2) {
    border-right: 0;
  }
  .evals-census dd {
    font-size: 25px;
  }
  .evals-census dt {
    font-size: 11px;
  }
  .evals-section {
    margin-top: 42px;
  }
  h2 {
    font-size: 23px;
  }
  .evals-section-head {
    gap: 18px;
    margin-bottom: 18px;
  }
  .evals-mobile-hint {
    display: block;
    margin-bottom: 9px;
    color: var(--limina-c-terminal-text);
    font-size: 10px;
  }
  .evals-domain-head,
  .evals-domain > summary {
    grid-template-columns: minmax(0, 1fr) 58px 58px;
    gap: 12px;
  }
  .evals-domain-head {
    padding-right: 13px;
    padding-left: 13px;
  }
  .evals-domain > summary {
    padding: 14px 13px;
  }
  .evals-domain-title {
    gap: 7px;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .evals-task-count {
    flex-basis: 100%;
    margin-left: 19px;
    font-size: 9px;
  }
  .evals-mini-track {
    display: none;
  }
  .evals-mini-rate {
    font-size: 10px;
  }
  .evals-domain-content {
    padding-left: 13px;
    padding-right: 13px;
  }
  .evals-negative-controls {
    padding: 17px;
  }
  .evals-control-result {
    gap: 20px;
  }
}
@media (forced-colors: active) {
  .evals-tag {
    outline: 1px solid Highlight;
  }
  .evals-score-track,
  .evals-mini-track {
    border: 1px solid CanvasText;
  }
  .evals-score-track > span,
  .evals-mini-track i {
    background: Highlight;
  }
  .evals-chevron {
    stroke: CanvasText;
  }
}

.evals-table-notes .evals-conclusion {
  color: var(--vp-c-brand-1);
  font-size: 13px;
  font-weight: 500;
}
.evals-method-note {
  margin: 32px 0 0;
  padding-top: 16px;
  border-top: 1px solid var(--limina-c-line);
  color: var(--limina-c-terminal-text);
  font-size: 12px;
  line-height: 1.8;
}
</style>
