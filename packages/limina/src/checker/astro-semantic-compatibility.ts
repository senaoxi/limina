import semver from 'semver';
import {
  externalCheckerDependencyContracts,
  isSupportedDependencyVersion,
  liminaRuntimeDependencyContracts,
} from '../dependency-contract';
import type {
  AstroSemanticAdapter,
  AstroSemanticVersionTuple,
} from './astro-semantic-types';

const ASTRO_RANGE = '>=7.0.0 <8.0.0';
const CHECK_CONTRACT = externalCheckerDependencyContracts['@astrojs/check'];
const TYPESCRIPT_CONTRACT = liminaRuntimeDependencyContracts.typescript;

function isMatchesExactSemanticTuple(
  tuple: AstroSemanticVersionTuple,
): boolean {
  return [
    tuple.languageServer === '2.16.13',
    tuple.compiler === '2.13.1',
    tuple.languageCore === '2.4.28',
    tuple.volarKit === '2.4.28',
    tuple.volarTypeScript === '2.4.28',
  ].every(Boolean);
}

function isMatchesVersionRanges(tuple: AstroSemanticVersionTuple): boolean {
  return [
    semver.satisfies(tuple.astro, ASTRO_RANGE),
    isSupportedDependencyVersion({
      contract: CHECK_CONTRACT,
      version: tuple.check,
    }),
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
  if (isMatchesExactSemanticTuple(tuple) && isMatchesVersionRanges(tuple)) {
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
