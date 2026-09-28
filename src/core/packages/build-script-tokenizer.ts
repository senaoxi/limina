import type { BuildCheckerPreset } from '#config/runner';

interface TokenizerState {
  current: string;
  quote: '"' | "'" | null;
  tokens: string[];
}

const supportedBuildCheckers = new Set(['tsc', 'vue-tsc', 'tsgo']);

function appendCurrentToken(state: TokenizerState): void {
  if (state.current.length === 0) {
    return;
  }

  state.tokens.push(state.current);
  state.current = '';
}

function handleQuotedCharacter(state: TokenizerState, character: string): void {
  if (character === state.quote) {
    state.quote = null;
    return;
  }

  state.current += character;
}

function isQuoteCharacter(character: string): character is '"' | "'" {
  return character === '"' || character === "'";
}

function handleUnquotedCharacter(
  state: TokenizerState,
  character: string,
): void {
  if (isQuoteCharacter(character)) {
    state.quote = character;
    return;
  }

  if (/\s/u.test(character)) {
    appendCurrentToken(state);
    return;
  }

  state.current += character;
}

function finalizeTokens(state: TokenizerState): string[] | null {
  if (state.quote !== null) {
    return null;
  }

  appendCurrentToken(state);
  return state.tokens;
}

export function tokenizeStaticCommand(command: string): string[] | null {
  const state: TokenizerState = { current: '', quote: null, tokens: [] };

  for (const character of command) {
    if (state.quote === null) {
      handleUnquotedCharacter(state, character);
    } else {
      handleQuotedCharacter(state, character);
    }
  }

  return finalizeTokens(state);
}

interface CommandPrefix {
  argumentOffset: number;
  tokens: readonly string[];
}

const commandPrefixes: readonly CommandPrefix[] = [
  { argumentOffset: 2, tokens: ['limina', 'build'] },
  { argumentOffset: 3, tokens: ['pnpm', 'limina', 'build'] },
  { argumentOffset: 4, tokens: ['pnpm', 'exec', 'limina', 'build'] },
];

function tokensStartWith(
  tokens: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

export function getLiminaBuildArgumentOffset(
  tokens: readonly string[],
): number | null {
  const prefix = commandPrefixes.find((candidate) =>
    tokensStartWith(tokens, candidate.tokens),
  );
  return prefix === undefined ? null : prefix.argumentOffset;
}

export function parseBuildChecker(
  value: string | undefined,
): BuildCheckerPreset | null {
  return value !== undefined && supportedBuildCheckers.has(value)
    ? (value as BuildCheckerPreset)
    : null;
}
