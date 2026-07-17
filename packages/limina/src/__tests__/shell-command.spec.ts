import { describe, expect, it } from 'vitest';
import {
  formatShellCommand,
  quoteShellCommandToken,
} from '../check-reporting/shell-command';

describe('shell command formatting', () => {
  it.each([
    ['$HOME', "'$HOME'"],
    ['`whoami`', "'`whoami`'"],
    ['$(whoami)', "'$(whoami)'"],
    ['double"quote', `'double"quote'`],
    ['two words', "'two words'"],
    ['path\\with\\slashes', "'path\\with\\slashes'"],
    ["single'quote", `'single'"'"'quote'`],
  ])('quotes the POSIX token %s', (value, expected) => {
    expect(quoteShellCommandToken(value, 'posix')).toBe(expected);
  });

  it.each([
    ['$HOME', "'$HOME'"],
    ['`whoami`', "'`whoami`'"],
    ['$(whoami)', "'$(whoami)'"],
    ['double"quote', `'double"quote'`],
    ['two words', "'two words'"],
    ['path\\with\\slashes', "'path\\with\\slashes'"],
    ["single'quote", "'single''quote'"],
  ])('quotes the PowerShell token %s', (value, expected) => {
    expect(quoteShellCommandToken(value, 'powershell')).toBe(expected);
  });

  it('leaves stable tokens readable while quoting user-controlled values', () => {
    expect(
      formatShellCommand(
        ['limina', 'check', '--issues', '--scope', 'packages/$(whoami)/**'],
        'posix',
      ),
    ).toBe("limina check --issues --scope 'packages/$(whoami)/**'");
  });
});
