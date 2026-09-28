import ts from 'typescript';

interface ParsedJavaScript extends ts.SourceFile {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
}

function parseJavaScript(source: string, fileName: string): ts.SourceFile {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  ) as ParsedJavaScript;
  if (!Array.isArray(file.parseDiagnostics)) {
    throw new TypeError(
      `Unable to inspect source map comments in ${fileName}: parser diagnostics are unavailable.`,
    );
  }
  if (file.parseDiagnostics.length > 0) {
    const reason = ts.flattenDiagnosticMessageText(
      file.parseDiagnostics[0]!.messageText,
      '\n',
    );
    throw new Error(
      `Unable to inspect source map comments in ${fileName}: JavaScript parsing failed: ${reason}`,
    );
  }
  return file;
}

function isDirective(source: string, comment: ts.CommentRange): boolean {
  const end =
    comment.kind === ts.SyntaxKind.MultiLineCommentTrivia
      ? comment.end - 2
      : comment.end;
  return /^\s*#\s*sourceMappingURL\s*=/u.test(
    source.slice(comment.pos + 2, end),
  );
}

function hasDirectiveAt(source: string, position: number): boolean {
  const leading = ts.getLeadingCommentRanges(source, position) ?? [];
  const trailing = ts.getTrailingCommentRanges(source, position) ?? [];
  return [...leading, ...trailing].some((comment) =>
    isDirective(source, comment),
  );
}

function inspectPosition(
  source: string,
  position: number,
  seen: Set<number>,
): boolean {
  if (seen.has(position)) return false;
  seen.add(position);
  return hasDirectiveAt(source, position);
}

function inspectNode(
  source: string,
  node: ts.Node,
  seen: Set<number>,
): boolean {
  return (
    inspectPosition(source, node.pos, seen) ||
    inspectPosition(source, node.end, seen)
  );
}

function enqueueChildren(
  node: ts.Node,
  file: ts.SourceFile,
  pending: ts.Node[],
): void {
  for (const child of node.getChildren(file)) pending.push(child);
}

export function hasSourceMappingUrlDirective(
  source: string,
  fileName: string,
): boolean {
  const file = parseJavaScript(source, fileName);
  const pending: ts.Node[] = [file];
  const seen = new Set<number>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (inspectNode(source, node, seen)) return true;
    enqueueChildren(node, file, pending);
  }
  return false;
}
