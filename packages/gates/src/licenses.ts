import { Lexer, type Tokens } from 'marked';

export function parseAllowedLicenses(policy: string): readonly string[] {
  const blocks = Lexer.lex(policy).filter(
    (token): token is Tokens.Code =>
      token.type === 'code' && token.lang === 'json',
  );
  if (blocks.length !== 1) {
    throw new Error('License policy must contain exactly one JSON code block.');
  }
  const licenses: unknown = JSON.parse(blocks[0]!.text);
  if (
    !Array.isArray(licenses) ||
    licenses.length === 0 ||
    licenses.some(
      (license: unknown) =>
        typeof license !== 'string' ||
        license.length === 0 ||
        license.trim() !== license,
    ) ||
    new Set(licenses).size !== licenses.length
  ) {
    throw new Error(
      'License policy must contain a non-empty array of unique, non-empty license strings without surrounding whitespace.',
    );
  }
  return licenses as string[];
}
