<script setup lang="ts">
import { useData } from 'vitepress';
import { computed, onBeforeUnmount, ref } from 'vue';

const { lang } = useData();
const chinese = computed(() => lang.value.startsWith('zh'));
const manager = ref('pnpm');
const isCopied = ref(false);
const hasCopyFailed = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
// These commands are the paired getting-started pages' installation examples.
const command = computed(() =>
  manager.value === 'pnpm'
    ? 'pnpm add -D limina@latest typescript'
    : 'npm install -D limina@latest typescript',
);
function selectManager(value: string) {
  manager.value = value;
  isCopied.value = false;
  hasCopyFailed.value = false;
  clearTimeout(timer);
}
async function copyCommand() {
  try {
    await navigator.clipboard.writeText(command.value);
    isCopied.value = true;
    hasCopyFailed.value = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      isCopied.value = false;
    }, 2000);
  } catch {
    hasCopyFailed.value = true;
  }
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="home-install">
    <div class="install-heading">
      <div
        role="group"
        :aria-label="chinese ? '选择包管理器' : 'Choose a package manager'"
      >
        <button
          v-for="item in ['pnpm', 'npm']"
          :key="item"
          type="button"
          :aria-pressed="manager === item"
          @click="selectManager(item)"
        >
          {{ item }}
        </button>
      </div>
      <span>{{ chinese ? '安装到你的工程' : 'INSTALL IN YOUR PROJECT' }}</span>
    </div>
    <div class="install-command">
      <code><span aria-hidden="true">$ </span>{{ command }}</code>
      <button type="button" @click="copyCommand">
        [
        {{
          isCopied ? (chinese ? '已复制' : 'Copied') : chinese ? '复制' : 'Copy'
        }}
        ]
      </button>
    </div>
    <span class="install-feedback" role="status" aria-live="polite">{{
      hasCopyFailed
        ? chinese
          ? '复制不可用，请手动选择命令。'
          : 'Copy is unavailable. Select the command manually.'
        : isCopied
          ? chinese
            ? '命令已复制'
            : 'Command copied'
          : ''
    }}</span>
  </div>
</template>

<style scoped>
.home-install {
  position: relative;
  max-width: 760px;
  margin: 36px auto 0;
  border: 1px solid var(--limina-c-line);
  border-radius: 4px;
  background: var(--vp-c-bg);
  text-align: left;
  box-shadow: 0 12px 32px rgb(24 43 50 / 0.035);
}
.install-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--limina-c-line);
  background: var(--limina-c-terminal);
}
.install-heading > div {
  display: flex;
}
.install-heading button {
  padding: 14px 24px;
  border-right: 1px solid var(--limina-c-line);
  color: var(--vp-c-text-2);
  font: 12px/1.4 var(--vp-font-family-mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.install-heading button[aria-pressed='true'] {
  color: var(--vp-c-brand-1);
  box-shadow: inset 0 -2px var(--vp-c-brand-1);
}
.install-heading > span {
  padding: 0 20px;
  color: var(--vp-c-text-3);
  font: 10px/1.4 var(--vp-font-family-mono);
  letter-spacing: 0.04em;
}
.install-command {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 26px 24px;
}
.install-command code {
  flex: 1;
  min-width: 0;
  color: var(--limina-c-ink);
  font: 14px/1.8 var(--vp-font-family-mono);
  overflow-wrap: anywhere;
}
.install-command code > span {
  color: var(--vp-c-text-3);
}
.install-command button {
  flex-shrink: 0;
  padding: 8px 14px;
  border: 1px solid var(--limina-c-line);
  border-radius: 2px;
  color: var(--vp-c-text-2);
  font: 11px/1.6 var(--vp-font-family-mono);
}
button {
  cursor: pointer;
}
button:hover {
  color: var(--vp-c-brand-1);
}
button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
.install-feedback {
  position: absolute;
  top: 100%;
  left: 0;
  display: block;
  padding: 8px 0;
  color: var(--vp-c-text-2);
  font-size: 12px;
}
@media (max-width: 639px) {
  .home-install {
    margin-top: 28px;
  }
  .install-heading button {
    padding: 12px 20px;
  }
  .install-heading > span {
    padding: 0 12px;
    font-size: 9px;
  }
  .install-command {
    align-items: start;
    padding: 20px 16px;
    gap: 12px;
  }
  .install-command code {
    font-size: 12px;
  }
  .install-command button {
    padding: 6px 8px;
    font-size: 10px;
  }
}
</style>
