import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateInstallationLock } from '../core/analysis-cache/installation-locks';
import { createFixturePathResolver } from './helpers/path';

const file = createFixturePathResolver(
  path.join(tmpdir(), 'limina-installation-lock'),
);
const environment = `lockfileVersion: '9.0'
importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm: {specifier: 12.10.1, version: 12.10.1}
`;
const project = `lockfileVersion: '9.0'
importers:
  .: {}
  packages/member: {}
`;
const combined = `---\n${environment}---\n${project}`;

function validate(text: string, member = 'packages/member'): void {
  validateInstallationLock({
    manager: 'pnpm',
    file: file('pnpm-lock.yaml'),
    bytes: Buffer.from(text),
    roots: { lockRoot: file(), resolutionRoot: file(member) },
  });
}

describe('pnpm project lock coverage', () => {
  it.each([
    ['single version 6', project.replace("'9.0'", '6')],
    ['single version 9', project],
    ['environment followed by project', combined],
    ['BOM and CRLF', `\u{FEFF}${combined.replaceAll('\n', '\r\n')}`],
  ])('accepts a covered workspace member in %s', (_name, text) => {
    expect(() => validate(text)).not.toThrow();
    expect(() => validate(text, '.')).not.toThrow();
  });

  it('does not obtain project coverage from the environment document', () => {
    const uncovered = `---\n${environment}---\nlockfileVersion: 9\nimporters:\n  packages/member: {}\n`;
    expect(() => validate(uncovered, '.')).toThrow(
      'Lock does not cover resolution root',
    );
    expect(() => validate(uncovered)).not.toThrow();
  });

  it('does not treat environment-only or reversed documents as project root coverage', () => {
    expect(() => validate(environment, '.')).toThrow();
    expect(() => validate(`---\n${project}---\n${environment}`, '.')).toThrow();
  });

  it.each([
    ['empty stream', ''],
    ['empty project document', `---\n${environment}---\n`],
    ['malformed environment', `---\n${environment}broken: [\n---\n${project}`],
    ['malformed project', `${combined}broken: [\n`],
    [
      'duplicate environment key',
      `---\n${environment}importers: {}\n---\n${project}`,
    ],
    ['duplicate project key', `${combined}importers: {}\n`],
    ['unknown environment version', combined.replace("'9.0'", '99')],
    [
      'unknown project version',
      `---\n${environment}---\n${project.replace("'9.0'", '99')}`,
    ],
    [
      'mismatched versions',
      `---\n${environment}---\n${project.replace("'9.0'", '6')}`,
    ],
    ['two project documents', `---\n${project}---\n${project}`],
    ['extra document', `${combined}---\n${project}`],
    [
      'null importer',
      project.replace('packages/member: {}', 'packages/member: null'),
    ],
    ['array importers', 'lockfileVersion: 9\nimporters: [packages/member]\n'],
    ['array version', project.replace("'9.0'", '[9]')],
  ])('rejects unproven coverage: %s', (_name, text) => {
    expect(() => validate(text)).toThrow();
  });
});
