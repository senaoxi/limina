import { createLiminaTsconfigSchemaPath } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import { createRelativePath } from './generated/paths';

export function createCheckerBuildConfig(options: {
  checkerName: string;
  entryPath: string;
  references: string[];
  rootDir: string;
}): Record<string, unknown> {
  return {
    $schema: createLiminaTsconfigSchemaPath(options.rootDir, options.entryPath),
    files: [],
    references: options.references
      .sort(compareCodeUnits)
      .map((referencePath) => ({
        path: createRelativePath(options.entryPath, referencePath),
      })),
    liminaOptions: { generated: true, checker: options.checkerName },
  };
}
