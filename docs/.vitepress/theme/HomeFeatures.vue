<script setup lang="ts">
import { useData, withBase } from 'vitepress';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { commandTranscripts } from './command-transcripts';
import CommandTerminal from './CommandTerminal.vue';

const { lang } = useData();
const chinese = computed(() => lang.value.startsWith('zh'));
const activeIndex = ref(0);
const activeCommandIndex = ref(0);
const isPlaying = ref(false);
const consolePanel = ref<HTMLElement>();
const consoleHeight = ref(320);
const groups = computed(() => {
  const zh = chinese.value;
  return [
    {
      id: 'build',
      number: '01',
      eyebrow: zh ? '增量构建' : 'INCREMENTAL BUILDS',
      title: zh
        ? '从现有配置生成构建图'
        : 'Generate a graph from existing configs',
      intro: zh
        ? '读取 TypeScript 配置与源码依赖，生成类型构建所需的项目图。'
        : 'Read TypeScript configs and source dependencies to generate a graph for type builds.',
      commands: [
        {
          label: zh ? '生成项目图' : 'Prepare graph',
          transcript: commandTranscripts.prepare!,
        },
        {
          label: zh ? '首次构建' : 'First build',
          transcript: commandTranscripts.build!,
        },
        {
          label: zh ? '增量重跑' : 'Build again',
          transcript: commandTranscripts.incremental!,
        },
      ],
      features: [
        {
          commandIndex: 0,
          title: zh ? '接入增量构建' : 'Adopt incremental type builds',
          body: zh
            ? '为受管理的 TypeScript 与 Vue 项目准备声明构建配置，再由选定的检查器执行增量构建。源码配置与跨项目引用须满足 Limina 的图约束。'
            : 'Prepare declaration build configurations for managed TypeScript and Vue projects, then let the selected checker build them incrementally. Source configs and cross-project references must satisfy Limina’s graph requirements.',
          path: 'getting-started',
          link: zh ? '开始接入' : 'Get started',
        },
        {
          commandIndex: 1,
          title: zh ? '选择类型检查器' : 'Choose a type checker',
          body: zh
            ? '使用兼容工具链进行 TypeScript、Vue、Astro 和 Svelte 检查。声明构建由 tsc、tsgo 或 vue-tsc 执行；Astro 与 Svelte 按叶子配置执行类型检查。'
            : 'Check TypeScript, Vue, Astro, and Svelte with compatible toolchains. Declaration builds use tsc, tsgo, or vue-tsc; Astro and Svelte run typechecks for leaf configs.',
          path: 'config/checkers',
          link: zh ? '配置检查器' : 'Configure checkers',
        },
      ],
    },
    {
      id: 'governance',
      number: '02',
      eyebrow: zh ? '架构与覆盖' : 'ARCHITECTURE & COVERAGE',
      title: zh
        ? '检查依赖、边界与覆盖'
        : 'Check dependencies, boundaries, and coverage',
      intro: zh
        ? '检查治理范围内的代码关系。诊断包含规则和能够取得的项目、包或源码证据。'
        : 'Check code relationships within the governance scope. Diagnostics include the rule and available project, package, or source evidence.',
      commands: [
        {
          label: zh ? '依赖关系' : 'Graph',
          transcript: commandTranscripts.graph!,
        },
        {
          label: zh ? '边界诊断' : 'Boundary',
          transcript: commandTranscripts.boundary!,
        },
        {
          label: zh ? '检查覆盖' : 'Coverage',
          transcript: commandTranscripts.proof!,
        },
      ],
      features: [
        {
          commandIndex: 0,
          title: zh ? '治理依赖关系' : 'Govern the dependency graph',
          body: zh
            ? '检查项目引用、访问边界与依赖声明，报告缺失、冗余或不符合规则的连接。'
            : 'Check project references, access boundaries, and dependency declarations for missing, redundant, or invalid relationships.',
          path: 'config/graph-rules',
          link: zh ? '配置图规则' : 'Configure graph rules',
        },
        {
          commandIndex: 1,
          title: zh ? '保护源码边界' : 'Protect source boundaries',
          body: zh
            ? '在配置的治理范围内，检查跨包相对导入、包导入授权、依赖声明和源码归属。'
            : 'Check cross-package relative imports, package import authorization, dependency declarations, and source ownership within the configured scope.',
          path: 'config/source-boundary',
          link: zh ? '配置源码边界' : 'Configure source boundaries',
        },
        {
          commandIndex: 2,
          title: zh ? '确认检查覆盖' : 'Verify check coverage',
          body: zh
            ? '将配置的源码范围与项目图、检查器目标和注明理由的允许清单进行对照，检查遗漏、重复覆盖与范围偏差。覆盖证明说明计划中的检查覆盖范围，不代表每个检查器进程都已执行。'
            : 'Compare the configured source scope with graph and checker targets plus reasoned allowlist entries to find omissions, duplicate coverage, and scope mismatches. Coverage proof describes planned coverage; it does not certify that every checker process has run.',
          path: 'config/checkers',
          link: zh ? '配置检查入口' : 'Configure checker entries',
        },
      ],
    },
    {
      id: 'pipeline',
      number: '03',
      eyebrow: zh ? '流水线与发布' : 'PIPELINES & RELEASES',
      title: zh ? '按需要组合检查任务' : 'Combine the checks you need',
      intro: zh
        ? '检查可以独立运行，也可以将构建和产物检查组合成命名流水线。'
        : 'Run checks independently or combine builds and artifact checks in a named pipeline.',
      commands: [
        {
          label: zh ? '默认检查' : 'Default check',
          transcript: commandTranscripts.check!,
        },
        {
          label: zh ? '发布流水线' : 'Release pipeline',
          transcript: commandTranscripts.pipeline!,
        },
      ],
      features: [
        {
          commandIndex: 0,
          title: zh ? '编排检查流程' : 'Compose check pipelines',
          body: zh
            ? '构建、依赖关系、源码边界与覆盖证明都可以独立使用。默认检查在资源允许时并发执行；命名流水线按配置顺序运行，适用于本地开发、持续集成与发布前检查。'
            : 'Builds, graph checks, source-boundary checks, and coverage checks can run independently. Default checks may run concurrently when resources allow; named pipelines follow the configured order for local development, CI, and release gates.',
          path: 'config/pipelines',
          link: zh ? '配置检查流水线' : 'Configure pipelines',
        },
        {
          commandIndex: 1,
          title: zh ? '补充发布检查' : 'Add release checks',
          body: zh
            ? '发布或预发布前，先运行项目自身的构建，再检查包信息、类型入口、构建产物和打包内容。Limina 负责检查，构建与发布仍由项目的工具执行。'
            : 'Before a release or prerelease, run the project’s build, then check package metadata, type entry points, build output, and packed contents. Limina performs these checks; the project’s tools handle building and publishing.',
          path: 'config/release-checks',
          link: zh ? '配置发布检查' : 'Configure release checks',
        },
      ],
    },
  ];
});
const activeGroup = computed(() => groups.value[activeIndex.value]!);
let frame: number | undefined;
let resizeObserver: ResizeObserver | undefined;

function play() {
  isPlaying.value = true;
}
function syncScroll() {
  frame = undefined;
  const trigger =
    globalThis.innerWidth < 768
      ? Math.min(
          globalThis.innerHeight - 80,
          32 + (consolePanel.value?.offsetHeight ?? 320),
        )
      : Math.min(380, globalThis.innerHeight * 0.38);
  let index = 0;
  for (const [candidate, group] of groups.value.entries()) {
    const section = document.getElementById(group.id);
    if (!section || section.getBoundingClientRect().top > trigger) break;
    index = candidate;
  }
  let commandIndex = 0;
  const section = document.getElementById(groups.value[index]!.id);
  for (const feature of section?.querySelectorAll<HTMLElement>(
    '.features-feature',
  ) ?? []) {
    if (feature.getBoundingClientRect().top > trigger) break;
    commandIndex = Number(feature.dataset.commandIndex);
  }
  if (index === activeIndex.value && commandIndex === activeCommandIndex.value)
    return;
  activeIndex.value = index;
  activeCommandIndex.value = commandIndex;
  isPlaying.value = true;
}
function requestSync() {
  if (consolePanel.value) consoleHeight.value = consolePanel.value.offsetHeight;
  if (frame === undefined) frame = requestAnimationFrame(syncScroll);
}
onMounted(() => {
  globalThis.addEventListener('scroll', requestSync, { passive: true });
  globalThis.addEventListener('resize', requestSync);
  resizeObserver = new ResizeObserver(() => {
    if (consolePanel.value)
      consoleHeight.value = consolePanel.value.offsetHeight;
  });
  if (consolePanel.value) resizeObserver.observe(consolePanel.value);
  requestSync();
});
watch(lang, async () => {
  await nextTick();
  requestSync();
});
onBeforeUnmount(() => {
  globalThis.removeEventListener('scroll', requestSync);
  globalThis.removeEventListener('resize', requestSync);
  resizeObserver?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
});
function link(path: string) {
  return withBase((chinese.value ? '/zh/' : '/') + path);
}
</script>

<template>
  <div class="home-features">
    <!-- Native anchors respect the sticky console’s scroll margin. -->
    <nav
      class="features-nav vp-raw"
      :aria-label="chinese ? '首页功能展示' : 'Feature overview'"
    >
      <span>{{ chinese ? '查看 Limina 如何工作' : 'See Limina at work' }}</span>
      <a
        v-for="group in groups"
        :key="group.id"
        :href="'#' + group.id"
        :aria-current="activeGroup.id === group.id ? 'step' : undefined"
        >{{ group.eyebrow }}<span aria-hidden="true">↗</span></a
      >
    </nav>
    <div
      class="features-workspace"
      :style="{ '--features-console-height': consoleHeight + 'px' }"
    >
      <div ref="consolePanel" class="features-console">
        <p class="features-console-label" aria-live="polite">
          <span>{{ activeGroup.number }}</span
          >{{ activeGroup.eyebrow }}
        </p>
        <CommandTerminal
          :id="activeGroup.id"
          :command-index="activeCommandIndex"
          :label="activeGroup.title"
          :commands="activeGroup.commands"
          :playing="isPlaying"
          :chinese="chinese"
          :autoplay="true"
          @play="play"
          @pause="isPlaying = false"
        />
      </div>
      <div class="features-copies">
        <section
          v-for="group in groups"
          :id="group.id"
          :key="group.id"
          class="features-section"
          :class="{ 'is-active': activeGroup.id === group.id }"
          :aria-labelledby="'heading-' + group.id"
        >
          <div class="features-copy">
            <p class="features-eyebrow">
              <span>{{ group.number }}</span
              >{{ group.eyebrow }}
            </p>
            <h2 :id="'heading-' + group.id">{{ group.title }}</h2>
            <p class="features-intro">{{ group.intro }}</p>
            <div
              v-for="feature in group.features"
              :key="feature.path"
              class="features-feature"
              :data-command-index="feature.commandIndex"
              :class="{
                'is-active':
                  activeGroup.id === group.id &&
                  activeCommandIndex === feature.commandIndex,
              }"
            >
              <h3>{{ feature.title }}</h3>
              <p>{{ feature.body }}</p>
              <a :href="link(feature.path)"
                >{{ feature.link }}<span aria-hidden="true">→</span></a
              >
            </div>
          </div>
        </section>
      </div>
    </div>
    <div class="features-next">
      <p>
        {{
          chinese
            ? '可以先接入增量构建，再按需启用治理检查。'
            : 'Start with incremental builds, then enable governance checks as needed.'
        }}
      </p>
      <a :href="link('built-in-tasks')"
        >{{ chinese ? '查看全部内置任务' : 'View all built-in tasks'
        }}<span aria-hidden="true">→</span></a
      >
    </div>
  </div>
</template>

<style scoped>
.home-features {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 64px;
}
.features-nav {
  display: flex;
  align-items: center;
  gap: 28px;
  padding: 24px 0;
  border-top: 1px solid var(--limina-c-line);
  border-bottom: 1px solid var(--limina-c-line);
  font-size: 11px;
  line-height: 1.5;
  letter-spacing: 0.025em;
}
.features-nav > span {
  flex: 1;
  color: var(--vp-c-text-3);
  font-size: 12px;
  letter-spacing: 0;
}
.features-nav a {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--vp-c-text-2);
}
.features-nav a:hover {
  color: var(--vp-c-brand-1);
}
.features-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  align-items: start;
  gap: 64px;
  padding-top: 80px;
  border-bottom: 1px solid var(--limina-c-line);
}
.features-console {
  position: sticky;
  top: calc(var(--vp-nav-height) + 24px);
  align-self: start;
  min-width: 0;
}
.features-console-label {
  display: flex;
  gap: 14px;
  margin: 0 0 14px;
  color: var(--vp-c-brand-1);
  font: 11px/1.6 var(--vp-font-family-mono);
  letter-spacing: 0.05em;
}
.features-console-label span {
  color: var(--vp-c-text-3);
}
.features-console :deep(.terminal-log) {
  height: clamp(220px, 44svh, 400px);
}
.features-section {
  min-height: calc(100svh - 100px);
  padding: 0 0 100px;
  scroll-margin-top: 96px;
}
.features-section + .features-section {
  padding-top: 48px;
}
.features-section.is-active .features-eyebrow {
  color: var(--vp-c-brand-1);
}
.features-nav a[aria-current='step'] {
  color: var(--vp-c-brand-1);
}
.features-copies {
  min-width: 0;
}
.features-copy {
  min-width: 0;
  padding-top: 3px;
}
.features-eyebrow {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 0 20px;
  color: var(--vp-c-text-2);
  font: 11px/1.6 var(--vp-font-family-mono);
  letter-spacing: 0.06em;
}
.features-eyebrow span {
  color: var(--vp-c-text-3);
}
h2 {
  margin: 0 0 20px;
  color: var(--limina-c-ink);
  font-size: 30px;
  line-height: 1.3;
  letter-spacing: -0.035em;
  font-weight: 600;
  text-wrap: balance;
}
.features-intro {
  margin: 0 0 32px;
  color: var(--vp-c-text-2);
  font-size: 16px;
  line-height: 1.75;
}
.features-feature + .features-feature {
  margin-top: 28px;
}
h3 {
  margin: 0 0 8px;
  color: var(--limina-c-ink);
  font-size: 15px;
  line-height: 1.5;
  font-weight: 600;
}
.features-feature.is-active h3 {
  color: var(--vp-c-brand-1);
}
.features-feature p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.8;
}
.features-feature a {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  color: var(--vp-c-brand-1);
  font-size: 13px;
  line-height: 1.6;
}
.features-feature a:hover {
  text-decoration: underline;
  text-underline-offset: 4px;
}
.features-next {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 36px 0 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
}
.features-next p {
  margin: 0;
}
.features-next a {
  display: inline-flex;
  gap: 10px;
  color: var(--vp-c-brand-1);
}
a:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 4px;
  border-radius: 2px;
}
@media (max-width: 959px) {
  .home-features {
    padding: 0 40px;
  }
  .features-workspace {
    gap: 36px;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    padding-top: 64px;
  }
  .features-nav {
    gap: 18px;
    font-size: 10px;
  }
  h2 {
    font-size: 26px;
  }
}
@media (max-width: 767px) {
  .home-features {
    padding: 0 24px;
  }
  .features-nav {
    flex-wrap: wrap;
    gap: 12px 20px;
    padding: 20px 0;
  }
  .features-nav > span {
    flex-basis: 100%;
  }
  .features-workspace {
    display: block;
    padding-top: 32px;
  }
  .features-console {
    top: 8px;
    z-index: 20;
    padding: 8px 0 14px;
    background: var(--vp-c-bg);
    box-shadow: 0 12px 24px rgb(24 43 50 / 0.05);
  }
  .features-console-label {
    margin-bottom: 8px;
    font-size: 10px;
  }
  .features-console :deep(.terminal-log) {
    height: clamp(104px, 18svh, 148px);
    padding: 12px 14px;
  }
  .features-console :deep(.terminal-titlebar) {
    padding: 8px 14px;
  }
  .features-console :deep(.terminal-controls) {
    min-height: 42px;
    padding: 8px 12px;
  }
  .features-console :deep(.terminal-caption) {
    padding: 10px 12px;
  }
  .features-copies {
    padding-top: 32px;
  }
  .features-section {
    min-height: calc(100svh - 240px);
    padding: 16px 0 72px;
    scroll-margin-top: calc(var(--features-console-height) + 24px);
  }
  .features-section + .features-section {
    padding-top: 32px;
  }
  .features-copy h2 {
    max-width: 540px;
    font-size: 28px;
  }
  .features-intro {
    margin-bottom: 24px;
  }
  .features-feature + .features-feature {
    margin-top: 22px;
  }
  .features-next {
    align-items: start;
    flex-direction: column;
    gap: 18px;
  }
}
</style>
