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

export function observeWork<T>(
  observer: AnalysisObserver | undefined,
  op: string,
  action: () => T,
  scope?: ProfileScope,
  pass?: number,
  end: 'performed' | 'computed' = 'performed',
): T {
  if (observer === undefined) return action();
  const work = observer.start(op, scope, undefined, pass);
  try {
    const result = observer.inWork(work, action);
    observer.finish(work, end);
    return result;
  } catch (error) {
    observer.finish(work, 'failed');
    throw error;
  }
}

export function observeAsyncWork<T>(
  observer: AnalysisObserver | undefined,
  op: string,
  action: () => Promise<T>,
  scope?: ProfileScope,
): Promise<T> {
  if (observer === undefined) return action();
  const work = observer.start(op, scope);
  return observer.inWork(work, async () => {
    try {
      const result = await action();
      observer.finish(work);
      return result;
    } catch (error) {
      observer.finish(work, 'failed');
      throw error;
    }
  });
}
