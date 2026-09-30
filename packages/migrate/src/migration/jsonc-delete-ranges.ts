import { createScanner, type Node } from 'jsonc-parser';

const jsoncLineCommentTokenKind = 12;
const jsoncBlockCommentTokenKind = 13;
export interface CommaToken {
  length: number;
  offset: number;
}
export interface TextEdit {
  length: number;
  offset: number;
}
interface LineBounds {
  contentEnd: number;
  end: number;
}
interface ScannerToken {
  length: number;
  offset: number;
}
interface TokenRange {
  end: number;
  start: number;
}
interface AttachedCommentContext {
  indentation: string;
  lineStart: number;
}
function findLineStart(content: string, offset: number): number {
  const newlineOffset = content.lastIndexOf('\n', Math.max(offset - 1, 0));
  return newlineOffset === -1 ? 0 : newlineOffset + 1;
}
function findLineContentEnd(
  content: string,
  newlineOffset: number,
  offset: number,
): number {
  if (newlineOffset <= offset) return newlineOffset;
  return content[newlineOffset - 1] === '\r'
    ? newlineOffset - 1
    : newlineOffset;
}
function findLineBounds(content: string, offset: number): LineBounds {
  const newlineOffset = content.indexOf('\n', offset);
  if (newlineOffset === -1) {
    return { contentEnd: content.length, end: content.length };
  }
  return {
    contentEnd: findLineContentEnd(content, newlineOffset, offset),
    end: newlineOffset + 1,
  };
}
function isHorizontalWhitespace(value: string): boolean {
  return /^[ \t]*$/u.test(value);
}
function isHorizontalWhitespaceCharacter(value: string | undefined): boolean {
  return value === ' ' || value === '\t';
}
function skipHorizontalWhitespace(
  content: string,
  start: number,
  end: number,
): number {
  let offset = start;
  while (offset < end && isHorizontalWhitespaceCharacter(content[offset])) {
    offset += 1;
  }
  return offset;
}
function isCommentToken(kind: number): boolean {
  return (
    kind === jsoncLineCommentTokenKind || kind === jsoncBlockCommentTokenKind
  );
}
function isTokenWithinRange(token: ScannerToken, range: TokenRange): boolean {
  return (
    !(token.offset < range.start) && token.offset + token.length <= range.end
  );
}

function isCommentInRange(
  kind: number,
  token: ScannerToken,
  range: TokenRange,
): boolean {
  return isCommentToken(kind) && isTokenWithinRange(token, range);
}

function isCommentAt(
  kind: number,
  token: ScannerToken,
  range: TokenRange,
): boolean {
  return (
    isCommentToken(kind) &&
    token.offset === range.start &&
    isTokenWithinRange(token, range)
  );
}

function isCompleteComment(kind: number, scanError: number): boolean {
  return kind !== jsoncBlockCommentTokenKind || scanError === 0;
}
function scanComments(
  content: string,
  start: number,
  end: number,
): ScannerToken[] {
  const scanner = createScanner(content, false);
  scanner.setPosition(start);
  const comments: ScannerToken[] = [];
  while (scanner.getPosition() < end) {
    const kind = scanner.scan();
    const token = {
      length: scanner.getTokenLength(),
      offset: scanner.getTokenOffset(),
    };
    if (isCommentInRange(kind, token, { end, start })) comments.push(token);
  }
  return comments;
}
function findPreviousSibling(property: Node): Node | undefined {
  const siblings = property.parent?.children ?? [];
  const propertyIndex = siblings.findIndex((sibling) =>
    isSameNodePosition(sibling, property),
  );
  return siblings[propertyIndex - 1];
}

function isSameNodePosition(left: Node, right: Node): boolean {
  return left.offset === right.offset && left.length === right.length;
}

function findPreviousSiblingBoundary(property: Node): number {
  const previousSibling = findPreviousSibling(property);
  if (previousSibling !== undefined) {
    return previousSibling.offset + previousSibling.length;
  }
  const parent = property.parent;
  return parent === undefined ? property.offset : parent.offset + 1;
}

function isAttachedCommentLine(
  content: string,
  comment: ScannerToken,
  context: AttachedCommentContext,
): boolean {
  const commentLineStart = findLineStart(content, comment.offset);
  const commentLine = findLineBounds(content, comment.offset + comment.length);
  return (
    commentLine.end === context.lineStart &&
    content.slice(commentLineStart, comment.offset) === context.indentation &&
    isHorizontalWhitespace(
      content.slice(comment.offset + comment.length, commentLine.contentEnd),
    )
  );
}

function findAttachedCommentStart(
  content: string,
  property: Node,
  context: AttachedCommentContext,
): number {
  const comments = scanComments(
    content,
    findPreviousSiblingBoundary(property),
    property.offset,
  );
  let attachedStart = context.lineStart;
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (
      !isAttachedCommentLine(content, comment, {
        indentation: context.indentation,
        lineStart: attachedStart,
      })
    ) {
      break;
    }
    attachedStart = findLineStart(content, comment.offset);
  }
  return attachedStart;
}

function getOwnedEnd(
  property: Node,
  followingComma: CommaToken | null,
): number {
  return followingComma === null
    ? property.offset + property.length
    : followingComma.offset + followingComma.length;
}

function isOwnedLineSuffix(
  content: string,
  start: number,
  lineContentEnd: number,
): boolean {
  const commentStart = skipHorizontalWhitespace(content, start, lineContentEnd);
  if (commentStart === lineContentEnd) return true;

  const comment = scanOwnedComment(content, commentStart, lineContentEnd);
  return (
    comment !== null &&
    skipHorizontalWhitespace(
      content,
      comment.offset + comment.length,
      lineContentEnd,
    ) === lineContentEnd
  );
}

function scanOwnedComment(
  content: string,
  commentStart: number,
  lineContentEnd: number,
): ScannerToken | null {
  const scanner = createScanner(content, false);
  scanner.setPosition(commentStart);
  const kind = scanner.scan();
  const tokenOffset = scanner.getTokenOffset();
  const tokenEnd = tokenOffset + scanner.getTokenLength();
  const token = { length: tokenEnd - tokenOffset, offset: tokenOffset };
  return !isCommentAt(kind, token, {
    end: lineContentEnd,
    start: commentStart,
  }) || !isCompleteComment(kind, scanner.getTokenError())
    ? null
    : token;
}

function hasMultilineOwnedPrefix(
  content: string,
  property: Node,
  followingComma: CommaToken | null,
): boolean {
  return (
    followingComma !== null &&
    /[\r\n]/u.test(
      content.slice(property.offset + property.length, followingComma.offset),
    )
  );
}

function findOwnedLine(
  content: string,
  property: Node,
  context: { followingComma: CommaToken | null; ownedEnd: number },
): LineBounds | null {
  if (hasMultilineOwnedPrefix(content, property, context.followingComma))
    return null;
  const ownedLine = findLineBounds(content, context.ownedEnd);
  return isOwnedLineSuffix(content, context.ownedEnd, ownedLine.contentEnd)
    ? ownedLine
    : null;
}

export function findLineAlignedDeletion(
  content: string,
  property: Node,
  followingComma: CommaToken | null,
): TextEdit | null {
  const propertyLineStart = findLineStart(content, property.offset);
  const propertyIndent = content.slice(propertyLineStart, property.offset);
  if (!isHorizontalWhitespace(propertyIndent)) return null;
  const ownedEnd = getOwnedEnd(property, followingComma);
  const ownedLine = findOwnedLine(content, property, {
    followingComma,
    ownedEnd,
  });
  if (ownedLine === null) return null;
  const deletionStart = findAttachedCommentStart(content, property, {
    indentation: propertyIndent,
    lineStart: propertyLineStart,
  });
  return { length: ownedLine.end - deletionStart, offset: deletionStart };
}

export function applyTextEdits(
  content: string,
  edits: readonly TextEdit[],
): string {
  const orderedEdits = [...edits].sort(
    (left, right) => right.offset - left.offset,
  );
  for (let index = 1; index < orderedEdits.length; index += 1) {
    const current = orderedEdits[index];
    const later = orderedEdits[index - 1];
    if (current.offset + current.length > later.offset) {
      throw new Error('JSONC deletion edits overlap.');
    }
  }
  return orderedEdits.reduce(
    (result, edit) =>
      `${result.slice(0, edit.offset)}${result.slice(edit.offset + edit.length)}`,
    content,
  );
}
