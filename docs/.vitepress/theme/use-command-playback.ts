import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CommandTranscript } from './command-transcripts';

export function useCommandPlayback(
  transcript: () => CommandTranscript,
  isPlaying: () => boolean,
  finish: () => void,
) {
  const typedCharacters = ref(0);
  const visibleLineCount = ref(0);
  const reducedMotion = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let motionQuery: MediaQueryList | undefined;

  const complete = computed(
    () =>
      typedCharacters.value === transcript().command.length &&
      visibleLineCount.value === transcript().lines.length,
  );
  const typedCommand = computed(() =>
    transcript().command.slice(0, typedCharacters.value),
  );
  const visibleLines = computed(() =>
    transcript().lines.slice(0, visibleLineCount.value),
  );

  function stop() {
    clearTimeout(timer);
    timer = undefined;
  }

  function showAll() {
    stop();
    typedCharacters.value = transcript().command.length;
    visibleLineCount.value = transcript().lines.length;
    finish();
  }

  function schedule(delay = 400) {
    stop();
    if (!isPlaying() || reducedMotion.value || document.hidden) return;
    timer = setTimeout(tick, delay);
  }

  function tick() {
    timer = undefined;
    if (!isPlaying() || reducedMotion.value || document.hidden) return;
    if (typedCharacters.value < transcript().command.length) {
      typedCharacters.value += 1;
      schedule(38);
      return;
    }
    if (visibleLineCount.value < transcript().lines.length) {
      visibleLineCount.value += 1;
      const line = transcript().lines[visibleLineCount.value - 1];
      schedule(line?.includes('[start]') ? 720 : 480);
      return;
    }
    finish();
  }

  function reset() {
    stop();
    typedCharacters.value = 0;
    visibleLineCount.value = 0;
    if (reducedMotion.value) showAll();
    else if (isPlaying()) schedule();
  }

  function updateMotion() {
    reducedMotion.value = motionQuery?.matches ?? false;
    if (reducedMotion.value) showAll();
  }

  function updateVisibility() {
    if (document.hidden) stop();
    else if (isPlaying() && !complete.value) schedule();
  }

  watch(transcript, reset);
  watch(isPlaying, (value) => {
    stop();
    if (!value) return;
    if (reducedMotion.value) showAll();
    else if (complete.value) finish();
    else schedule();
  });

  onMounted(() => {
    motionQuery = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    updateMotion();
    motionQuery.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
  });

  onBeforeUnmount(() => {
    stop();
    motionQuery?.removeEventListener('change', updateMotion);
    document.removeEventListener('visibilitychange', updateVisibility);
  });

  return {
    complete,
    reducedMotion,
    reset,
    showAll,
    typedCharacters,
    typedCommand,
    visibleLineCount,
    visibleLines,
  };
}
