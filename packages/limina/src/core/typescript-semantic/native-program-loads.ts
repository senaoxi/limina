import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import type ts from 'typescript';
import type { ProjectReferenceRedirect } from '../dependency-semantics';
import type { TypeScriptSemanticProject } from './contracts';
import { nativeFingerprint } from './native-file-identity';
import type { NativeHostFailures } from './native-host-failures';
import { nativeLibraryFileName } from './native-library-api';
import {
  nativeFailure,
  nativeObservationFailureKind,
  observationErrorDetail,
} from './native-observation-failure';
import {
  type NativePathReceipt,
  physicalTarget,
  selectNativePath,
} from './native-path-selection';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeProgramRequests } from './native-program-requests';
import {
  type NativeReferenceObservation,
  observeNativeReference,
} from './reference-redirect';

/** A load grant is rooted in real input or a compiler request from an admitted
 * source. Coverage alone never authorizes a speculative path fallback. */
export class NativeProgramLoads {
  readonly #grants = new Set<string>();
  readonly #candidates = new Set<string>();
  readonly #redirects = new Map<string, NativeReferenceObservation>();
  #revision = 0;
  readonly paths: Map<string, NativePathReceipt> = new Map();
  readonly project: TypeScriptSemanticProject;
  readonly compiler: typeof ts;
  readonly frontier: NativeProgramFrontier;
  readonly failures: NativeHostFailures;

  constructor(input: {
    project: TypeScriptSemanticProject;
    compiler: typeof ts;
    frontier: NativeProgramFrontier;
    failures: NativeHostFailures;
  }) {
    const { project, compiler, frontier, failures } = input;
    this.project = project;
    this.compiler = compiler;
    this.frontier = frontier;
    this.failures = failures;
    for (const root of project.fileNames)
      this.#grants.add(normalizeAbsolutePath(root));
    if (hasDefaultLibrary(project))
      this.grant(compiler.getDefaultLibFilePath(project.options));
  }

  private redirect(file: string): ProjectReferenceRedirect | undefined | null {
    if (!hasProjectReferences(this.project)) return undefined;
    const candidate = normalizeAbsolutePath(file);
    this.#candidates.add(candidate);
    const observation = this.#redirects.get(candidate);
    return selectionRedirect(observation);
  }

  private hasLateGrant(program: ts.Program, previousRevision: number): boolean {
    return (
      this.#revision !== previousRevision &&
      [...this.#grants].some(
        (file) => program.getSourceFile(file) === undefined,
      )
    );
  }
  private completeRedirects(program: ts.Program): boolean {
    let hasChange = false;
    // Rebind to the current pass, including already known candidates. The map
    // used to grant a load must agree with the Program we eventually publish.
    for (const candidate of this.#candidates) {
      const previous = this.#redirects.get(candidate);
      const current = this.observeRedirect(program, candidate);
      if (hasChangedReference(previous, current)) hasChange = true;
      this.#redirects.set(candidate, current);
    }
    return hasChange;
  }

  private observeRedirect(
    program: ts.Program,
    candidate: string,
  ): NativeReferenceObservation {
    try {
      return observeNativeReference(program, candidate, this.compiler);
    } catch (error) {
      const failure = nativeFailure({
        contextId: this.failures.contextId,
        kind: nativeObservationFailureKind(error),
        detail: observationErrorDetail(error),
      });
      if (this.failures.failures.every((prior) => prior.id !== failure.id))
        this.failures.failures.push(failure);
      return { state: 'unavailable', reason: 'reference-map-execution-failed' };
    }
  }

  private grantRedirect(
    file: string,
    redirect: ProjectReferenceRedirect | undefined | null,
  ): void {
    if (redirect !== null) this.grant(physicalTarget(file, redirect));
  }

  private canGrant(target: string): boolean {
    return (
      this.frontier.inspect(target).decision.action === 'expand' &&
      !this.#grants.has(target)
    );
  }

  get references(): ReadonlyMap<string, NativeReferenceObservation> {
    return this.#redirects;
  }

  /** Final inventory also includes requests that never invoked a resolver
   * callback. Observe their targets before freezing, without load authority. */
  observeTargets(program: ts.Program, targets: readonly string[]): void {
    for (const target of targets) {
      const candidate = normalizeAbsolutePath(target);
      if (!this.#redirects.has(candidate))
        this.#redirects.set(
          candidate,
          this.observeRedirect(program, candidate),
        );
    }
  }
  get revision(): number {
    return this.#revision;
  }

  allow(file: string): boolean {
    return (
      this.frontier.allow(file) && this.#grants.has(normalizeAbsolutePath(file))
    );
  }

  grant(file: string | undefined): void {
    if (file === undefined) return;
    const target = normalizeAbsolutePath(file);
    if (!this.canGrant(target)) return;
    this.#grants.add(target);
    this.#revision++;
  }

  resolved(file: string | undefined): void {
    if (file === undefined) return;
    const redirect = this.redirect(file);
    this.grantRedirect(file, redirect);
  }

  source(
    source: ts.SourceFile,
    host: ts.CompilerHost,
    requests: NativeProgramRequests,
  ): void {
    // TS 6 skips resolveLibrary when libReplacement is disabled. These
    // compiler-inventoried directives use the compiler's fixed default-lib
    // location; grant them before loading instead of rebuilding once per layer.
    if (
      /^6\.0\./.test(this.compiler.version) &&
      this.project.options.libReplacement !== true &&
      !this.project.options.noLib
    ) {
      for (const reference of source.libReferenceDirectives) {
        const name = nativeLibraryFileName(this.compiler, reference);
        if (name === undefined) continue;
        const target = path.join(
          path.dirname(
            this.compiler.getDefaultLibFilePath(this.project.options),
          ),
          name,
        );
        requests.record({
          source,
          position: reference.pos,
          channel: 'library',
          name: reference.fileName,
          target,
        });
        this.grant(target);
      }
    }
    for (const reference of source.referencedFiles) {
      const receipt = selectNativePath({
        compiler: this.compiler,
        host,
        options: this.project.options,
        source,
        reference,
        redirect: (candidate) => this.redirect(candidate),
      });
      const requestId = requests.record({
        source,
        position: reference.pos,
        channel: 'path-directive',
        name: reference.fileName,
        target: receipt.target,
        unavailable: isPathUnavailable(receipt),
        pathSelection: receipt.selection,
        redirects: pathRedirects(receipt),
      });
      this.paths.set(requestId, receipt);
      this.grant(receipt.target);
    }
  }

  finishPass(program: ts.Program, previousRevision: number): boolean {
    const hasMapChange = this.completeRedirects(program);
    this.frontier.identities.assertStable();
    return hasMapChange || this.hasLateGrant(program, previousRevision);
  }
}

function hasDefaultLibrary(project: TypeScriptSemanticProject): boolean {
  return [
    project.fileNames.length > 0,
    !project.options.noLib,
    !project.options.lib,
  ].every(Boolean);
}
function hasProjectReferences(project: TypeScriptSemanticProject): boolean {
  return (project.projectReferences?.length ?? 0) > 0;
}
function isPathUnavailable(receipt: NativePathReceipt): boolean {
  return ['unavailable', 'disabled'].includes(receipt.selection.state);
}
function pathRedirects(receipt: NativePathReceipt): string[] {
  return receipt.redirect === undefined
    ? []
    : [receipt.redirect.referenceConfig];
}

function selectionRedirect(
  observation: NativeReferenceObservation | undefined,
): ProjectReferenceRedirect | undefined | null {
  return observation?.state === 'observed' ? observation.redirect : null;
}
function hasChangedReference(
  previous: NativeReferenceObservation | undefined,
  current: NativeReferenceObservation,
): boolean {
  return (
    previous === undefined ||
    nativeFingerprint(previous) !== nativeFingerprint(current)
  );
}
