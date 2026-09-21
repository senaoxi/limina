import type { AstroSemanticProject } from '#checkers';
import { isNativeTypeScriptProjectInput } from '#checkers';
import { getPlainSpecifierExtension } from '#utils/module-specifier';
import type { ImportRecord } from './records';
import { isKnownFrameworkVirtualSpecifier } from './virtual-modules';

export type SemanticEligibility =
  | { kind: 'eligible' }
  | { kind: 'not-applicable'; reason: string }
  | { kind: 'skip'; reason: string };

interface EligibilityOptions {
  checkerExtensions: readonly string[];
  importRecord: ImportRecord;
  oxcResolvedFilePath: string | null;
  project: AstroSemanticProject | undefined;
  specifier: string;
}

type EligibilityRule = (
  options: EligibilityOptions,
) => SemanticEligibility | null;

function isAstroSourceRecord(importRecord: ImportRecord): boolean {
  return (
    importRecord.filePath.toLowerCase().endsWith('.astro') &&
    (importRecord.domain === 'astro-frontmatter' ||
      importRecord.domain === 'astro-client-script')
  );
}

function isKnownSourcePath(
  filePath: string,
  checkerExtensions: readonly string[],
): boolean {
  const normalized = filePath.toLowerCase();
  return (
    isNativeTypeScriptProjectInput(normalized) ||
    ['.astro', '.json', '.svelte', '.vue', ...checkerExtensions].some(
      (extension) => normalized.endsWith(extension.toLowerCase()),
    )
  );
}

// A query or fragment is not evaluated here. The complete specifier reaches
// the Astro checker, which alone decides what it means.
function hasExplicitNonSourceExtension(
  specifier: string,
  checkerExtensions: readonly string[],
): boolean {
  return (
    getPlainSpecifierExtension(specifier) !== null &&
    !isKnownSourcePath(specifier, checkerExtensions)
  );
}

const eligibilityRules: readonly EligibilityRule[] = [
  (options) => {
    if (options.project !== undefined) return null;
    return {
      kind: 'not-applicable',
      reason: 'No Astro semantic seed belongs to this project context.',
    };
  },
  (options) => {
    if (isAstroSourceRecord(options.importRecord)) return null;
    return {
      kind: 'not-applicable',
      reason: 'The ImportRecord is not owned by an Astro source domain.',
    };
  },
  (options) => {
    if (!isKnownFrameworkVirtualSpecifier(options.specifier)) return null;
    return {
      kind: 'skip',
      reason: 'Known framework virtual imports are not semantic candidates.',
    };
  },
  (options) => {
    if (
      !hasExplicitNonSourceExtension(
        options.specifier,
        options.checkerExtensions,
      )
    ) {
      return null;
    }
    return {
      kind: 'skip',
      reason: 'The specifier has an explicit non-source extension.',
    };
  },
  (options) => {
    if (options.oxcResolvedFilePath === null) return null;
    if (
      isKnownSourcePath(options.oxcResolvedFilePath, options.checkerExtensions)
    ) {
      return null;
    }
    return {
      kind: 'skip',
      reason: 'Cheap Oxc/filesystem evidence identifies a resource target.',
    };
  },
];

export function classifyAstroSemanticEligibility(
  options: EligibilityOptions,
): SemanticEligibility {
  for (const rule of eligibilityRules) {
    const result = rule(options);
    if (result !== null) return result;
  }
  return { kind: 'eligible' };
}
