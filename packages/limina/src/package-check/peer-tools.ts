import type {
  checkPackage,
  createPackageFromTarballData,
} from '@arethetypeswrong/core';
import type { publint } from 'publint';
import type { formatMessage } from 'publint/utils';
import { createMissingPeerDependencyError } from './issue';

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
    throw createMissingPeerDependencyError({
      command: 'package check',
      error,
      packageName: '@arethetypeswrong/core',
      toolName: 'attw',
    });
  }
}
