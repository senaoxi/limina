import ts from 'typescript';

/**
Version-bound structural APIs; the Native collector admits TypeScript 6.0.3.
*/
export interface FileModuleContext {
  mode: ts.ResolutionMode;
  packageType?: string;
}

interface FormatResult {
  impliedNodeFormat: ts.ResolutionMode;
  packageJsonScope?: { contents: { packageJsonContent: { type?: string } } };
}

interface NativeRequestApi {
  getImpliedNodeFormatForFileWorker(
    file: string,
    cache: undefined,
    host: ts.ModuleResolutionHost,
    options: ts.CompilerOptions,
  ): ts.ResolutionMode | FormatResult;
  getLibraryNameFromLibFileName(file: string): string;
  getSetExternalModuleIndicator(
    options: ts.CompilerOptions,
  ): (file: ts.SourceFile) => void;
}

export const nativeRequestApi = ts as unknown as NativeRequestApi;

export function observeFileModuleContext(
  file: string,
  options: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
): FileModuleContext {
  const value = nativeRequestApi.getImpliedNodeFormatForFileWorker(
    file,
    undefined,
    host,
    options,
  );
  return typeof value === 'object'
    ? {
        mode: value.impliedNodeFormat,
        packageType: value.packageJsonScope?.contents.packageJsonContent.type,
      }
    : { mode: value };
}

export function bindFileModuleContext(
  file: ts.SourceFile,
  context: FileModuleContext,
): void {
  file.impliedNodeFormat = context.mode;
  if (context.packageType !== undefined)
    (
      file as ts.SourceFile & Pick<FormatResult, 'packageJsonScope'>
    ).packageJsonScope = {
      contents: { packageJsonContent: { type: context.packageType } },
    };
}
