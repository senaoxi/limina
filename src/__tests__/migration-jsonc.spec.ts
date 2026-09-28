import { describe, expect, it } from 'vitest';
import {
  assertMigrationTextMatchesPlan,
  assertUnambiguousMigrationText,
} from '../commands/migration/jsonc-validation';

describe('migration JSONC plan validation', () => {
  it.each([
    '{"liminaOptions":{},"liminaOptions":{}}',
    '{"references":[],"references":[]}',
    '{"compilerOptions":{"noEmit":false,"noEmit":true}}',
    '{"compilerOptions":{"declarationDir":"old","declarationDir":"new"}}',
  ])('rejects ambiguous governed fields: %s', (content) => {
    expect(() => assertUnambiguousMigrationText(content)).toThrow(
      'duplicate key',
    );
  });
  it('rejects malformed candidate text', () => {
    expect(() => assertMigrationTextMatchesPlan('{"a":', {})).toThrow(
      'complete object',
    );
  });
  it('rejects valid candidate text with the wrong effective object', () => {
    expect(() =>
      assertMigrationTextMatchesPlan('{"compilerOptions":{"noEmit":true}}', {}),
    ).toThrow('planned effective object');
  });
  it('accepts BOM, comments and trailing commas', () => {
    const content = '\uFEFF{ // comment\n "files": [], }';
    expect(() => assertUnambiguousMigrationText(content)).not.toThrow();
    expect(() =>
      assertMigrationTextMatchesPlan(content, { files: [] }),
    ).not.toThrow();
  });
});
