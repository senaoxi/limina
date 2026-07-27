import { normalizeAbsolutePathIdentity } from '#utils/path';
import path from 'pathe';
import ts from 'typescript';
import type {
  WorkspaceExportSelfNameContext,
  WorkspaceExportSelfNameEntry,
} from './profile-types';

type FailureReason = NonNullable<
  WorkspaceExportSelfNameContext['failureReason']
>;

interface ValidationContext {
  containingFile: string;
  entry: WorkspaceExportSelfNameEntry;
  expectedSpecifier: string;
}

type EntryValidator = (context: ValidationContext) => FailureReason | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null) {
    return false;
  }

  if (typeof value !== 'object') {
    return false;
  }

  return !Array.isArray(value);
}

function createFailure(
  containingFile: string,
  failureReason: FailureReason,
): WorkspaceExportSelfNameContext {
  return { containingFile, eligible: false, failureReason };
}

function getExpectedSpecifier(entry: WorkspaceExportSelfNameEntry): string {
  return entry.subpath === '.'
    ? entry.packageName
    : `${entry.packageName}/${entry.subpath.slice('./'.length)}`;
}

const validateNamedPackage: EntryValidator = ({ entry }) =>
  entry.isNamedWorkspacePackage ? null : 'not-a-named-workspace-package';

const validateExplicitExports: EntryValidator = ({ entry }) =>
  entry.hasExplicitExports ? null : 'missing-exports';

const validateContainingFile: EntryValidator = ({ containingFile, entry }) =>
  containingFile === normalizeAbsolutePathIdentity(entry.packageJsonPath)
    ? null
    : 'containing-file-mismatch';

const validateSpecifier: EntryValidator = ({ entry, expectedSpecifier }) =>
  entry.specifier === expectedSpecifier ? null : 'specifier-is-not-self-name';

const entryValidators: readonly EntryValidator[] = [
  validateNamedPackage,
  validateExplicitExports,
  validateContainingFile,
  validateSpecifier,
];

function findEntryFailure(context: ValidationContext): FailureReason | null {
  for (const validate of entryValidators) {
    const failure = validate(context);

    if (failure !== null) {
      return failure;
    }
  }

  return null;
}

function parseManifest(source: string | undefined): unknown {
  return source === undefined ? null : JSON.parse(source);
}

function manifestMatchesPackage(
  manifest: unknown,
  packageName: string,
): manifest is Record<string, unknown> {
  return isRecord(manifest) && manifest.name === packageName;
}

function validateManifest(
  manifest: unknown,
  packageName: string,
): FailureReason | null {
  if (!manifestMatchesPackage(manifest, packageName)) {
    return 'package-scope-unavailable';
  }

  return Object.hasOwn(manifest, 'exports') ? null : 'missing-exports';
}

function getPackageScopeFailure(options: {
  containingFile: string;
  packageName: string;
  system: Pick<ts.System, 'fileExists' | 'readFile'>;
}): FailureReason | null {
  try {
    if (!options.system.fileExists(options.containingFile)) {
      return 'package-scope-unavailable';
    }

    return validateManifest(
      parseManifest(options.system.readFile(options.containingFile)),
      options.packageName,
    );
  } catch {
    return 'package-scope-unavailable';
  }
}

function resolveSystem(
  system: Pick<ts.System, 'fileExists' | 'readFile'> | undefined,
): Pick<ts.System, 'fileExists' | 'readFile'> {
  return system === undefined ? ts.sys : system;
}

export function getWorkspaceExportSelfNameContext(options: {
  readonly entry: WorkspaceExportSelfNameEntry;
  readonly system?: Pick<ts.System, 'fileExists' | 'readFile'>;
}): WorkspaceExportSelfNameContext {
  const containingFile = normalizeAbsolutePathIdentity(
    path.join(options.entry.packageDirectory, 'package.json'),
  );
  const entryFailure = findEntryFailure({
    containingFile,
    entry: options.entry,
    expectedSpecifier: getExpectedSpecifier(options.entry),
  });

  if (entryFailure !== null) {
    return createFailure(containingFile, entryFailure);
  }

  const scopeFailure = getPackageScopeFailure({
    containingFile,
    packageName: options.entry.packageName,
    system: resolveSystem(options.system),
  });

  return scopeFailure === null
    ? { containingFile, eligible: true, failureReason: null }
    : createFailure(containingFile, scopeFailure);
}
