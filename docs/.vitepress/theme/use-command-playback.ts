import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CommandTranscript } from './command-transcripts';

export function useCommandPlayback(
  transcript: () => CommandTranscript,
  isPlaying: () => boolean,
  finish: () => void,
) {
  const typedCharacters = ref(0);
  const visibleFrameIndex = ref(-1);
  const reducedMotion = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let motionQuery: MediaQueryList | undefined;

  const complete = computed(
    () =>
      typedCharacters.value === transcript().command.length &&
      visibleFrameIndex.value === transcript().frames.length - 1,
  );
  const typedCommand = computed(() =>
    transcript().command.slice(0, typedCharacters.value),
  );
  const visibleLines = computed(
    () => transcript().frames[visibleFrameIndex.value]?.lines ?? [],
  );

  function stop() {
    clearTimeout(timer);
    timer = undefined;
  }

  function showAll() {
    stop();
    typedCharacters.value = transcript().command.length;
    visibleFrameIndex.value = transcript().frames.length - 1;
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
      schedule(
        typedCharacters.value === transcript().command.length
          ? transcript().frames[0]!.atMs
          : 38,
      );
      return;
    }
    if (visibleFrameIndex.value < transcript().frames.length - 1) {
      visibleFrameIndex.value += 1;
      const next = transcript().frames[visibleFrameIndex.value + 1];
      if (next)
        schedule(
          next.atMs - transcript().frames[visibleFrameIndex.value]!.atMs,
        );
      else finish();
      return;
    }
    finish();
  }

  function reset() {
    stop();
    typedCharacters.value = 0;
    visibleFrameIndex.value = -1;
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
    visibleFrameIndex,
    visibleLines,
  };
}
