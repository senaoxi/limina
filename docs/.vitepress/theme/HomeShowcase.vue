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
import { demoTranscripts } from './demo-transcripts';
import TerminalDemo from './TerminalDemo.vue';

const { lang } = useData();
const chinese = computed(() => lang.value.startsWith('zh'));
const activeIndex = ref(0);
const activeScenario = ref(0);
const isPlaying = ref(false);
const hasUserPaused = ref(false);
const consolePanel = ref<HTMLElement>();
const consoleHeight = ref(320);
const groups = computed(() => {
  const zh = chinese.value;
  return [
    {
      id: 'build',
      number: '01',
      eyebrow: zh ? '增量构建' : 'INCREMENTAL BUILDS',
      title: zh ? '从现有工程开始' : 'Start with the project you have',
      intro: zh
        ? '读取现有 TypeScript 配置与源码依赖，把项目关系转化为可复用的类型构建图。'
        : 'Turn existing TypeScript configuration and source dependencies into a reusable type build graph.',
      scenarios: [
        {
          label: zh ? '生成项目图' : 'Prepare graph',
          transcript: demoTranscripts.prepare!,
        },
        {
          label: zh ? '首次构建' : 'First build',
          transcript: demoTranscripts.build!,
        },
        {
          label: zh ? '增量重跑' : 'Build again',
          transcript: demoTranscripts.incremental!,
        },
      ],
      features: [
        {
          demoIndex: 0,
          title: zh ? '接入增量构建' : 'Adopt incremental type builds',
          body: zh
            ? '根据源码关系生成声明构建配置与项目引用，由底层检查器安排构建顺序。生成的配置可以重复使用，无需大改工程结构。'
            : 'Generate declaration build configuration and project references from source relationships. The underlying checker follows the build order, and the generated configuration can be reused without reshaping the repository.',
          path: 'getting-started',
          link: zh ? '开始接入' : 'Get started',
        },
        {
          demoIndex: 1,
          title: zh ? '沿用熟悉的检查器' : 'Keep your existing checkers',
          body: zh
            ? '支持 TypeScript、Vue 等检查方式。先接入类型构建，再按仓库需要逐步启用治理规则。'
            : 'Supports TypeScript and Vue checker workflows. Adopt type builds first, then enable governance rules as your repository needs them.',
          path: 'config/checkers',
          link: zh ? '了解检查器配置' : 'Explore checker configuration',
        },
      ],
    },
    {
      id: 'governance',
      number: '02',
      eyebrow: zh ? '架构与覆盖' : 'ARCHITECTURE & COVERAGE',
      title: zh
        ? '让关系、边界与覆盖可见'
        : 'Make relationships and boundaries visible',
      intro: zh
        ? '把代码关系保持在清晰、可检查的状态，让诊断指向具体规则和源码位置。'
        : 'Keep code relationships explicit and checkable, with diagnostics tied to a rule and a source location.',
      scenarios: [
        {
          label: zh ? '依赖关系' : 'Graph',
          transcript: demoTranscripts.graph!,
        },
        {
          label: zh ? '边界诊断' : 'Boundary',
          transcript: demoTranscripts.boundary!,
        },
        {
          label: zh ? '检查覆盖' : 'Coverage',
          transcript: demoTranscripts.proof!,
        },
      ],
      features: [
        {
          demoIndex: 0,
          title: zh ? '治理依赖关系' : 'Govern the dependency graph',
          body: zh
            ? '检查项目引用、访问边界与依赖声明，发现缺失、冗余或不合理的连接。随着仓库增长，代码关系仍然清晰、可维护。'
            : 'Check project references, access boundaries, and dependency declarations for missing, redundant, or invalid relationships. Keep the graph reviewable as the repository grows.',
          path: 'config/graph-rules',
          link: zh ? '配置图规则' : 'Configure graph rules',
        },
        {
          demoIndex: 1,
          title: zh ? '保护源码边界' : 'Protect source boundaries',
          body: zh
            ? '发现跨包相对导入、未授权导入、漏写依赖与源码归属问题，让内部实现与预期的公共入口保持分离。'
            : 'Detect cross-package relative imports, unauthorized imports, missing dependency declarations, and file ownership issues. Keep package internals separated from intended public entry points.',
          path: 'config/source-boundary',
          link: zh ? '配置源码边界' : 'Configure source boundaries',
        },
        {
          demoIndex: 2,
          title: zh ? '确认检查覆盖' : 'Verify check coverage',
          body: zh
            ? '找出未被检查覆盖、重复覆盖或与源码范围不一致的文件，明确哪些代码已有检查、哪些位置仍存在盲区。'
            : 'Find files that are omitted, covered more than once, or covered by the wrong scope. See which code is already guarded and where blind spots remain.',
          path: 'config/checkers',
          link: zh ? '配置检查入口' : 'Configure checker entries',
        },
      ],
    },
    {
      id: 'pipeline',
      number: '03',
      eyebrow: zh ? '流水线与发布' : 'PIPELINES & RELEASES',
      title: zh
        ? '把检查编排进日常流程'
        : 'Give your checks a place in the workflow',
      intro: zh
        ? '独立运行所需检查，也可以把构建和产物检查组合成团队共用的命名流程。'
        : 'Run the checks you need independently, or compose builds and artifact checks into a named workflow for your team.',
      scenarios: [
        {
          label: zh ? '默认检查' : 'Default check',
          transcript: demoTranscripts.check!,
        },
        {
          label: zh ? '发布流水线' : 'Release pipeline',
          transcript: demoTranscripts.pipeline!,
        },
      ],
      features: [
        {
          demoIndex: 0,
          title: zh ? '编排检查流程' : 'Compose check pipelines',
          body: zh
            ? '构建、依赖关系、源码边界与覆盖证明都可以独立使用。默认检查在资源允许时并发执行；命名流水线按配置顺序运行，适用于本地开发、CI 与发布前场景。'
            : 'Builds, graph checks, source-boundary checks, and coverage checks can run independently. Default checks may run concurrently when resources allow; named pipelines follow the configured order for local development, CI, and release gates.',
          path: 'config/pipelines',
          link: zh ? '配置检查流水线' : 'Configure pipelines',
        },
        {
          demoIndex: 1,
          title: zh ? '补充发布检查' : 'Add release checks',
          body: zh
            ? '先运行项目自身的构建，再验证包信息、类型入口、构建产物与打包内容。这些检查为正式发布或预发布增加一道防线，不代替构建与发布工具。'
            : 'Run the project’s own build first, then validate package metadata, type entry points, build output, and packed contents. Add a guardrail for release and prerelease workflows while keeping your build and publishing tools.',
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
  hasUserPaused.value = false;
  isPlaying.value = true;
}
function pause() {
  hasUserPaused.value = true;
  isPlaying.value = false;
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
  let scenario = 0;
  const section = document.getElementById(groups.value[index]!.id);
  for (const feature of section?.querySelectorAll<HTMLElement>(
    '.showcase-feature',
  ) ?? []) {
    if (feature.getBoundingClientRect().top > trigger) break;
    scenario = Number(feature.dataset.demoIndex);
  }
  if (index === activeIndex.value && scenario === activeScenario.value) return;
  activeIndex.value = index;
  activeScenario.value = scenario;
  if (!hasUserPaused.value) isPlaying.value = true;
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
  <div class="home-showcase">
    <!-- Native anchors respect the sticky console’s scroll margin. -->
    <nav
      class="showcase-nav vp-raw"
      :aria-label="chinese ? '首页能力演示' : 'Capability demos'"
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
      class="showcase-workspace"
      :style="{ '--showcase-console-height': consoleHeight + 'px' }"
    >
      <div ref="consolePanel" class="showcase-console">
        <p class="showcase-console-label" aria-live="polite">
          <span>{{ activeGroup.number }}</span
          >{{ activeGroup.eyebrow }}
        </p>
        <TerminalDemo
          :id="activeGroup.id"
          :scenario="activeScenario"
          :label="activeGroup.title"
          :scenarios="activeGroup.scenarios"
          :playing="isPlaying"
          :paused="hasUserPaused"
          :chinese="chinese"
          :autoplay="true"
          @play="play"
          @pause="isPlaying = false"
          @user-pause="pause"
        />
      </div>
      <div class="showcase-copies">
        <section
          v-for="group in groups"
          :id="group.id"
          :key="group.id"
          class="showcase-section"
          :class="{ 'is-active': activeGroup.id === group.id }"
          :aria-labelledby="'heading-' + group.id"
        >
          <div class="showcase-copy">
            <p class="showcase-eyebrow">
              <span>{{ group.number }}</span
              >{{ group.eyebrow }}
            </p>
            <h2 :id="'heading-' + group.id">{{ group.title }}</h2>
            <p class="showcase-intro">{{ group.intro }}</p>
            <div
              v-for="feature in group.features"
              :key="feature.path"
              class="showcase-feature"
              :data-demo-index="feature.demoIndex"
              :class="{
                'is-active':
                  activeGroup.id === group.id &&
                  activeScenario === feature.demoIndex,
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
    <div class="showcase-next">
      <p>
        {{
          chinese
            ? '先接入增量构建，再逐步打开架构治理。'
            : 'Start with incremental builds. Enable governance as you go.'
        }}
      </p>
      <a :href="link('built-in-tasks')"
        >{{ chinese ? '查看全部内置任务' : 'Explore all built-in tasks'
        }}<span aria-hidden="true">→</span></a
      >
    </div>
  </div>
</template>

<style scoped>
.home-showcase {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 64px;
}
.showcase-nav {
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
.showcase-nav > span {
  flex: 1;
  color: var(--vp-c-text-3);
  font-size: 12px;
  letter-spacing: 0;
}
.showcase-nav a {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--vp-c-text-2);
}
.showcase-nav a:hover {
  color: var(--vp-c-brand-1);
}
.showcase-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  align-items: start;
  gap: 64px;
  padding-top: 80px;
  border-bottom: 1px solid var(--limina-c-line);
}
.showcase-console {
  position: sticky;
  top: calc(var(--vp-nav-height) + 24px);
  align-self: start;
  min-width: 0;
}
.showcase-console-label {
  display: flex;
  gap: 14px;
  margin: 0 0 14px;
  color: var(--vp-c-brand-1);
  font: 11px/1.6 var(--vp-font-family-mono);
  letter-spacing: 0.05em;
}
.showcase-console-label span {
  color: var(--vp-c-text-3);
}
.showcase-console :deep(.terminal-log) {
  height: clamp(180px, 34svh, 326px);
}
.showcase-section {
  min-height: calc(100svh - 100px);
  padding: 0 0 100px;
  scroll-margin-top: 96px;
}
.showcase-section + .showcase-section {
  padding-top: 48px;
}
.showcase-section.is-active .showcase-eyebrow {
  color: var(--vp-c-brand-1);
}
.showcase-nav a[aria-current='step'] {
  color: var(--vp-c-brand-1);
}
.showcase-copies {
  min-width: 0;
}
.showcase-copy {
  min-width: 0;
  padding-top: 3px;
}
.showcase-eyebrow {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 0 20px;
  color: var(--vp-c-text-2);
  font: 11px/1.6 var(--vp-font-family-mono);
  letter-spacing: 0.06em;
}
.showcase-eyebrow span {
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
.showcase-intro {
  margin: 0 0 32px;
  color: var(--vp-c-text-2);
  font-size: 16px;
  line-height: 1.75;
}
.showcase-feature + .showcase-feature {
  margin-top: 28px;
}
h3 {
  margin: 0 0 8px;
  color: var(--limina-c-ink);
  font-size: 15px;
  line-height: 1.5;
  font-weight: 600;
}
.showcase-feature.is-active h3 {
  color: var(--vp-c-brand-1);
}
.showcase-feature p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.8;
}
.showcase-feature a {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  color: var(--vp-c-brand-1);
  font-size: 13px;
  line-height: 1.6;
}
.showcase-feature a:hover {
  text-decoration: underline;
  text-underline-offset: 4px;
}
.showcase-next {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 36px 0 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
}
.showcase-next p {
  margin: 0;
}
.showcase-next a {
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
  .home-showcase {
    padding: 0 40px;
  }
  .showcase-workspace {
    gap: 36px;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    padding-top: 64px;
  }
  .showcase-nav {
    gap: 18px;
    font-size: 10px;
  }
  h2 {
    font-size: 26px;
  }
}
@media (max-width: 767px) {
  .home-showcase {
    padding: 0 24px;
  }
  .showcase-nav {
    flex-wrap: wrap;
    gap: 12px 20px;
    padding: 20px 0;
  }
  .showcase-nav > span {
    flex-basis: 100%;
  }
  .showcase-workspace {
    display: block;
    padding-top: 32px;
  }
  .showcase-console {
    top: 8px;
    z-index: 20;
    padding: 8px 0 14px;
    background: var(--vp-c-bg);
    box-shadow: 0 12px 24px rgb(24 43 50 / 0.05);
  }
  .showcase-console-label {
    margin-bottom: 8px;
    font-size: 10px;
  }
  .showcase-console :deep(.terminal-log) {
    height: clamp(104px, 18svh, 148px);
    padding: 12px 14px;
  }
  .showcase-console :deep(.terminal-titlebar) {
    padding: 8px 14px;
  }
  .showcase-console :deep(.terminal-scenarios) {
    padding: 6px 10px;
  }
  .showcase-console :deep(.terminal-controls) {
    min-height: 42px;
    padding: 8px 12px;
  }
  .showcase-console :deep(summary) {
    padding: 8px 12px;
    font-size: 10px;
  }
  .showcase-console :deep(.terminal-transcript > pre) {
    max-height: 180px;
  }
  .showcase-copies {
    padding-top: 32px;
  }
  .showcase-section {
    min-height: calc(100svh - 240px);
    padding: 16px 0 72px;
    scroll-margin-top: calc(var(--showcase-console-height) + 24px);
  }
  .showcase-section + .showcase-section {
    padding-top: 32px;
  }
  .showcase-copy h2 {
    max-width: 540px;
    font-size: 28px;
  }
  .showcase-intro {
    margin-bottom: 24px;
  }
  .showcase-feature + .showcase-feature {
    margin-top: 22px;
  }
  .showcase-next {
    align-items: start;
    flex-direction: column;
    gap: 18px;
  }
}
</style>
