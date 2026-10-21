import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ProjectReferenceRedirect } from '../dependency-semantics';
import type { TypeScriptSemanticProject } from './contracts';
import { NativeObservationError } from './native-observation-failure';
import {
  type NativePathReceipt,
  physicalTarget,
  selectNativePath,
} from './native-path-selection';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeProgramRequests } from './native-program-requests';
import { observeProjectReferenceRedirect } from './reference-redirect';

/** A load grant is rooted in real input or a compiler request from an admitted
 * source. Coverage alone never authorizes a speculative path fallback. */
export class NativeProgramLoads {
  readonly #grants = new Set<string>();
  readonly #candidates = new Set<string>();
  readonly #redirects = new Map<
    string,
    ProjectReferenceRedirect | undefined | null
  >();
  #revision = 0;
  readonly paths: Map<string, NativePathReceipt> = new Map();
  readonly project: TypeScriptSemanticProject;
  readonly compiler: typeof ts;
  readonly frontier: NativeProgramFrontier;

  constructor(
    project: TypeScriptSemanticProject,
    compiler: typeof ts,
    frontier: NativeProgramFrontier,
  ) {
    this.project = project;
    this.compiler = compiler;
    this.frontier = frontier;
    for (const root of project.fileNames)
      this.#grants.add(normalizeAbsolutePath(root));
    if (hasDefaultLibrary(project))
      this.grant(compiler.getDefaultLibFilePath(project.options));
  }

  private redirect(file: string): ProjectReferenceRedirect | undefined | null {
    if (!hasProjectReferences(this.project)) return undefined;
    const candidate = normalizeAbsolutePath(file);
    this.#candidates.add(candidate);
    return this.#redirects.has(candidate)
      ? this.#redirects.get(candidate)
      : null;
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
    const pending = [...this.#candidates].filter(
      (candidate) => !this.#redirects.has(candidate),
    );
    for (const candidate of pending)
      this.#redirects.set(candidate, this.observeRedirect(program, candidate));
    return pending.length > 0;
  }

  private observeRedirect(program: ts.Program, candidate: string) {
    try {
      return observeProjectReferenceRedirect(program, candidate, this.compiler);
    } catch (error) {
      if (isUnsupported(error)) return null;
      throw error;
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
    if (file === undefined || this.project.options.noResolve) return;
    const redirect = this.redirect(file);
    this.grantRedirect(file, redirect);
  }

  source(
    source: ts.SourceFile,
    host: ts.CompilerHost,
    requests: NativeProgramRequests,
  ): void {
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
function isUnsupported(error: unknown): boolean {
  return (
    error instanceof NativeObservationError && error.kind === 'unsupported'
  );
}
function isPathUnavailable(receipt: NativePathReceipt): boolean {
  return ['unavailable', 'disabled'].includes(receipt.selection.state);
}
function pathRedirects(receipt: NativePathReceipt): string[] {
  return receipt.redirect === undefined
    ? []
    : [receipt.redirect.referenceConfig];
}
