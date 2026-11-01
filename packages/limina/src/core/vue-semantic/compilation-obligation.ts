import type { CompilationObligationProof } from '../dependency-semantics';
import { frameworkCompilationObligation } from '../framework-semantic/compilation-obligation';
import type { FrameworkCompilerRequest } from '../framework-semantic/compiler-requests';
import type { VueSemanticContext } from './context';
import { getVueServiceScript } from './dependency';

export function vueCompilationObligation(
  context: VueSemanticContext,
  requests: readonly FrameworkCompilerRequest[],
): CompilationObligationProof {
  return frameworkCompilationObligation(
    {
      program: context.program,
      tsModule: context.tsModule,
      compilerRequests: context.compilerRequests,
      configPath: context.identity.configPath,
      getService: (fileName) =>
        getVueServiceScript({ context, fileName })?.serviceScript,
    },
    requests,
  );
}
