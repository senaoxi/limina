import { onContentUpdated, useData, useRoute } from 'vitepress';
import { onBeforeUnmount, onMounted, type Ref, watch } from 'vue';

interface SearchSession {
  opener: HTMLElement;
  path: string;
  navigating: boolean;
}

function focusContent(): void {
  const hash = decodeURIComponent(globalThis.location.hash.slice(1));
  const target =
    (hash && document.querySelector<HTMLElement>(`#${CSS.escape(hash)}`)) ||
    document.querySelector<HTMLElement>('.VPDoc h1');
  target?.focus({ preventScroll: true });
}

/** VitePress 1.6.4 exposes no search-close or local-outline button slot.
 * This adapter only adds semantics/focus; it never owns search or menu state.
 * Tables use the Markdown hook and ReadingTable instead of DOM rewriting.
 */
export function useReadingEnhancements(isArticle: Ref<boolean>): void {
  const { lang } = useData();
  const route = useRoute();
  let cleanup: (() => void) | undefined;
  let stop: (() => void) | undefined;
  let refresh: (() => void) | undefined;
  let isPendingNavigation = false;

  onContentUpdated(() => {
    refresh?.();
    if (!isPendingNavigation) {
      return;
    }

    isPendingNavigation = false;
    focusContent();
  });

  onMounted(() => {
    stop = watch(
      [isArticle, () => route.path],
      () => {
        cleanup?.();
        cleanup = undefined;
        if (isArticle.value) cleanup = attach();
      },
      { immediate: true, flush: 'post' },
    );
  });
  onBeforeUnmount(() => {
    stop?.();
    cleanup?.();
  });

  function attach(): () => void {
    const root = document.querySelector<HTMLElement>('.limina-reading');
    let session: SearchSession | undefined;
    let portal: HTMLElement | null = null;
    let frame = 0;

    function rememberSearch(opener?: HTMLElement): void {
      if (portal) return;
      const fallback = root?.querySelector<HTMLElement>(
        ':scope #local-search button',
      );
      const active = document.activeElement;
      const element = opener ?? (active instanceof HTMLElement ? active : null);
      const target = element && element !== document.body ? element : fallback;
      if (target)
        session = { opener: target, path: route.path, navigating: false };
    }

    function syncSearch(): void {
      const next = document.querySelector<HTMLElement>('.VPLocalSearchBox');
      if (next) {
        portal = next;
        next.classList.add('limina-reading-portal');
        next.lang = lang.value;
      } else if (portal) {
        portal = null;
        const closed = session;
        session = undefined;
        frame = requestAnimationFrame(() => {
          if (closed?.navigating) {
            if (!isPendingNavigation) focusContent();
          } else if (closed?.path === route.path && closed.opener.isConnected) {
            closed.opener.focus({ preventScroll: true });
          }
        });
      }
    }

    function syncOutline(): void {
      const dropdown = root?.querySelector('.VPLocalNavOutlineDropdown');
      const button = dropdown?.querySelector('button');
      if (!button) return;
      const panel = dropdown?.querySelector<HTMLElement>('.items');
      button.setAttribute(
        'aria-expanded',
        String(button.classList.contains('open')),
      );
      if (panel) {
        panel.id = 'limina-mobile-outline';
        button.setAttribute('aria-controls', panel.id);
      } else {
        button.removeAttribute('aria-controls');
      }
    }

    function syncPageSemantics(): void {
      const currentPath = globalThis.location.pathname
        .replace(/\.html$/, '')
        .replace(/\/$/, '');
      root
        ?.querySelectorAll<HTMLAnchorElement>(':scope .VPSidebar a.link')
        .forEach((link) => {
          const path = new URL(link.href).pathname
            .replace(/\.html$/, '')
            .replace(/\/$/, '');
          link.setAttribute(
            'aria-current',
            path === currentPath ? 'page' : 'false',
          );
        });
      root
        ?.querySelectorAll<HTMLButtonElement>('button.copy')
        .forEach((button) => {
          button.setAttribute(
            'aria-label',
            lang.value.startsWith('zh') ? '复制代码' : 'Copy code',
          );
        });
      syncOutline();
    }

    function selectResult(link: HTMLAnchorElement): void {
      if (!session) return;
      session.navigating = true;
      isPendingNavigation =
        new URL(link.href).pathname !== globalThis.location.pathname;
    }

    function onClick(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const trigger = target.closest<HTMLElement>('#local-search button');
      if (trigger && root?.contains(trigger)) rememberSearch(trigger);
      const result = target.closest<HTMLAnchorElement>(
        '.VPLocalSearchBox .result',
      );
      if (result) selectResult(result);
    }

    function onKeydown(event: KeyboardEvent): void {
      const target = event.target;
      const isEditing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (
        (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) ||
        (!isEditing && event.key === '/')
      )
        rememberSearch();
      if (
        session &&
        !event.isComposing &&
        event.key === 'Enter' &&
        target instanceof HTMLInputElement &&
        portal?.querySelector<HTMLAnchorElement>('.result.selected')
      ) {
        const result =
          portal.querySelector<HTMLAnchorElement>('.result.selected');
        if (result) selectResult(result);
      }
      if (event.key !== 'Escape') return;
      const button = root?.querySelector<HTMLButtonElement>(
        ':scope .VPLocalNavOutlineDropdown button.open',
      );
      if (button)
        frame = requestAnimationFrame(() =>
          button.focus({ preventScroll: true }),
        );
    }

    const searchObserver = new MutationObserver(syncSearch);
    searchObserver.observe(document.body, { childList: true });
    const outlineObserver = new MutationObserver(syncOutline);
    const dropdown = root?.querySelector('.VPLocalNavOutlineDropdown');
    if (dropdown)
      outlineObserver.observe(dropdown, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    document.addEventListener('click', onClick, { capture: true });
    globalThis.addEventListener('keydown', onKeydown, { capture: true });
    refresh = syncPageSemantics;
    syncPageSemantics();
    syncSearch();

    return () => {
      refresh = undefined;
      searchObserver.disconnect();
      outlineObserver.disconnect();
      document.removeEventListener('click', onClick, true);
      globalThis.removeEventListener('keydown', onKeydown, true);
      cancelAnimationFrame(frame);
      portal?.classList.remove('limina-reading-portal');
    };
  }
}
