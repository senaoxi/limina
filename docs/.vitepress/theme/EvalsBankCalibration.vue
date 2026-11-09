<script setup lang="ts">
import { useData } from 'vitepress';
import { computed } from 'vue';
import type { PublicBankCalibration } from './evals-calibration-types';
import downloadUrl from './evals-latest-bank.json?url';

defineProps<{ data: PublicBankCalibration }>();
const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const text = computed(() =>
  zh.value
    ? {
        calibrated: '离线校准已完成',
        incomplete: '校准仍有未决项',
        calibrationTitle: '题库校准',
        tasks: '任务',
        grading: '评分器校准',
        review: '独立审题',
        controls: '对抗检查',
        matched: '符合预期',
        inventory: '领域',
        negative: '负控',
        development: '开发集',
        sealed: '验收集',
        cases: '正确提交 / 错误修复 / 越权变更',
        distinction:
          '错误修复和越权案例符合预期，表示它们被正确拒绝。校准计数不是模型成功率。',
        method: '独立审题方法',
        reviewers:
          '个全新 Agent 上下文；每题至少三项实际对抗检查。仅提供题面、Fixture 和权限及运行合同，未提供参考解或评分器。',
        transfer:
          '份公开输入通过等价性审计；冻结提交按当前 Bank 重新评分，没有重新求解。',
        table: '全部任务的校准状态',
        task: '任务',
        domain: '领域',
        split: '数据集',
        submission: '提交复核',
        passed: '通过',
        failed: '未通过',
        ambiguous: '有歧义',
        blocked: '受阻',
        error: '异常',
        unknown: '未知',
        provenance: '数据来源与下载',
        download: '下载当前题库摘要',
        scope:
          '仅含校准摘要；题面、隐藏断言、参考解、原始轨迹和私有证据保持私有。',
      }
    : {
        calibrated: 'Offline calibration complete',
        incomplete: 'Calibration has unresolved items',
        calibrationTitle: 'Task bank calibration',
        tasks: 'Tasks',
        grading: 'Grader calibration',
        review: 'Independent review',
        controls: 'Adversarial checks',
        matched: 'Matched expectations',
        inventory: 'Domains',
        negative: 'Controls',
        development: 'Development',
        sealed: 'Sealed',
        cases: 'Correct submissions / incorrect repairs / unauthorized changes',
        distinction:
          'An expected result for an incorrect or unauthorized submission means it was rejected correctly. Calibration counts are not model success rates.',
        method: 'Independent review method',
        reviewers:
          'fresh Agent contexts; at least three actual adversarial checks per task. Reviewers received the prompt, Fixture and permission/runtime contracts, without reference solutions or Graders.',
        transfer:
          'public inputs passed an equivalence audit; frozen submissions were graded against the current bank without solving the tasks again.',
        table: 'Calibration status for all tasks',
        task: 'Task',
        domain: 'Domain',
        split: 'Split',
        submission: 'Submission check',
        passed: 'Passed',
        failed: 'Failed',
        ambiguous: 'Ambiguous',
        blocked: 'Blocked',
        error: 'Error',
        unknown: 'Unknown',
        provenance: 'Source identities and download',
        download: 'Download current bank summary',
        scope:
          'Calibration summaries only. Prompts, hidden assertions, reference solutions, raw traces and private evidence remain private.',
      },
);
const domainNames = computed<Record<string, string>>(() =>
  zh.value
    ? {
        initialization: '初始化',
        configuration: '配置',
        'reference-graph': '引用图',
        checker: '检查器',
        'source-governance': '源码治理',
        workflow: '工作流',
        troubleshooting: '故障排查',
        'package-release': '打包与发布',
        'negative-control': '负控',
      }
    : {
        initialization: 'Initialization',
        configuration: 'Configuration',
        'reference-graph': 'References',
        checker: 'Checkers',
        'source-governance': 'Source governance',
        workflow: 'Workflows',
        troubleshooting: 'Troubleshooting',
        'package-release': 'Package and release',
        'negative-control': 'Negative control',
      },
);
function label(value: string): string {
  if (value === 'passed') return text.value.passed;
  if (
    value === 'failed' ||
    value === 'assertion_failed' ||
    value === 'unsafe_mutation'
  )
    return text.value.failed;
  if (value === 'ambiguous') return text.value.ambiguous;
  if (value === 'blocked') return text.value.blocked;
  if (value.endsWith('_error') || value.endsWith('_timeout'))
    return text.value.error;
  return text.value.unknown;
}
</script>

<template>
  <section class="bank-calibration" aria-labelledby="evals-calibration-title">
    <div class="section-heading">
      <h2 id="evals-calibration-title">{{ text.calibrationTitle }}</h2>
      <span
        class="bank-status"
        :class="{
          ready:
            data.independentReview.status === 'passed' &&
            data.graderCalibration.matched === data.graderCalibration.cases,
        }"
      >
        {{
          data.independentReview.status === 'passed' &&
          data.graderCalibration.matched === data.graderCalibration.cases
            ? text.calibrated
            : text.incomplete
        }}
      </span>
    </div>
    <p class="inventory">
      {{ data.inventory.domains }} {{ text.inventory }} ·
      {{ text.development }} {{ data.inventory.development }} ·
      {{ text.sealed }} {{ data.inventory.sealed }} · {{ text.negative }}
      {{ data.inventory.negativeControls }}
    </p>
    <dl class="calibration-metrics">
      <div>
        <dt>{{ text.tasks }}</dt>
        <dd>{{ data.inventory.tasks }}</dd>
      </div>
      <div>
        <dt>{{ text.grading }}</dt>
        <dd>
          {{ data.graderCalibration.matched
          }}<small> / {{ data.graderCalibration.cases }}</small>
        </dd>
        <dd class="metric-note">{{ text.matched }}</dd>
      </div>
      <div>
        <dt>{{ text.review }}</dt>
        <dd>
          {{ data.independentReview.passed
          }}<small> / {{ data.inventory.tasks }}</small>
        </dd>
        <dd class="metric-note">
          {{ label(data.independentReview.status) }}
        </dd>
      </div>
      <div>
        <dt>{{ text.controls }}</dt>
        <dd>{{ data.independentReview.adversarialChecks }}</dd>
      </div>
    </dl>
    <p class="calibration-note">
      {{ text.cases }}: {{ data.graderCalibration.correct }} /
      {{ data.graderCalibration.incorrect }} /
      {{ data.graderCalibration.unsafe }}. {{ text.distinction }}
    </p>
    <details class="task-calibration" open>
      <summary>
        {{ text.table }} <span>{{ data.inventory.tasks }}</span>
      </summary>
      <div class="table-scroll" tabindex="0" :aria-label="text.table">
        <table>
          <thead>
            <tr>
              <th scope="col">{{ text.task }}</th>
              <th scope="col">{{ text.domain }}</th>
              <th scope="col">{{ text.split }}</th>
              <th scope="col">{{ text.grading }}</th>
              <th scope="col">{{ text.review }}</th>
              <th scope="col">{{ text.submission }}</th>
              <th scope="col">{{ text.controls }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="task in data.tasks"
              :key="task.id"
              :class="{ 'control-row': task.role === 'negative-control' }"
            >
              <th scope="row">{{ task.id }}</th>
              <td>{{ domainNames[task.domain] }}</td>
              <td>
                {{ task.split === 'dev' ? text.development : text.sealed }}
              </td>
              <td>
                {{ task.calibrationMatched }} / {{ task.calibrationCases }}
              </td>
              <td>
                <span
                  class="result"
                  :class="{ ready: task.reviewStatus === 'passed' }"
                  >{{ label(task.reviewStatus) }}</span
                >
              </td>
              <td>{{ label(task.submissionStatus) }}</td>
              <td>{{ task.adversarialChecks }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
    <div class="review-method">
      <h2>{{ text.method }}</h2>
      <p>{{ data.independentReview.reviewers }} {{ text.reviewers }}</p>
      <p
        v-if="
          !data.independentReview.taskExecutionRepeated &&
          data.independentReview.inputEquivalenceAuditors > 0
        "
      >
        {{ data.independentReview.equivalentInputs }} {{ text.transfer }}
      </p>
    </div>
    <details class="bank-provenance">
      <summary>{{ text.provenance }}</summary>
      <dl>
        <dt>Bank Identity</dt>
        <dd>
          <code>{{ data.bankId }}</code>
        </dd>
        <dt>Publication Identity</dt>
        <dd>
          <code>{{ data.identity }}</code>
        </dd>
      </dl>
      <p>{{ text.scope }}</p>
      <a :href="downloadUrl" download>{{ text.download }}</a>
    </details>
  </section>
</template>

<style scoped>
.bank-calibration {
  margin-top: 16px;
}
.section-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.section-heading h2 {
  font-size: 28px;
  line-height: 1.3;
  font-weight: 550;
  letter-spacing: -0.025em;
}
.inventory {
  margin: 12px 0 20px;
  color: var(--vp-c-text-2);
  font-size: 13px;
}
.bank-status,
.result {
  display: inline-block;
  border-radius: 5px;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
}
.ready {
  color: var(--vp-c-brand-1);
  background: var(--limina-doc-soft, var(--vp-c-bg-soft));
}
.calibration-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 24px 48px;
  padding: 16px 0;
}
.calibration-metrics > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
dt {
  color: var(--vp-c-text-2);
  font-size: 13px;
}
.calibration-metrics dd {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.calibration-metrics small {
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 400;
}
.calibration-metrics dd.metric-note {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 400;
}
.calibration-note {
  margin: 6px 0 20px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.75;
}
summary {
  min-height: 44px;
  padding: 12px 0;
  cursor: pointer;
  font-weight: 600;
}
summary span {
  margin-left: 8px;
  color: var(--vp-c-text-2);
  font-weight: 400;
}
summary:focus-visible,
.table-scroll:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 4px;
}
.task-calibration {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
}
.task-calibration > summary {
  padding: 14px 16px;
  font-size: 13px;
  background: var(--vp-c-bg-soft);
}
.table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  text-align: left;
  white-space: nowrap;
}
th,
td {
  padding: 11px 16px;
  border-bottom: 1px solid var(--vp-c-divider);
}
thead th {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-weight: 500;
}
tbody th {
  font-variant-numeric: tabular-nums;
}
tbody tr:last-child > * {
  border-bottom: 0;
}
.control-row {
  background: var(--vp-c-bg-soft);
}
.review-method {
  margin: 28px 0;
  font-size: 14px;
  line-height: 1.8;
}
.review-method h2 {
  margin-bottom: 10px;
  font-size: 16px;
  font-weight: 600;
}
.review-method p {
  color: var(--vp-c-text-2);
  margin-top: 8px;
}
.bank-provenance {
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.8;
}
.bank-provenance dd {
  margin: 3px 0 12px;
  overflow-wrap: anywhere;
}
.bank-provenance a {
  display: inline-block;
  margin-top: 10px;
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-underline-offset: 3px;
}
@media (max-width: 639px) {
  .section-heading h2 {
    font-size: 24px;
  }
  .calibration-metrics {
    gap: 16px 28px;
  }
}
</style>
