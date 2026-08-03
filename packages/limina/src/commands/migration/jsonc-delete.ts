import {
  createScanner,
  findNodeAtLocation,
  type Node,
  parseTree,
} from 'jsonc-parser';
import type { CommaToken, TextEdit } from './jsonc-delete-ranges';
import { applyTextEdits, findLineAlignedDeletion } from './jsonc-delete-ranges';

const jsoncCommaTokenKind = 5;
const jsoncTriviaTokenKinds = new Set([12, 13, 14, 15]);

function findPropertyNode(
  content: string,
  path: readonly (number | string)[],
): Node | undefined {
  const root = parseTree(content);
  if (root === undefined) return undefined;
  const valueNode = findNodeAtLocation(root, [...path]);
  return valueNode?.parent;
}

function isObjectProperty(node: Node | undefined): node is Node {
  return node?.parent?.type === 'object';
}

function findFollowingComma(content: string, start: number): CommaToken | null {
  const scanner = createScanner(content, false);
  scanner.setPosition(start);
  let token = scanner.scan();
  while (jsoncTriviaTokenKinds.has(token)) token = scanner.scan();
  return token === jsoncCommaTokenKind
    ? { length: scanner.getTokenLength(), offset: scanner.getTokenOffset() }
    : null;
}

function findPrecedingComma(
  content: string,
  start: number,
  end: number,
): CommaToken | null {
  const scanner = createScanner(content, false);
  scanner.setPosition(start);
  let comma: CommaToken | null = null;
  while (scanner.getPosition() < end) {
    if (scanner.scan() === jsoncCommaTokenKind) {
      comma = {
        length: scanner.getTokenLength(),
        offset: scanner.getTokenOffset(),
      };
    }
  }
  return comma;
}

function getParentOffset(property: Node): number {
  const parent = property.parent;
  if (parent !== undefined) return parent.offset;
  return property.offset;
}

function getPrecedingCommaEdit(
  content: string,
  property: Node,
): TextEdit | null {
  const precedingComma = findPrecedingComma(
    content,
    getParentOffset(property),
    property.offset,
  );
  return precedingComma === null
    ? null
    : { length: precedingComma.length, offset: precedingComma.offset };
}

function deleteLineProperty(
  content: string,
  property: Node,
  context: {
    followingComma: CommaToken | null;
    lineDeletion: TextEdit;
  },
): string {
  const edits: TextEdit[] = [context.lineDeletion];
  if (context.followingComma === null) {
    const precedingComma = getPrecedingCommaEdit(content, property);
    if (precedingComma !== null) edits.push(precedingComma);
  }
  return applyTextEdits(content, edits);
}

function deleteInlineProperty(
  content: string,
  property: Node,
  followingComma: CommaToken | null,
): string {
  if (followingComma !== null) {
    return applyTextEdits(content, [
      {
        length: followingComma.offset + followingComma.length - property.offset,
        offset: property.offset,
      },
    ]);
  }
  const edits: TextEdit[] = [
    { length: property.length, offset: property.offset },
  ];
  const precedingComma = getPrecedingCommaEdit(content, property);
  if (precedingComma !== null) edits.push(precedingComma);
  return applyTextEdits(content, edits);
}

export function deleteJsoncProperty(
  content: string,
  path: readonly (number | string)[],
): string {
  const property = findPropertyNode(content, path);
  if (!isObjectProperty(property)) return content;
  const followingComma = findFollowingComma(
    content,
    property.offset + property.length,
  );
  const lineDeletion = findLineAlignedDeletion(
    content,
    property,
    followingComma,
  );
  if (lineDeletion !== null) {
    return deleteLineProperty(content, property, {
      followingComma,
      lineDeletion,
    });
  }
  return deleteInlineProperty(content, property, followingComma);
}
