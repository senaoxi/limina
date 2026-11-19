import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { emptyMetrics } from './cache-metrics';
import {
  AnalysisInputDriftError,
  type AnalysisSnapshot,
  type InstallationReceipt,
} from './contracts';
import { pathBinding, PathBindingReplay } from './directory-fingerprint';
import { analysisHash } from './identity';
import { inputStat } from './input-state';
import { AnalysisInputs } from './inputs';
import {
  type DomainOptions,
  readInstallationDomain,
} from './installation-domain';
import type { InstallationDomain } from './installation-environment';
import {
  locationInstallationRoot,
  packageLocation,
  projectLocations,
  resolvedLocations,
} from './installation-locations';
import { projectInstallationRoot } from './installation-owner';

type Header = AnalysisSnapshot['header'];
type Selection = Pick<InstallationReceipt, 'root' | 'configPath' | 'kind'>;
interface Lock {
  mtime: number;
  version: string;
  binding: string;
}

function regularLockMtime(file: string): number {
  const stat = inputStat(file);
  if (!stat?.isFile()) throw new AnalysisInputDriftError(file);
  return stat.mtimeMs;
}
function readLockBytes(file: string, mtime: number, binding: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw new AnalysisInputDriftError(file);
    throw error;
  }
  const current = new PathBindingReplay().run(() =>
    analysisHash(pathBinding(file)),
  );
  if (current !== binding || regularLockMtime(file) !== mtime)
    throw new AnalysisInputDriftError(file);
  return bytes;
}

export class InstallationLockGate {
  readonly #governance: Selection;
  readonly #inputs = new AnalysisInputs({}, emptyMetrics());
  readonly #locks = new Map<string, Lock>();
  readonly #resolved = new Set<string>();
  readonly #domains = new Map<string, InstallationDomain>();
  readonly #prior = new Map<string, InstallationReceipt>();
  readonly #used = new Set<string>();
  readonly #current = new Map<string, InstallationReceipt>();
  readonly #time: number | undefined;
  readonly #hashes = new Map<string, { hash: string; binding: string }>();
  readonly #record: (kind: string) => void;
  #isRestoring = false;
  #coldReason?: string;
  usable = true;
  needsCheckpoint = false;
  constructor(
    root: string,
    configPath: string,
    header: Header | undefined,
    record: (kind: string) => void,
  ) {
    this.#governance = { root, configPath, kind: 'project' };
    this.#time = header?.baselineTime;
    this.#record = record;
    const receipts = header?.installations ?? [];
    for (const receipt of receipts) {
      this.#prior.set(selectionKey(receipt), receipt);
      for (const [file, hash, binding] of receipt.locks)
        this.#hashes.set(file, { hash, binding });
    }
  }
  #domain(selection: Selection): InstallationDomain {
    const key = selectionKey(selection);
    const cached = this.#domains.get(key);
    if (cached !== undefined) return cached;
    const root = this.#root(selection);
    const domain = this.#inputs.memoizeObservation(
      JSON.stringify([root, selection.configPath]),
      () =>
        readInstallationDomain({
          root,
          configPath: selection.configPath,
          inputs: this.#inputs,
          readLocks: (locks, dependencies) => {
            for (const file of locks) {
              const lock = this.#lock(file);
              dependencies.push(
                this.#inputs.adoptBytes(file, lock.version, lock.mtime),
              );
            }
          },
        }),
    );
    const locks: InstallationReceipt['locks'] = domain.locks.map((file) => {
      const { version, binding } = this.#locks.get(file)!;
      return [file, version, binding];
    });
    const receipt: InstallationReceipt = {
      root: selection.root,
      configPath: selection.configPath,
      kind: selection.kind,
      ...(selection.kind === 'location' && {
        binding: this.#inputs.observe(selection.root, 'binding')
          .expectedVersion,
      }),
      installationRoot: domain.root,
      manager: domain.managerIdentity,
      lockRoot: domain.lockRoot,
      resolutionRoot: domain.resolutionRoot,
      locks,
    };
    this.#current.set(key, receipt);
    if (!this.#prior.has(key)) this.needsCheckpoint = true;
    this.#domains.set(key, domain);
    return domain;
  }
  #root(selection: Selection): string {
    if (selection.kind === 'location')
      return locationInstallationRoot(
        selection.root,
        this.#governance.root,
        this.#inputs,
      );
    return selection.kind === 'project' &&
      selection.configPath !== this.#governance.configPath
      ? projectInstallationRoot(
          this.#governance.root,
          selection.configPath,
          this.#inputs,
        )
      : selection.root;
  }
  #lock(file: string): Lock {
    if (this.#isRestoring && !this.#hashes.has(file))
      this.#rejectNewDomain(file);
    const cached = this.#locks.get(file);
    if (cached !== undefined) return cached;
    const mtime = regularLockMtime(file);
    const previous = this.#hashes.get(file);
    const binding = this.#inputs.observe(file, 'binding').expectedVersion;
    let lock: Lock;
    if (
      this.#time !== undefined &&
      mtime <= this.#time &&
      previous?.binding === binding
    ) {
      accessSync(file, constants.R_OK);
      lock = { mtime, binding, version: previous.hash };
      this.#record('lockHashReuses');
    } else {
      const bytes = readLockBytes(file, mtime, binding);
      lock = {
        mtime,
        binding,
        version: createHash('sha256').update(bytes).digest('hex'),
      };
      this.needsCheckpoint = true;
      this.#record('lockHashes');
    }
    this.#locks.set(file, lock);
    return lock;
  }
  #rejectNewDomain(file: string): never {
    this.#coldReason = file;
    throw new AnalysisInputDriftError(file);
  }
  #location(location: string, configPath: string, isUsed: boolean): void {
    const selection: Selection = {
      root: location,
      configPath,
      kind: 'location',
    };
    this.#domain(selection);
    if (isUsed) this.#used.add(selectionKey(selection));
  }
  #projectLocations(configPath: string, isUsed: boolean): void {
    const locations = this.#inputs.memoizeObservation(
      JSON.stringify(['project-locations', configPath]),
      () => projectLocations(this.#governance.root, configPath, this.#inputs),
    );
    for (const location of locations)
      this.#location(location, configPath, isUsed);
  }
  #unproven(error: unknown, path: string): void {
    if (error instanceof AnalysisInputDriftError) throw error;
    if (this.#isRestoring) this.#rejectNewDomain(path);
    this.usable = false;
  }
  get requiresCold(): boolean {
    return this.#coldReason !== undefined;
  }
  admit(isInMemory: boolean): boolean {
    this.project(this.#governance.configPath);
    for (const previous of this.#prior.values()) {
      try {
        this.#domain(previous);
        if (previous.kind === 'project')
          this.#projectLocations(previous.configPath, false);
      } catch (error) {
        if (error instanceof AnalysisInputDriftError) throw error;
        return false;
      }
    }
    return (
      this.usable &&
      (this.#time !== undefined || isInMemory) &&
      this.#current.size === this.#prior.size &&
      [...this.#current].every(([key, value]) =>
        isDeepStrictEqual(this.#prior.get(key), value),
      )
    );
  }
  resolved(file: string): void {
    if (this.#resolved.has(file)) return;
    this.#resolved.add(file);
    try {
      for (const location of resolvedLocations(file))
        this.#location(location, this.#governance.configPath, true);
    } catch (error) {
      this.#unproven(error, file);
    }
  }
  project(configPath: string): void {
    try {
      const selection = { ...this.#governance, configPath };
      this.#domain(selection);
      this.#used.add(selectionKey(selection));
      this.#projectLocations(configPath, true);
    } catch (error) {
      this.#unproven(error, configPath);
    }
  }
  observe(options: DomainOptions): InstallationDomain {
    let domain: InstallationDomain;
    try {
      const selection = {
        root: options.root,
        configPath: options.configPath,
        kind: 'environment' as const,
      };
      domain = this.#domain(selection);
      this.#used.add(selectionKey(selection));
    } catch (error) {
      this.#unproven(error, options.configPath);
      throw error;
    }
    for (const dependency of domain.dependencies)
      options.inputs.adoptObserved(dependency.inputId, this.#inputs);
    return domain;
  }
  seed(inputs: AnalysisInputs, isRestoring: boolean): void {
    this.#isRestoring = isRestoring;
    for (const id of Object.keys(this.#inputs.records))
      if (inputs.previous[id] !== undefined)
        inputs.adoptObserved(id, this.#inputs);
  }
  receipts(snapshot: AnalysisSnapshot): InstallationReceipt[] {
    const contexts = [
      ...Object.values(snapshot.contexts),
      ...Object.values(snapshot.vueContexts),
    ];
    const projects = new Set(
      Object.values(snapshot.resolvedConfigs).map(
        (record) => record.configPath,
      ),
    );
    const activeDomains = new Set(
      contexts.flatMap((context) =>
        context.environment.domains.map((domain) =>
          domainKey(context.project.configPath, domain),
        ),
      ),
    );
    const retainedLocations = new Set<string>();
    for (const input of Object.values(snapshot.inputs)) {
      if (input.kind !== 'binding') continue;
      retainedLocations.add(input.path);
      const packagePath = packageLocation(input.path);
      if (packagePath !== undefined) retainedLocations.add(packagePath);
    }
    return this.#current
      .entries()
      .filter(
        ([key, receipt]) =>
          this.#used.has(key) ||
          (receipt.kind === 'location'
            ? retainedLocations.has(receipt.root) ||
              projects.has(receipt.configPath)
            : receipt.kind === 'project'
              ? projects.has(receipt.configPath)
              : activeDomains.has(
                  domainKey(receipt.configPath, this.#domains.get(key)!),
                )),
      )
      .map(([, receipt]) => receipt)
      .toArray();
  }
  assertStable(): void {
    if (this.#coldReason !== undefined)
      throw new AnalysisInputDriftError(this.#coldReason);
    this.#inputs.assertStable();
  }
}
function selectionKey(value: Selection): string {
  return JSON.stringify([value.root, value.configPath, value.kind]);
}
function domainKey(configPath: string, domain: InstallationDomain): string {
  return JSON.stringify([
    configPath,
    domain.lockRoot,
    domain.resolutionRoot,
    domain.managerIdentity,
    domain.locks,
  ]);
}
