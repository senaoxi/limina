import type {
  AnalysisObserver,
  ProfileScope,
} from '../application/analysis/observability';

const observedContexts = new WeakMap<
  object,
  WeakMap<AnalysisObserver, ProfileScope>
>();

export function priorProfileContextScope(
  observer: AnalysisObserver | undefined,
  instance: object,
): ProfileScope | undefined {
  return observer === undefined
    ? undefined
    : observedContexts.get(instance)?.get(observer);
}

export function profileContextScope(
  observer: AnalysisObserver | undefined,
  input: {
    instance: object;
    configPath: string;
    checker: string;
    provider: string;
    role: string;
  },
): ProfileScope | undefined {
  if (observer === undefined) return undefined;
  const project = observer.project(input.configPath);
  const providerRun = observer.currentProviderRun();
  const previous = observedContexts.get(input.instance);
  if (providerRun === undefined)
    return previous?.get(observer) ?? ['project', project];
  const scope: ProfileScope = [
    'context',
    observer.context(
      input.instance,
      project,
      providerRun,
      input.checker,
      input.provider,
      input.role,
    ),
  ];
  const observations = previous ?? new WeakMap();
  observations.set(observer, scope);
  if (previous === undefined)
    observedContexts.set(input.instance, observations);
  return scope;
}

export function observeContextRestore<T extends object>(
  observer: AnalysisObserver,
  op: 'native-context-restore' | 'vue-context-restore',
  restore: () => T | undefined,
  identity: Omit<Parameters<typeof profileContextScope>[1], 'instance'>,
): T | undefined {
  const work = observer.start(op);
  try {
    const instance = observer.inWork(work, restore);
    if (instance === undefined) observer.finish(work);
    else {
      const scope = profileContextScope(observer, { ...identity, instance });
      observer.finish(work, 'restored', undefined, scope);
    }
    return instance;
  } catch (error) {
    observer.finish(work, 'failed');
    throw error;
  }
}

export { observeWork } from '../application/analysis/observability';

export function observeAsyncWork<T>(
  observer: AnalysisObserver | undefined,
  op: string,
  action: () => Promise<T>,
  failureReason?: string,
): Promise<T> {
  if (observer === undefined) return action();
  const work = observer.start(op);
  return observer.inWork(work, async () => {
    try {
      const result = await action();
      observer.finish(work);
      return result;
    } catch (error) {
      observer.fail(work, error, failureReason);
      throw error;
    }
  });
}
