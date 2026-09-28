import { LIMINA_CHECK_ISSUE_CODES } from '../../../check-reporting/codes';
import { createReleaseFinding } from '../findings/evidence';
import type {
  ReleaseContentHashFacts,
  ReleasePackedManifestFacts,
  ReleaseRegistryFacts,
  ReleaseTarballHygieneFacts,
} from '../findings/facts';
import type {
  ReleaseFindingPresentation,
  ReleaseFindingSection,
} from '../findings/types';
import type {
  PackageDependencySectionName,
  ReleaseConsistencyState,
} from './types';

function formatOptionalPart(
  value: string | undefined,
  formatter: (entry: string) => string,
): string {
  if (value === undefined) return '';
  return formatter(value);
}

export function formatDependencyLocation(options: {
  dependencyName?: string;
  importerName: string;
  sectionName?: PackageDependencySectionName;
  specifier?: string;
}): string {
  return [
    options.importerName,
    formatOptionalPart(options.dependencyName, (value) => ` -> ${value}`),
    formatOptionalPart(options.sectionName, (value) => ` [${value}]`),
    formatOptionalPart(options.specifier, (value) => ` (${value})`),
  ].join('');
}

function createReleaseFindingPresentation(options: {
  message: string;
  section: ReleaseFindingSection;
  sectionTitle: string;
  title?: string;
}): ReleaseFindingPresentation {
  const problemLines = options.message.split('\n');
  const summary = problemLines[0] ?? options.sectionTitle;
  const title = options.title ?? options.sectionTitle.replace(/:$/u, '');
  return {
    problemLines,
    section: options.section,
    sectionTitle: options.sectionTitle,
    summary,
    title,
  };
}

export function addPackedManifestFinding(
  state: ReleaseConsistencyState,
  options: {
    external?: { code?: string; message?: string; tool?: string };
    facts: ReleasePackedManifestFacts;
    filePath?: string;
    message: string;
    packageManifestPath: string;
    packageName: string;
    section: ReleaseFindingSection;
    sectionTitle: string;
  },
): void {
  state.findings.push(
    createReleaseFinding({
      code: LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
      external: options.external,
      facts: options.facts,
      filePath: options.filePath,
      packageManifestPath: options.packageManifestPath,
      packageName: options.packageName,
      presentation: createReleaseFindingPresentation(options),
    }),
  );
}

export function addTarballHygieneFinding(
  state: ReleaseConsistencyState,
  options: {
    facts: ReleaseTarballHygieneFacts;
    filePath?: string;
    message: string;
    packageManifestPath: string;
    packageName: string;
  },
): void {
  state.findings.push(
    createReleaseFinding({
      code: LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
      facts: options.facts,
      filePath: options.filePath,
      packageManifestPath: options.packageManifestPath,
      packageName: options.packageName,
      presentation: createReleaseFindingPresentation({
        message: options.message,
        section: 'tarball',
        sectionTitle: 'Release tarball is not publishable:',
      }),
    }),
  );
}

export function addRegistryFinding(
  state: ReleaseConsistencyState,
  options: {
    facts: ReleaseRegistryFacts;
    filePath?: string;
    message: string;
    packageManifestPath: string;
    packageName: string;
  },
): void {
  state.findings.push(
    createReleaseFinding({
      code: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
      facts: options.facts,
      filePath: options.filePath,
      packageManifestPath: options.packageManifestPath,
      packageName: options.packageName,
      presentation: createReleaseFindingPresentation({
        message: options.message,
        section: 'registry-content',
        sectionTitle: 'Workspace package registry/content checks failed:',
      }),
    }),
  );
}

export function addContentHashFinding(
  state: ReleaseConsistencyState,
  options: {
    facts: ReleaseContentHashFacts;
    filePath?: string;
    message: string;
    packageManifestPath: string;
    packageName: string;
  },
): void {
  state.findings.push(
    createReleaseFinding({
      code: LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
      facts: options.facts,
      filePath: options.filePath,
      packageManifestPath: options.packageManifestPath,
      packageName: options.packageName,
      presentation: createReleaseFindingPresentation({
        message: options.message,
        section: 'registry-content',
        sectionTitle: 'Workspace package registry/content checks failed:',
      }),
    }),
  );
}
