<script setup lang="ts">
import { useData } from 'vitepress';
import {
  computed,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
} from 'vue';
import BankCalibration from './EvalsBankCalibration.vue';
import EvalsRate from './EvalsRate.vue';
import type { PublicBankCalibration } from './evals-calibration-types';
import type { PublicCampaign, PublishedAverage } from './evals-campaign-types';
import index from './evals-campaigns.json';
import {
  bindCurrentSummary,
  bindPublishedCohort,
  completePublishedCohorts,
  latestCampaignEntries,
  publishedModelRows,
  type PublishedCohort,
} from './evals-cohorts';
import currentSummary from './evals-current-results.json';
import summaryDownload from './evals-current-results.json?url';
import latestBank from './evals-latest-bank.json';
import type { PublicCurrentSummary } from './evals-summary-types';
import type { PublicTaskResult } from './evals-task-result-types';
import latestTask from './evals-task-result.json';
const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const calibration = latestBank as PublicBankCalibration;
const summaryData = currentSummary as PublicCurrentSummary;
const taskData = latestTask as PublicTaskResult;
const entries = latestCampaignEntries(
  index.campaigns,
  calibration,
  summaryData,
);
const selected = ref('');
const snapshots = import.meta.glob('./evals-campaigns/*.json', {
  import: 'default',
}) as Record<string, () => Promise<PublicCampaign>>;
const snapshotUrls = import.meta.glob('./evals-campaigns/*.json', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const taskSnapshotUrls = import.meta.glob('./evals-task-results/*.json', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const loadedCohorts = shallowRef<PublishedCohort[]>([]);
const availableCohorts = computed(() =>
  completePublishedCohorts(loadedCohorts.value),
);
const stages = computed(() => [
  ...new Set(availableCohorts.value.map((c) => c.data.stage)),
]);
const cohorts = computed(() =>
  availableCohorts.value.filter((c) => c.data.stage === selected.value),
);
const modelRows = computed(() => {
  const rows = publishedModelRows(cohorts.value);
  return selected.value === summaryData.stage && rows.length > 0
    ? bindCurrentSummary(rows, summaryData, taskData)
    : rows;
});
const loadError = ref(false);
const loading = ref(entries.length > 0);
const expandedModels = ref<string[]>([]);
function toggleModel(key: string) {
  expandedModels.value = expandedModels.value.includes(key)
    ? expandedModels.value.filter((value) => value !== key)
    : [...expandedModels.value, key];
}
watch(selected, () => {
  expandedModels.value = [];
});
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
    if (disposed) return;
    bindCurrentSummary(publishedModelRows(loaded), summaryData, taskData);
    loadedCohorts.value = loaded;
    selected.value = stages.value.includes('sealed')
      ? 'sealed'
      : (stages.value.at(-1) ?? '');
  } catch {
    if (!disposed) loadError.value = true;
  } finally {
    if (!disposed) loading.value = false;
  }
});
const conditions = ['base', 'skill', 'candidate', 'explicit-skill'];
const text = computed(() =>
  zh.value
    ? {
        select: '评测阶段',
        title: 'Limina 评测',
        pending:
          '当前题库尚无完整的正式批次结果。题库校准通过不代表模型能力或 Skill 增益。',
        loading: '正在读取当前题库的评测结果…',
        loadError: '结果来源与当前题库不一致或无法读取，暂不展示成绩。',
        model: '模型',
        agent: 'Agent',
        duration: '平均耗时',
        cost: '平均 API 等价成本',
        actualCost: '实际费用',
        measured: '测量覆盖',
        cells: '任务 × 条件覆盖',
        taskCount: '任务数',
        passedExecutions: '成功 / 执行',
        validPlanned: '可判 / 计划',
        endToEnd: '端到端耗时',
        condition: '条件',
        metricNotes:
          '耗时与成本先在每题每条件内平均，再让各单元等权；主表合并 Base / Skill，负控单列。每个选中任务条件包含其全部实际执行；其他历史执行保留在来源资料中。平均耗时为 Agent 执行时间，端到端另列。缺失测量不计入均值，保留执行与单元覆盖；API 等价成本使用来源冻结价表，包含可观察的缓存定价，不等于实际账单，也不含 Sandbox 或服务成本。',
        rateNotes:
          'Base / Skill 为八领域等权的独立尝试成功率，不是 pass@k；成功 / 执行是原始计数，未决结果不作成功，另列可判 / 计划。各行保留自己的题库、Skill 和 Runner 身份；来源不同的行仅作描述性并列。',
        lift: '差值（百分点）',
        incomplete:
          '比较未完成；点值仅描述已有可判样本，请同时查看覆盖及范围。',
        unavailable: '未准入',
        missing: '缺少运行资料',
        tasks: '任务与独立尝试',
        domain: '领域',
        counts: '通过 / 可判 / 计划',
        controls: '负控',
        repeat: '重复',
        status: '状态',
        pair: 'Base / Skill 配对',
        regression: '回归数',
        activation: 'Skill 提供与使用证据',
        attribution: '失败归因',
        unknown: '未知',
        download: '下载本批数据',
        executions: '实际执行',
        planned: '计划槽位',
        coverage: '可判覆盖率',
        bounds: '全分配槽位范围',
        installed: '已安装',
        discoverable: '可发现',
        discovered: '已发现',
        read: '已读取',
        followed: '已遵循',
        references: '已读参考数',
        notes:
          '每题三次重复是有限稳定性观察。安装或未读取 Skill 的执行仍留在预分配组；归因不改变成绩。',
      }
    : {
        select: 'Evaluation stage',
        title: 'Limina Evals',
        pending:
          'No complete formal batch is available for this bank. Task calibration does not establish model ability or Skill lift.',
        loading: 'Loading evaluation results for the current bank…',
        loadError:
          'The result is unavailable or does not match the current bank. Scores are withheld.',
        model: 'Model',
        agent: 'Agent',
        duration: 'Avg duration',
        cost: 'Avg API-equivalent cost',
        actualCost: 'Actual charges',
        measured: 'Measurement coverage',
        cells: 'Task × condition coverage',
        taskCount: 'Tasks',
        passedExecutions: 'Passed / executions',
        validPlanned: 'Determinable / assigned',
        endToEnd: 'End-to-end duration',
        condition: 'Condition',
        metricNotes:
          'Duration and cost average attempts within each task and condition, then weight those cells equally. Model rows combine Base / Skill; controls stay separate. Each selected task condition includes all of its physical executions; other historical executions remain in source records. Duration is Agent execution time; end-to-end time is shown separately. Missing measurements are excluded from means with execution and cell coverage retained. API-equivalent costs use source-frozen prices, including observed cache pricing; they are not actual bills and exclude Sandbox and serving costs.',
        rateNotes:
          'Base / Skill show independent-attempt rates with eight equally weighted domains, not pass@k. Passed / executions are raw counts; unresolved results are not successes. Determinable / assigned is shown separately. Each row retains its own bank, Skill and Runner identities; rows from different sources are descriptive comparisons.',
        lift: 'Difference (pp)',
        incomplete:
          'Incomplete comparison; point estimates describe determinable samples only. Inspect coverage and bounds.',
        unavailable: 'Not admitted',
        missing: 'Missing records',
        tasks: 'Tasks and independent attempts',
        domain: 'Domain',
        counts: 'Passed / determinable / planned',
        controls: 'Negative controls',
        repeat: 'Repeat',
        status: 'Status',
        pair: 'Base / Skill pairs',
        regression: 'Regressions',
        activation: 'Skill provision and usage evidence',
        attribution: 'Failure attribution',
        unknown: 'Unknown',
        download: 'Download cohort data',
        executions: 'Physical executions',
        planned: 'Assigned slots',
        coverage: 'Determinable coverage',
        bounds: 'Bounds over assigned slots',
        installed: 'Installed',
        discoverable: 'Discoverable',
        discovered: 'Discovered',
        read: 'Read',
        followed: 'Followed',
        references: 'References read',
        notes:
          'Three repetitions per task provide limited stability evidence. Skill attempts remain in their assigned arm, including unread Skill. Attribution never changes scores.',
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
const cellCoverage = (m: PublishedAverage | undefined) =>
  m ? `${m.measuredCells}/${m.cells}` : 'N/A';
function counts(c: { passed: number; valid: number; planned: number }) {
  return `${c.passed} / ${c.valid} / ${c.planned}`;
}
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
  <div class="evals-page">
    <div class="evals-cohorts">
      <h1 id="evals-model-title">
        {{ text.title
        }}<span class="bank-version">{{ calibration.bankRevision }}</span>
      </h1>
      <label v-if="stages.length > 1" for="evals-cohort">{{
        text.select
      }}</label>
      <select v-if="stages.length > 1" id="evals-cohort" v-model="selected">
        <option v-for="stage in stages" :key="stage" :value="stage">
          {{ stageName(stage) }}
        </option>
      </select>
      <p v-if="loadError" role="alert">{{ text.loadError }}</p>
      <p v-else-if="loading" role="status">{{ text.loading }}</p>
      <div
        v-else-if="modelRows.length === 0"
        class="matrix-scroll empty-model-results"
      >
        <table>
          <thead>
            <tr>
              <th>{{ text.model }}</th>
              <th>{{ text.agent }}</th>
              <th>{{ text.duration }}</th>
              <th>{{ text.cost }}</th>
              <th>Base</th>
              <th>Skill</th>
              <th>{{ text.lift }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colspan="7" role="status">{{ text.pending }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <section
      v-if="cohorts.length > 0"
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
            <template v-for="m in modelRows" :key="m.key"
              ><tr class="model-row">
                <th scope="row">
                  <button
                    type="button"
                    class="model-toggle"
                    :aria-expanded="expandedModels.includes(m.key)"
                    @click="toggleModel(m.key)"
                  >
                    <span aria-hidden="true" class="row-chevron">{{
                      expandedModels.includes(m.key) ? '⌄' : '›'
                    }}</span
                    >{{ m.profile.displayName }}
                  </button>
                  <small
                    v-if="m.report && !m.report.complete"
                    class="model-status"
                    >{{ zh ? '部分数据' : 'Partial data' }}</small
                  ><small
                    v-else-if="m.status === 'not_admitted'"
                    class="model-status"
                    >{{ text.unavailable }}</small
                  >
                </th>
                <td class="agent-cell">
                  Codex<small>{{ m.profile.codexVersion ?? 'N/A' }}</small>
                </td>
                <td>
                  {{ duration(m.report?.measurements?.main.all.agentMs) }}
                  <small :title="text.measured">
                    {{
                      coverage(m.report?.measurements?.main.all.agentMs)
                    }}</small
                  >
                </td>
                <td>
                  {{ money(m.report?.measurements?.main.all.apiEquivalentUsd) }}
                  <small :title="text.measured">
                    {{
                      coverage(
                        m.report?.measurements?.main.all.apiEquivalentUsd,
                      )
                    }}</small
                  >
                </td>
                <template v-if="m.report"
                  ><td>
                    <EvalsRate
                      :value="m.report.macro.base"
                      condition="base"
                      :passed="m.report.counts?.base?.passed"
                      :executions="m.report.counts?.base?.executions"
                    />
                  </td>
                  <td>
                    <EvalsRate
                      :value="m.report.macro.skill"
                      condition="skill"
                      :passed="m.report.counts?.skill?.passed"
                      :executions="m.report.counts?.skill?.executions"
                    />
                  </td>
                  <td>
                    <span
                      class="lift-value"
                      :class="{
                        positive: (m.report.liftPercentagePoints ?? 0) > 0,
                        negative: (m.report.liftPercentagePoints ?? 0) < 0,
                      }"
                      >{{ points(m.report.liftPercentagePoints) }}</span
                    >
                  </td></template
                >
                <td v-else colspan="3">
                  N/A ·
                  {{
                    m.status === 'not_admitted'
                      ? text.unavailable
                      : text.missing
                  }}
                </td>
              </tr>
              <tr v-if="expandedModels.includes(m.key)" class="model-expanded">
                <td colspan="7">
                  <div :id="`model-${m.key}`" class="model-details">
                    <template v-if="m.report">
                      <h2>{{ zh ? '领域表现' : 'Domain results' }}</h2>
                      <div class="matrix-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>{{ text.domain }}</th>
                              <th>{{ text.taskCount }}</th>
                              <th>Base</th>
                              <th>Skill</th>
                              <th>{{ text.lift }}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr v-for="d in m.report.domains" :key="d.id">
                              <th>{{ d.id }}</th>
                              <td>{{ d.taskCount ?? 'N/A' }}</td>
                              <td>
                                <EvalsRate
                                  :value="d.conditions.base"
                                  condition="base"
                                  :passed="d.counts?.base?.passed"
                                  :executions="d.counts?.base?.executions"
                                />
                              </td>
                              <td>
                                <EvalsRate
                                  :value="d.conditions.skill"
                                  condition="skill"
                                  :passed="d.counts?.skill?.passed"
                                  :executions="d.counts?.skill?.executions"
                                />
                              </td>
                              <td>{{ points(d.liftPercentagePoints) }}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <h2>{{ text.tasks }}</h2>
                      <details
                        v-for="task in m.report.tasks"
                        :key="task.id"
                        class="task-details"
                      >
                        <summary>
                          <span class="task-name"
                            ><strong>{{ task.id }}</strong
                            ><span
                              v-if="
                                task.comparison.valid &&
                                task.comparison.regressed > 0
                              "
                              class="regression-count"
                              :title="text.regression"
                              :aria-label="`${text.regression}: ${task.comparison.regressed}`"
                              >↓{{ task.comparison.regressed }}</span
                            >
                            <small>{{
                              task.role === 'negative-control'
                                ? text.controls
                                : task.domain
                            }}</small></span
                          >
                          <span
                            v-for="condition in ['base', 'skill'].filter(
                              (id) => task.conditions[id],
                            )"
                            :key="condition"
                            class="attempt-summary"
                          >
                            <small>{{
                              condition === 'base' ? 'Base' : 'Skill'
                            }}</small>
                            <span class="attempt-marks">
                              <template
                                v-for="run in task.conditions[condition]!
                                  .repetitions"
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
                          </span>
                        </summary>
                        <p>
                          {{ text.pair }}: {{ task.comparison.valid }} /
                          {{ task.comparison.planned }} · {{ text.lift }}:
                          {{ points(task.comparison.liftPercentagePoints) }}
                        </p>
                        <ul>
                          <li
                            v-for="pair in task.comparison.pairs"
                            :key="pair.repetition"
                          >
                            {{ text.repeat }} {{ pair.repetition }} · Base
                            {{
                              pair.base === null
                                ? text.unknown
                                : percentage(pair.base)
                            }}
                            / Skill
                            {{
                              pair.skill === null
                                ? text.unknown
                                : percentage(pair.skill)
                            }}
                          </li>
                        </ul>
                        <div
                          v-for="condition in conditions.filter(
                            (id) => task.conditions[id],
                          )"
                          :key="condition"
                        >
                          <h3>
                            {{ condition }} · {{ text.counts }}
                            {{ counts(task.conditions[condition]!) }}
                          </h3>
                          <p
                            v-if="
                              m.summary &&
                              task.id === m.summary.sources.task.taskId
                            "
                            class="cohort-muted"
                          >
                            Bank
                            {{
                              condition === m.summary.sources.task.condition
                                ? m.summary.sources.task.bankId
                                : m.summary.sources.base.bankId
                            }}
                          </p>
                          <p>
                            {{ text.passedExecutions }}
                            {{ task.conditions[condition]!.passed }}/{{
                              task.conditions[condition]!.executions ?? 'N/A'
                            }}
                          </p>
                          <p v-if="task.conditions[condition]!.measurements">
                            {{ text.duration }}
                            {{
                              duration(
                                task.conditions[condition]!.measurements!
                                  .agentMs,
                              )
                            }}
                            · {{ text.measured }}
                            {{
                              coverage(
                                task.conditions[condition]!.measurements!
                                  .agentMs,
                              )
                            }}
                            · {{ text.endToEnd }}
                            {{
                              duration(
                                task.conditions[condition]!.measurements!
                                  .endToEndMs,
                              )
                            }}
                            <br />{{ text.cost }}
                            {{
                              money(
                                task.conditions[condition]!.measurements!
                                  .apiEquivalentUsd,
                              )
                            }}
                            · {{ text.measured }}
                            {{
                              coverage(
                                task.conditions[condition]!.measurements!
                                  .apiEquivalentUsd,
                              )
                            }}
                            · {{ text.actualCost }}
                            {{
                              money(
                                task.conditions[condition]!.measurements!
                                  .settledUsd,
                              )
                            }}
                          </p>
                          <p>
                            {{ text.coverage }}
                            {{
                              percentage(task.conditions[condition]!.coverage)
                            }}
                            · {{ text.bounds }} [{{
                              percentage(
                                task.conditions[condition]!.bounds?.[0],
                              )
                            }},
                            {{
                              percentage(
                                task.conditions[condition]!.bounds?.[1],
                              )
                            }}]
                          </p>
                          <ol>
                            <li
                              v-for="run in task.conditions[condition]!
                                .repetitions"
                              :key="run.repetition"
                            >
                              {{ text.repeat }} {{ run.repetition }} ·
                              {{ text.status }} {{ run.status }} ·
                              {{ run.attemptCount }}
                              <ul
                                v-if="
                                  run.attempts.length > 1 ||
                                  (run.attempts.length === 1 &&
                                    run.attempts[0]!.status !== run.status)
                                "
                              >
                                <li
                                  v-for="attempt in run.attempts"
                                  :key="attempt.id"
                                >
                                  {{ attempt.ordinal }} · {{ attempt.status }}
                                </li>
                              </ul>
                              <p v-if="run.activation">
                                {{ text.activation }}: {{ text.installed }}
                                {{ run.activation.installed }} ·
                                {{ text.discoverable }}
                                {{ run.activation.discoverable }} ·
                                {{ text.discovered }}
                                {{ run.activation.discovered }} ·
                                {{ text.read }} {{ run.activation.skillRead }} ·
                                {{ text.references }}
                                {{ run.activation.referencesRead }} ·
                                {{ text.followed }}
                                {{ run.activation.followed }}
                              </p>
                              <p>
                                {{ text.attribution }}:
                                {{
                                  run.attribution
                                    ? `${run.attribution.primary} (${run.attribution.adjudication}, ${run.attribution.confidence})`
                                    : text.unknown
                                }}
                              </p>
                            </li>
                          </ol>
                        </div>
                      </details>
                    </template>
                    <details class="model-metadata">
                      <summary>
                        {{
                          zh
                            ? '执行指标与来源'
                            : 'Execution metrics and sources'
                        }}
                      </summary>
                      <p class="detail-heading">
                        {{ m.profile.displayName }} · {{ text.executions }}
                        {{ m.report?.executions ?? 0 }} · {{ text.planned }}
                        {{ m.planned }}
                      </p>
                      <p class="cohort-muted">
                        {{ m.profile.model }} ·
                        {{ m.profile.reasoningEffort }} ·
                        {{ m.profile.serviceTier }}
                      </p>
                      <div v-if="m.summary" class="cohort-muted">
                        <p>
                          {{ zh ? '汇总身份' : 'Summary' }}
                          {{ m.summary.identity }} ·
                          <a :href="summaryDownload" download>{{
                            zh ? '下载汇总数据' : 'Download summary data'
                          }}</a>
                        </p>
                        <p>
                          {{
                            zh
                              ? '选中执行 / 来源执行'
                              : 'Selected / source executions'
                          }}
                          {{ m.summary.selectedExecutions }} /
                          {{ m.summary.sourceExecutions }}
                        </p>
                        <p
                          v-for="(source, key) in m.summary.sources"
                          :key="key"
                        >
                          Bank {{ source.bankId }} · Campaign
                          {{ source.campaignId }} · Report
                          {{ source.reportIdentity }} ·
                          <a
                            :href="
                              key === 'base'
                                ? snapshotUrls[source.file]
                                : taskSnapshotUrls[source.file]
                            "
                            download
                            >{{
                              zh ? '下载来源数据' : 'Download source data'
                            }}</a
                          >
                        </p>
                      </div>
                      <p v-else class="cohort-muted">
                        Campaign {{ m.source.campaignId }} · Report
                        {{ m.source.reportIdentity }} ·
                        <a :href="snapshotUrls[m.file]" download>{{
                          text.download
                        }}</a>
                      </p>
                      <template v-if="m.report">
                        <p
                          v-for="condition in conditions.filter(
                            (id) => m.report!.counts?.[id],
                          )"
                          :key="condition"
                        >
                          {{ condition }} · {{ text.passedExecutions }}
                          {{ m.report.counts![condition]!.passed }}/{{
                            m.report.counts![condition]!.executions
                          }}
                          · {{ text.validPlanned }}
                          {{ m.report.counts![condition]!.valid }}/{{
                            m.report.counts![condition]!.planned
                          }}
                        </p>
                        <p v-if="m.report.measurements" class="cohort-muted">
                          <template v-if="!m.summary">
                            {{ zh ? '冻结价表' : 'Frozen pricing' }}:
                            {{ m.report.measurements.pricing.version }} ·
                          </template>
                          {{ text.cells }}
                          {{
                            cellCoverage(
                              m.report.measurements.main.all.apiEquivalentUsd,
                            )
                          }}
                          · {{ text.endToEnd }}
                          {{
                            duration(m.report.measurements.main.all.endToEndMs)
                          }}
                          ·
                          {{ text.actualCost }}
                          {{ money(m.report.measurements.main.all.settledUsd) }}
                        </p>
                        <div v-if="m.report.measurements" class="matrix-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>{{ text.condition }}</th>
                                <th>{{ text.duration }}</th>
                                <th>{{ text.endToEnd }}</th>
                                <th>{{ text.cost }}</th>
                                <th>{{ text.actualCost }}</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr
                                v-for="condition in conditions.filter(
                                  (id) =>
                                    m.report!.measurements!.main.conditions[id],
                                )"
                                :key="condition"
                              >
                                <th>{{ condition }}</th>
                                <td>
                                  {{
                                    duration(
                                      m.report.measurements.main.conditions[
                                        condition
                                      ]!.agentMs,
                                    )
                                  }}<small
                                    >{{ text.measured }}
                                    {{
                                      coverage(
                                        m.report.measurements.main.conditions[
                                          condition
                                        ]!.agentMs,
                                      )
                                    }}</small
                                  >
                                </td>
                                <td>
                                  {{
                                    duration(
                                      m.report.measurements.main.conditions[
                                        condition
                                      ]!.endToEndMs,
                                    )
                                  }}
                                </td>
                                <td>
                                  {{
                                    money(
                                      m.report.measurements.main.conditions[
                                        condition
                                      ]!.apiEquivalentUsd,
                                    )
                                  }}<small
                                    >{{ text.measured }}
                                    {{
                                      coverage(
                                        m.report.measurements.main.conditions[
                                          condition
                                        ]!.apiEquivalentUsd,
                                      )
                                    }}</small
                                  >
                                </td>
                                <td>
                                  {{
                                    money(
                                      m.report.measurements.main.conditions[
                                        condition
                                      ]!.settledUsd,
                                    )
                                  }}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </template>
                    </details>
                    <p v-if="!m.report">
                      N/A ·
                      {{
                        m.status === 'not_admitted'
                          ? text.unavailable
                          : text.missing
                      }}
                    </p>
                  </div>
                </td>
              </tr></template
            >
          </tbody>
        </table>
      </div>
      <p
        v-if="modelRows.some((m) => m.report && !m.report.complete)"
        class="table-note"
      >
        {{ text.incomplete }}
      </p>
      <details class="methods-details">
        <summary>
          {{ zh ? '统计方法与数据来源' : 'Methodology and data sources' }}
        </summary>
        <template
          v-for="m in modelRows.filter((row) => row.summary)"
          :key="m.key"
        >
          <p>
            {{
              zh
                ? '汇总按每题最新完整结果选择执行，保留不同题库与执行身份。差值描述当前 Base / Skill 的成绩差异；跨来源条件不重新认定为同批配对。全部原始成绩和未选中的历史执行仍保留。'
                : 'The summary selects the latest complete results per task and retains distinct bank and execution identities. Differences describe the current Base / Skill results; conditions from different sources do not become same-experiment pairs. All original scores and unselected historical executions remain available.'
            }}
          </p>
          <p>
            {{ zh ? '选中执行 / 来源执行' : 'Selected / source executions' }}
            {{ m.summary!.selectedExecutions }} /
            {{ m.summary!.sourceExecutions }} ·
            <a :href="summaryDownload" download>{{
              zh ? '下载汇总数据' : 'Download summary data'
            }}</a>
          </p>
        </template>
        <ul class="cohort-sources">
          <li v-for="cohort in cohorts" :key="cohort.file">
            {{
              publishedModelRows([cohort])
                .map((m) => m.profile.displayName)
                .join(', ')
            }}
            · {{ cohort.data.campaignId.slice(0, 12) }} ·
            <a :href="snapshotUrls[cohort.file]" download>{{
              text.download
            }}</a>
          </li>
        </ul>
        <p
          v-if="
            cohorts.some((c) => c.data.comparability === 'native-profile') ||
            cohorts.length > 1
          "
        >
          {{
            zh
              ? '各行保留独立批次与执行时段；原生配置可能包含不同指令与能力限制，不提供严格跨模型排名。'
              : 'Rows retain independent cohorts and execution periods. Native profiles may differ in instructions and capability limits; no strict cross-model ranking is provided.'
          }}
        </p>
        <p class="metric-notes">{{ text.rateNotes }}</p>
        <p class="metric-notes">{{ text.metricNotes }}</p>
        <p>{{ text.notes }}</p>
      </details>
    </section>
    <details class="calibration-details">
      <summary>
        {{ zh ? '题库校准' : 'Task bank calibration'
        }}<span
          >{{ zh ? '评分器' : 'Graders' }}
          {{ calibration.graderCalibration.matched }}/{{
            calibration.graderCalibration.cases
          }}
          · {{ zh ? '审题' : 'Reviews' }}
          {{ calibration.independentReview.passed }}/{{
            calibration.inventory.tasks
          }}</span
        >
      </summary>
      <BankCalibration :data="calibration" />
    </details>
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
  padding-right: 180px;
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
.evals-cohorts label {
  position: absolute;
  width: 1px;
  height: 1px;
  clip-path: inset(50%);
  overflow: hidden;
}
.evals-cohorts select {
  position: absolute;
  right: 0;
  top: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 6px 12px;
  background: var(--vp-c-bg);
}
.cohort-muted,
small {
  color: var(--vp-c-text-2);
}
.cohort-muted {
  overflow-wrap: anywhere;
}
small {
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
  min-width: 64rem;
}
.agent-cell {
  white-space: nowrap;
}
.metric-notes {
  font-size: 13px;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}
.table-note {
  margin: 12px 0;
  font-size: 12px;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}
.model-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  font-weight: 500;
  cursor: pointer;
  border-radius: 4px;
}
.model-toggle:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 4px;
}
.row-chevron {
  width: 12px;
  color: var(--vp-c-text-2);
  font-size: 20px;
  line-height: 1;
}
.model-status {
  margin-left: 22px;
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
.detail-heading {
  font-weight: 600;
}
.model-details h2 {
  margin: 20px 0 12px;
  font-size: 16px;
  font-weight: 600;
}
.model-details > h2:first-child {
  margin-top: 0;
}
.model-metadata {
  margin-top: 20px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.model-metadata > summary {
  cursor: pointer;
}
.calibration-details {
  margin-top: 16px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.calibration-details > summary {
  cursor: pointer;
}
.calibration-details > summary > span {
  margin-left: 12px;
  font-variant-numeric: tabular-nums;
}
.methods-details {
  margin-top: 16px;
  color: var(--vp-c-text-2);
  font-size: 13px;
}
.methods-details > summary {
  font-weight: 400;
}
@media (max-width: 639px) {
  .evals-page {
    padding: 28px 20px 40px;
  }
  .evals-cohorts h1 {
    font-size: 24px;
    padding-right: 120px;
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
.task-details {
  border-bottom: 1px solid var(--vp-c-divider);
}
.task-details > summary {
  display: grid;
  grid-template-columns: minmax(12rem, 1fr) repeat(2, minmax(9rem, auto));
  align-items: center;
  gap: 16px;
  padding: 12px 0;
  list-style: none;
  cursor: pointer;
}
.task-details > summary::-webkit-details-marker {
  display: none;
}
.task-name {
  position: relative;
  padding-left: 18px;
}
.task-name::before {
  content: '›';
  position: absolute;
  left: 0;
  top: 4px;
  color: var(--vp-c-text-2);
}
.task-details[open] > summary .task-name::before {
  content: '⌄';
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
.task-details[open] {
  padding-bottom: 16px;
}
.task-details > :not(summary) {
  margin: 12px 0;
}
.task-details ol {
  padding-left: 24px;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
li p {
  overflow-wrap: anywhere;
}
a {
  color: var(--vp-c-brand-1);
}
</style>
