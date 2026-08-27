import {
  checkerToolchainDependencyContracts,
  LiminaDependencyError,
  liminaRuntimeDependencyContracts,
} from '../../dependency-contract';

export const svelte2tsxContract: typeof checkerToolchainDependencyContracts.svelte2tsx =
  checkerToolchainDependencyContracts.svelte2tsx;
export const typeScriptContract: typeof liminaRuntimeDependencyContracts.typescript =
  liminaRuntimeDependencyContracts.typescript;

export function createMissingCompilerError(packageRootDir: string): Error {
  return new Error(
    [
      'Unable to load the Svelte semantic toolchain:',
      '  package: svelte/compiler',
      `  leaf package root: ${packageRootDir}`,
      '  dependency category: analysis runtime',
      '  reason: the Svelte compiler is not installed in the source config leaf dependency scope.',
      `  fix: install svelte in ${packageRootDir}`,
    ].join('\n'),
  );
}

export function createMissingTypeScriptError(packageRootDir: string): Error {
  return new LiminaDependencyError({
    failureKind: 'missing',
    message: [
      'Unable to load the Svelte semantic toolchain:',
      '  package: typescript',
      `  leaf package root: ${packageRootDir}`,
      '  dependency category: checker toolchain',
      '  reason: TypeScript is not installed in the source config leaf dependency scope.',
      `  fix: install typescript@${typeScriptContract.supportedRange} alongside svelte-check in ${packageRootDir}`,
    ].join('\n'),
    ownership: 'checker-toolchain',
    packageName: 'typescript',
    scope: packageRootDir,
  });
}

export function createUnsupportedTypeScriptError(options: {
  packageRootDir: string;
  version: string | undefined;
}): Error {
  return new LiminaDependencyError({
    failureKind: 'unsupported',
    message: [
      'Unable to load the Svelte semantic toolchain:',
      '  package: typescript',
      `  leaf package root: ${options.packageRootDir}`,
      '  dependency category: checker toolchain',
      `  installed version: ${options.version ?? 'unknown'}`,
      `  supported range: ${typeScriptContract.supportedRange}`,
      `  fix: install typescript@${typeScriptContract.supportedRange} alongside svelte-check in ${options.packageRootDir}`,
    ].join('\n'),
    ownership: 'checker-toolchain',
    packageName: 'typescript',
    scope: options.packageRootDir,
    version: options.version,
  });
}

export function createMissingTransformError(packageRootDir: string): Error {
  return new LiminaDependencyError({
    failureKind: 'missing',
    message: [
      'Unable to load the Svelte semantic toolchain:',
      '  package: svelte2tsx',
      `  leaf package root: ${packageRootDir}`,
      '  dependency category: checker toolchain',
      '  reason: svelte2tsx is not installed in the source config leaf dependency scope.',
      `  fix: install svelte2tsx@${svelte2tsxContract.supportedRange} alongside svelte-check in ${packageRootDir}`,
    ].join('\n'),
    ownership: svelte2tsxContract.ownership,
    packageName: svelte2tsxContract.packageName,
    scope: packageRootDir,
  });
}

export function createUnsupportedTransformError(options: {
  packageRootDir: string;
  version: string | undefined;
}): Error {
  return new LiminaDependencyError({
    failureKind: 'unsupported',
    message: [
      'Unable to load the Svelte semantic toolchain:',
      '  package: svelte2tsx',
      `  leaf package root: ${options.packageRootDir}`,
      '  dependency category: checker toolchain',
      `  installed version: ${options.version ?? 'unknown'}`,
      `  supported range: ${svelte2tsxContract.supportedRange}`,
      `  fix: install svelte2tsx@${svelte2tsxContract.supportedRange} alongside svelte-check in ${options.packageRootDir}`,
    ].join('\n'),
    ownership: svelte2tsxContract.ownership,
    packageName: svelte2tsxContract.packageName,
    scope: options.packageRootDir,
    version: options.version,
  });
}
