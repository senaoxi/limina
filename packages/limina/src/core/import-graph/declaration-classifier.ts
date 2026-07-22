import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';

export interface DeclarationClassifier {
  classify(filePath: string, programSourceFile?: ts.SourceFile): boolean;
}

export function createDeclarationClassifier(): DeclarationClassifier {
  const classificationByPath = new Map<string, boolean>();

  return {
    classify(filePath: string, programSourceFile?: ts.SourceFile): boolean {
      if (programSourceFile) {
        return programSourceFile.isDeclarationFile;
      }

      const normalizedFilePath = normalizeAbsolutePath(filePath);
      const cached = classificationByPath.get(normalizedFilePath);

      if (cached !== undefined) {
        return cached;
      }

      const isDeclarationFile = ts.createSourceFile(
        normalizedFilePath,
        '',
        ts.ScriptTarget.Latest,
        false,
      ).isDeclarationFile;

      classificationByPath.set(normalizedFilePath, isDeclarationFile);
      return isDeclarationFile;
    },
  };
}

const defaultDeclarationClassifier = createDeclarationClassifier();

export function isDeclarationFile(
  filePath: string,
  programSourceFile?: ts.SourceFile,
): boolean {
  return defaultDeclarationClassifier.classify(filePath, programSourceFile);
}
