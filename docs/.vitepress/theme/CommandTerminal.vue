<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import type { CommandTranscript } from './command-transcripts';
import { useCommandPlayback } from './use-command-playback';

const props = defineProps<{
  id: string;
  commandIndex: number;
  label: string;
  commands: { label: string; transcript: CommandTranscript }[];
  playing: boolean;
  paused: boolean;
  chinese: boolean;
  autoplay: boolean;
}>();
const emit = defineEmits<{ play: []; pause: []; 'user-pause': [] }>();
const selected = ref(props.commandIndex);
const panel = ref<HTMLElement>();
const log = ref<HTMLElement>();
const transcript = computed(
  () => (props.commands[selected.value] ?? props.commands[0])!.transcript,
);
const playback = useCommandPlayback(
  () => transcript.value,
  () => props.playing,
  () => emit('pause'),
);
const {
  complete,
  reducedMotion,
  reset,
  showAll,
  typedCharacters,
  typedCommand,
  visibleLineCount,
  visibleLines,
} = playback;
let observer: IntersectionObserver | undefined;
let autoStarted = false;

const labels = computed(() =>
  props.chinese
    ? {
        play: '播放',
        pause: '暂停',
        replay: '重播',
        outputAction: '显示输出',
        ready: '待播放',
        playing: '播放中',
        paused: '已暂停',
        complete: '播放完成',
        reduced: '已减弱动画',
        transcript: '查看完整输出',
        commands: '选择命令',
        output: '终端输出',
        recording: 'CLI 运行记录（CI）；项目数量与耗时依工作区而异',
      }
    : {
        play: 'Play',
        pause: 'Pause',
        replay: 'Replay',
        outputAction: 'Show output',
        ready: 'Ready',
        playing: 'Playing',
        paused: 'Paused',
        complete: 'Complete',
        reduced: 'Reduced motion',
        transcript: 'Read full output',
        commands: 'Choose a command',
        output: 'Terminal output',
        recording:
          'Recorded CLI output (CI); counts and timings depend on the workspace',
      },
);
const status = computed(() => {
  if (reducedMotion.value) return labels.value.reduced;
  if (complete.value) return labels.value.complete;
  if (props.playing) return labels.value.playing;
  if (props.paused) return labels.value.paused;
  return typedCharacters.value > 0 ? labels.value.paused : labels.value.ready;
});
const command = computed(() =>
  typedCharacters.value === 0 && !props.playing
    ? transcript.value.command
    : typedCommand.value,
);
const fullOutput = computed(
  () =>
    '$ ' + transcript.value.command + '\n' + transcript.value.lines.join('\n'),
);

function selectCommand(index: number) {
  autoStarted = true;
  if (selected.value === index) reset();
  else selected.value = index;
  emit('play');
}
function replay() {
  autoStarted = true;
  reset();
  emit('play');
}
function toggle() {
  autoStarted = true;
  if (props.playing) emit('user-pause');
  else {
    if (complete.value) reset();
    emit('play');
  }
}
function lineClass(line: string) {
  if (line.includes('[fail]') || line.includes('rule:')) return 'failure';
  if (line.includes('[skip]') || line.includes('disabled')) return 'skipped';
  if (line.includes('[pass]') || line.includes(' passed')) return 'passed';
  if (line.includes('[start]')) return 'started';
  return '';
}

watch(
  () => [props.id, props.commandIndex],
  () => {
    selected.value = props.commandIndex;
    reset();
    if (log.value) log.value.scrollTop = 0;
  },
);

watch(visibleLineCount, async () => {
  await nextTick();
  if (props.playing && log.value) log.value.scrollTop = log.value.scrollHeight;
});
watch(
  () => transcript.value.id,
  () => {
    if (log.value) log.value.scrollTop = 0;
  },
);

onMounted(() => {
  if (!panel.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting && props.playing) emit('pause');
        if (
          entry.isIntersecting &&
          entry.intersectionRatio >= 0.2 &&
          props.autoplay &&
          !autoStarted &&
          !reducedMotion.value
        ) {
          autoStarted = true;
          emit('play');
        }
      }
    },
    { threshold: 0.2 },
  );
  observer.observe(panel.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="panel" class="command-terminal">
    <div class="terminal-titlebar">
      <span class="window-dots" aria-hidden="true"><i /><i /><i /></span>
      <span class="terminal-workspace">{{ transcript.workspace }}</span>
      <span class="terminal-shell">CLI</span>
    </div>
    <div class="terminal-commands" role="group" :aria-label="labels.commands">
      <button
        v-for="(option, index) in commands"
        :key="option.transcript.id"
        type="button"
        :aria-pressed="selected === index"
        @click="selectCommand(index)"
      >
        {{ option.label }}
      </button>
    </div>
    <div
      :id="'terminal-output-' + id"
      ref="log"
      class="terminal-log"
      role="region"
      :aria-label="label + ' — ' + labels.output"
      tabindex="0"
      aria-live="off"
    >
      <pre
        class="terminal-command"
      ><span class="prompt" aria-hidden="true">$ </span>{{ command }}<span v-if="playing && !complete && !reducedMotion" class="cursor" aria-hidden="true" /></pre>
      <pre
        v-for="(line, index) in visibleLines"
        :key="index"
        :class="lineClass(line)"
        >{{ line }}</pre
      >
    </div>
    <div class="terminal-controls">
      <span class="terminal-status" role="status" aria-live="polite"
        ><span :class="{ active: playing }" aria-hidden="true" />{{
          status
        }}</span
      >
      <div class="playback-buttons">
        <button
          v-if="!reducedMotion"
          type="button"
          :aria-controls="'terminal-output-' + id"
          @click="toggle"
        >
          <svg v-if="playing" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3v10M11 3v10" />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path d="m5 3 8 5-8 5Z" />
          </svg>
          {{ playing ? labels.pause : labels.play }}
        </button>
        <button
          v-if="!reducedMotion"
          type="button"
          :aria-controls="'terminal-output-' + id"
          @click="replay"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 6a5 5 0 1 1 0 4M3 2v4h4" /></svg
          >{{ labels.replay }}
        </button>
        <button
          v-if="!complete && !reducedMotion"
          type="button"
          :aria-controls="'terminal-output-' + id"
          @click="showAll"
        >
          {{ labels.outputAction }}
        </button>
      </div>
    </div>
    <details class="terminal-transcript">
      <summary>
        {{ labels.transcript
        }}<span>{{ labels.recording }} · exit {{ transcript.exitCode }}</span>
      </summary>
      <pre>{{ fullOutput }}</pre>
    </details>
  </div>
</template>

<style scoped>
.command-terminal {
  min-width: 0;
  border: 1px solid var(--limina-c-line);
  border-radius: 10px;
  background: var(--limina-c-terminal);
  box-shadow: 0 8px 30px rgb(15 23 42 / 0.04);
  overflow: hidden;
  color: var(--limina-c-terminal-text);
}
.terminal-titlebar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--limina-c-line);
  font: 12px/1.4 var(--vp-font-family-mono);
}
.window-dots {
  display: flex;
  gap: 6px;
}
.window-dots i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--limina-c-dot);
}
.terminal-workspace {
  flex: 1;
  color: var(--vp-c-text-2);
}
.terminal-shell {
  color: var(--vp-c-text-3);
  font-size: 10px;
  letter-spacing: 0.08em;
}
.terminal-commands {
  display: flex;
  gap: 4px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--limina-c-line);
  flex-wrap: wrap;
}
.terminal-commands button {
  padding: 5px 10px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
.terminal-commands button[aria-pressed='true'] {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.terminal-commands button:hover {
  color: var(--vp-c-text-1);
}
.terminal-log {
  height: 326px;
  padding: 22px 20px;
  overflow: auto;
  scroll-behavior: auto;
  scrollbar-width: thin;
}
pre {
  margin: 0;
  min-height: 1.8em;
  white-space: pre;
  overflow-wrap: normal;
  font: 12px/1.8 var(--vp-font-family-mono);
}
.terminal-command {
  margin-bottom: 18px;
  color: var(--limina-c-ink);
}
.prompt {
  color: var(--vp-c-brand-1);
}
.cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 3px;
  background: var(--vp-c-brand-1);
  vertical-align: -2px;
  animation: terminal-blink 1.2s step-end infinite;
}
.passed {
  color: var(--limina-c-success);
}
.skipped {
  color: var(--limina-c-warning);
}
.failure {
  color: var(--limina-c-error);
}
.started {
  color: var(--limina-c-terminal-text);
}
.terminal-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 50px;
  padding: 10px 16px;
  border-top: 1px solid var(--limina-c-line);
}
.terminal-status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--vp-c-text-2);
  white-space: nowrap;
}
.terminal-status > span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--limina-c-dot);
}
.terminal-status > .active {
  background: var(--vp-c-brand-1);
}
.playback-buttons {
  display: flex;
  align-items: center;
  gap: 14px;
}
.playback-buttons button {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--vp-c-text-2);
  font-size: 11px;
  line-height: 1.6;
}
.playback-buttons button:hover {
  color: var(--vp-c-brand-1);
}
svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.terminal-transcript {
  border-top: 1px solid var(--limina-c-line);
}
summary {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  font-size: 11px;
  color: var(--vp-c-text-2);
  cursor: pointer;
  list-style: none;
}
summary::before {
  content: '+';
  margin-right: -6px;
  font: 12px var(--vp-font-family-mono);
}
details[open] summary::before {
  content: '−';
}
summary span {
  margin-left: auto;
  color: var(--vp-c-text-3);
}
.terminal-transcript > pre {
  max-height: 400px;
  overflow: auto;
  padding: 18px 20px;
  border-top: 1px solid var(--limina-c-line);
}
button:focus-visible,
summary:focus-visible,
.terminal-log:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: -3px;
  border-radius: 4px;
}
@keyframes terminal-blink {
  50% {
    opacity: 0;
  }
}
@media (max-width: 639px) {
  .terminal-log {
    height: 288px;
    padding: 18px 14px;
  }
  pre {
    font-size: 11px;
  }
  .terminal-controls {
    padding: 10px 12px;
  }
  .playback-buttons {
    gap: 11px;
  }
  summary {
    flex-wrap: wrap;
    padding: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cursor {
    animation: none;
  }
}
</style>
