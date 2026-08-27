import semver from 'semver';
import {
  isSupportedDependencyVersion,
  liminaRuntimeDependencyContracts,
} from '../dependency-contract';
import type {
  AstroSemanticAdapter,
  AstroSemanticVersionTuple,
} from './astro-semantic-types';

const ASTRO_RANGE = '>=7.0.0 <8.0.0';
const TYPESCRIPT_CONTRACT = liminaRuntimeDependencyContracts.typescript;

function matchesExactSemanticTuple(tuple: AstroSemanticVersionTuple): boolean {
  return [
    tuple.check === '0.9.10',
    tuple.languageServer === '2.16.13',
    tuple.compiler === '2.13.1',
    tuple.languageCore === '2.4.28',
    tuple.volarKit === '2.4.28',
    tuple.volarTypeScript === '2.4.28',
  ].every(Boolean);
}

function matchesVersionRanges(tuple: AstroSemanticVersionTuple): boolean {
  return [
    semver.satisfies(tuple.astro, ASTRO_RANGE),
    isSupportedDependencyVersion({
      contract: TYPESCRIPT_CONTRACT,
      version: tuple.typeScript,
    }),
    isSupportedDependencyVersion({
      contract: TYPESCRIPT_CONTRACT,
      version: tuple.leafTypeScript,
    }),
  ].every(Boolean);
}

export function formatAstroSemanticVersionTuple(
  tuple: AstroSemanticVersionTuple,
): string {
  return [
    `astro ${tuple.astro}`,
    `@astrojs/check ${tuple.check}`,
    `@astrojs/language-server ${tuple.languageServer}`,
    `@astrojs/compiler ${tuple.compiler}`,
    `@volar/language-core ${tuple.languageCore}`,
    `@volar/kit ${tuple.volarKit}`,
    `@volar/typescript ${tuple.volarTypeScript}`,
    `TypeScript ${tuple.typeScript}`,
    `leaf TypeScript ${tuple.leafTypeScript}`,
  ].join(', ');
}

export function resolveAstroSemanticAdapter(
  tuple: AstroSemanticVersionTuple,
): AstroSemanticAdapter {
  if (matchesExactSemanticTuple(tuple) && matchesVersionRanges(tuple)) {
    return { family: 'astro-7-check-0.9', kind: 'supported' };
  }
  return {
    kind: 'unsupported',
    reason: `Unsupported Astro semantic toolchain: ${formatAstroSemanticVersionTuple(tuple)}.`,
  };
}

export function isSupportedAstroSemanticVersionTuple(
  tuple: AstroSemanticVersionTuple,
): boolean {
  return resolveAstroSemanticAdapter(tuple).kind === 'supported';
}
