import { RuleTester } from 'eslint';
import { portablePathComparison } from '../rules/portable-path-comparison-rule';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('portable-path-comparison valid cases', portablePathComparison, {
  valid: [
    {
      code: `
        import path from 'node:path';
        expect(existsSync(path.join(rootDir, 'package.json'))).toBe(true);
      `,
    },
    {
      code: `
        import path from 'node:path';
        expect(result.rootDir).toBe(
          toPortablePath(path.join(rootDir, 'packages/a')),
        );
      `,
    },
    {
      code: `
        import path from 'node:path';
        expect(result.rootDir).toBe(path.posix.join(rootDir, 'packages/a'));
      `,
    },
    {
      code: `
        import path from 'node:path';
        const matches =
          config.rootDir ===
          normalizeAbsolutePath(path.join(rootDir, 'tools'));
      `,
    },
    {
      code: `
        expect(result.rootDir).toBe(fixture.path('packages/a'));
      `,
    },
    {
      code: `
        await expect(run({ rootDir: fixture.rootDir })).resolves.toBeDefined();
      `,
    },
  ],
  invalid: [],
});

ruleTester.run(
  'portable-path-comparison invalid cases',
  portablePathComparison,
  {
    valid: [],
    invalid: [
      {
        code: `
          import path from 'node:path';
          expect(result.rootDir).toBe(path.join(rootDir, 'packages/a'));
        `,
        errors: [{ messageId: 'canonicalizePath' }],
      },
      {
        code: `
          import path from 'node:path';
          expect(result).toEqual(
            expect.objectContaining({
              rootDir: path.join(rootDir, 'packages/a'),
            }),
          );
        `,
        errors: [{ messageId: 'canonicalizePath' }],
      },
      {
        code: `
          import path from 'node:path';
          const matches = config.rootDir === path.join(rootDir, 'tools');
        `,
        errors: [{ messageId: 'canonicalizePath' }],
      },
      {
        code: `
          import { join as joinPath } from 'node:path';
          expect(joinPath(rootDir, 'packages/a')).toBe(result.rootDir);
        `,
        errors: [{ messageId: 'canonicalizePath' }],
      },
      {
        code: `
          import path from 'node:path';
          expect(result.rootDir).toBe(
            path.win32.join('C:\\\\repo', 'packages', 'a'),
          );
        `,
        errors: [{ messageId: 'canonicalizePath' }],
      },
      {
        code: `
          expect(result).toEqual({ rootDir: fixture.rootDir });
        `,
        errors: [{ messageId: 'canonicalizePath' }],
      },
      {
        code: `
          const matches = result.rootDir === fixture.rootDir;
        `,
        errors: [{ messageId: 'canonicalizePath' }],
      },
    ],
  },
);
