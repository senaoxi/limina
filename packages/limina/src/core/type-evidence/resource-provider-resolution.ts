import type { ImportResolutionEvidence } from '../import-analysis/evidence';
import {
  resolveTypeScriptProviderEvidence,
  resolveVueProviderEvidence,
} from './provider-resolution';
import {
  createUnsupportedCheckerEvidence,
  resolveTypeScriptPreset,
  resolveVuePreset,
} from './resolution';
import type { WorkspaceBoundedImportEvidenceOptions } from './types';

export function resolveResourceProviderEvidence(options: {
  request: WorkspaceBoundedImportEvidenceOptions;
  runtimeEvidence: Parameters<
    typeof resolveTypeScriptProviderEvidence
  >[0]['input']['runtimeEvidence'];
  nativeContext: Parameters<
    typeof resolveTypeScriptProviderEvidence
  >[0]['context'];
  vueContext: Parameters<typeof resolveVueProviderEvidence>[0]['context'];
}): ImportResolutionEvidence {
  const vuePreset = resolveVuePreset(options.request.project.checkerPresets);
  if (vuePreset !== null)
    return resolveVueProviderEvidence({
      context: options.vueContext,
      input: {
        options: options.request,
        preset: vuePreset,
        runtimeEvidence: options.runtimeEvidence,
      },
    });
  return resolveNativeResource(options);
}
function resolveNativeResource(
  options: Parameters<typeof resolveResourceProviderEvidence>[0],
): ImportResolutionEvidence {
  const preset = resolveTypeScriptPreset(
    options.request.project.checkerPresets,
  );
  return preset === null
    ? {
        ...options.runtimeEvidence,
        type: createUnsupportedCheckerEvidence({
          checkerName: options.request.checkerName,
          reason:
            'This checker does not expose a supported resource type-evidence provider.',
        }),
      }
    : resolveTypeScriptProviderEvidence({
        context: options.nativeContext,
        input: {
          options: options.request,
          preset,
          runtimeEvidence: options.runtimeEvidence,
        },
      });
}
