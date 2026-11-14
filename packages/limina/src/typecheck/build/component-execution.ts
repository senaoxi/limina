import type { TypecheckTarget } from '../targets';
import type { BuildDependencyPlan } from './dependency-plan';

interface RunComponentTargetsOptions {
  concurrency: number;
  plan: BuildDependencyPlan;
  prepareComponent?: (componentIndex: number) => readonly TypecheckTarget[];
  run: (target: TypecheckTarget) => Promise<void>;
}

export async function runComponentTargets(
  options: RunComponentTargetsOptions,
): Promise<void> {
  const pending = new Set(options.plan.layers.flat());
  const completed = new Set<number>();
  const outstanding = new Map<number, number>();
  const ready: { componentIndex: number; target: TypecheckTarget }[] = [];
  const running = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;

  function enqueueReadyComponents(): void {
    for (const componentIndex of pending) {
      const dependencies =
        options.plan.dependenciesByComponentIndex.get(componentIndex);
      if (dependencies && !dependencies.isSubsetOf(completed)) continue;
      pending.delete(componentIndex);
      const targets =
        options.prepareComponent?.(componentIndex) ??
        options.plan.components[componentIndex]!;
      outstanding.set(componentIndex, targets.length);
      if (targets.length === 0) completed.add(componentIndex);
      for (const target of targets) ready.push({ componentIndex, target });
    }
  }

  function launch(target: TypecheckTarget, componentIndex: number): void {
    async function execute(): Promise<void> {
      // Register ownership before a synchronous callback can finish or fail.
      await Promise.resolve();
      try {
        await options.run(target);
      } catch (error) {
        failure ??= { error };
      } finally {
        running.delete(task);
        const remaining = outstanding.get(componentIndex)! - 1;
        outstanding.set(componentIndex, remaining);
        if (remaining === 0) completed.add(componentIndex);
      }
    }
    const task = execute();
    running.add(task);
  }

  try {
    while (pending.size > 0 || ready.length > 0 || running.size > 0) {
      if (failure !== undefined) break;
      enqueueReadyComponents();
      while (running.size < options.concurrency && ready.length > 0) {
        const item = ready.shift()!;
        launch(item.target, item.componentIndex);
      }
      if (running.size === 0) {
        if (pending.size === 0 && ready.length === 0) break;
        throw new Error('Checker dependency plan has no runnable target.');
      }
      await Promise.race(running);
    }
  } catch (error) {
    failure ??= { error };
  } finally {
    await Promise.all(running);
  }
  if (failure !== undefined) throw failure.error;
}
