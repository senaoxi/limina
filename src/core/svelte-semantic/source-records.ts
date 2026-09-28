import type ts from 'typescript';

const SCRIPT_OPENING_TAG =
  /<[Ss][Cc][Rr][Ii][Pp][Tt](?=[ \t\n\f\r>])(?:[^>"']|"[^"]*"|'[^']*')*>/gu;
const TYPESCRIPT_LANG_ATTRIBUTE =
  /(?:^|[ \t\n\f\r])lang[ \t\n\f\r]*=[ \t\n\f\r]*(?:"(?:ts|typescript)"|'(?:ts|typescript)'|(?:ts|typescript)(?=[ \t\n\f\r>]))/iu;

export function isSvelteTypeScriptSource(sourceText: string): boolean {
  for (const match of sourceText.matchAll(SCRIPT_OPENING_TAG)) {
    if (TYPESCRIPT_LANG_ATTRIBUTE.test(match[0])) return true;
  }
  return false;
}

export function getSvelteScriptKind(
  sourceText: string,
  tsModule: typeof ts,
): ts.ScriptKind {
  return isSvelteTypeScriptSource(sourceText)
    ? tsModule.ScriptKind.TS
    : tsModule.ScriptKind.JS;
}
