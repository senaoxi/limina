import type {
  checkPackage,
  createPackageFromTarballData,
} from '@arethetypeswrong/core';
import type { publint } from 'publint';
import type { formatMessage } from 'publint/utils';
import { createMissingPeerDependencyError } from './issue';

function isModuleNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND';
}

function isPackageAbsent(packageName: string): boolean {
  try {
    // Resolve metadata from the same ESM origin and conditions as the import.
    // Hidden metadata is still evidence that the package itself was found.
    import.meta.resolve(`${packageName}/package.json`);
    return false;
  } catch (error) {
    return isModuleNotFound(error);
  }
}

export async function loadPublintPeer(): Promise<{
  formatMessage: typeof formatMessage;
  publint: typeof publint;
}> {
  try {
    const [publintModule, publintUtilsModule] = await Promise.all([
      import('publint'),
      import('publint/utils'),
    ]);
    return {
      formatMessage: publintUtilsModule.formatMessage,
      publint: publintModule.publint,
    };
  } catch (error) {
    if (!isPackageAbsent('publint')) throw error;
    throw createMissingPeerDependencyError({
      command: 'package check',
      error,
      packageName: 'publint',
    });
  }
}

export async function loadAttwPeer(): Promise<{
  checkPackage: typeof checkPackage;
  createPackageFromTarballData: typeof createPackageFromTarballData;
}> {
  try {
    const attwModule = await import('@arethetypeswrong/core');
    return {
      checkPackage: attwModule.checkPackage,
      createPackageFromTarballData: attwModule.createPackageFromTarballData,
    };
  } catch (error) {
    if (!isPackageAbsent('@arethetypeswrong/core')) throw error;
    throw createMissingPeerDependencyError({
      command: 'package check',
      error,
      packageName: '@arethetypeswrong/core',
      toolName: 'attw',
    });
  }
}
