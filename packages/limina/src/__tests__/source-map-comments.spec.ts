import { describe, expect, it } from 'vitest';
import { hasSourceMappingUrlDirective } from '../package-check/release/source-map-comments';

const line = '//# sourceMappingURL=real.map';
const block = '/*# sourceMappingURL=real.map */';

describe('source map directives in parser comment ranges', () => {
  it.each([
    line,
    block,
    `export const x = 1;\n${line}`,
    ['export const x = `prefix${1}`;', line].join('\n'),
    ['const tag = (s) => s; tag`prefix${1}`;', block].join('\n'),
    ['const x = `outer${`inner${1}`}tail`;', line].join('\n'),
    ['const x = `prefix${1 ', block, '}`;'].join(''),
    ['const x = `prefix${1 + (', line, '2)}`;'].join('\n'),
    ['const x = /[/*]/;', line].join('\n'),
    ['if (true) /[/*]/.test("x");', block].join('\n'),
    ['function f() { return 1;', line, '}'].join('\n'),
  ])('finds a real directive in %s', (source) => {
    expect(hasSourceMappingUrlDirective(source, 'output.mjs')).toBe(true);
  });

  it.each([
    'export const x = 1;',
    'const x = "//# sourceMappingURL=fake.map";',
    'const x = `prefix${1}\n//# sourceMappingURL=fake.map\n`;',
    'const x = `outer${`inner${1}\n//# sourceMappingURL=fake.map\n`}tail`;',
    'const x = /[/*]# sourceMappingURL=fake.map/;',
    'const x = /\\/\\/# sourceMappingURL=fake.map/;',
    '// example: //# sourceMappingURL=fake.map',
    '/* an example\n//# sourceMappingURL=fake.map\n*/',
  ])('does not promote literal or ordinary comment text in %s', (source) => {
    expect(hasSourceMappingUrlDirective(source, 'output.cjs')).toBe(false);
  });

  it.each(['const = ;', 'const x = `unterminated${1}', '/* unterminated'])(
    'fails explicitly when parsing is unreliable: %s',
    (source) => {
      expect(() => hasSourceMappingUrlDirective(source, 'broken.js')).toThrow(
        'broken.js: JavaScript parsing failed',
      );
    },
  );
});
