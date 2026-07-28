import {
  createScanner,
  findNodeAtLocation,
  type Node,
  parseTree,
} from 'jsonc-parser';

const jsoncTriviaTokenKinds = new Set([12, 13, 14, 15]);
const jsoncCommaTokenKind = 5;

function findPropertyNode(
  content: string,
  path: readonly (number | string)[],
): Node | undefined {
  const root = parseTree(content);
  if (root === undefined) return undefined;
  const valueNode = findNodeAtLocation(root, [...path]);
  return valueNode?.parent;
}

function isPropertyNode(node: Node | undefined): node is Node {
  if (node === undefined) return false;
  return node.type === 'property';
}

function isObjectNode(node: Node | undefined): node is Node {
  if (node === undefined) return false;
  return node.type === 'object';
}

function isObjectProperty(node: Node | undefined): node is Node {
  if (!isPropertyNode(node)) return false;
  return isObjectNode(node.parent);
}

function findFollowingComma(
  content: string,
  start: number,
): { length: number; offset: number } | null {
  const scanner = createScanner(content, false);
  scanner.setPosition(start);
  let token = scanner.scan();
  while (jsoncTriviaTokenKinds.has(token)) token = scanner.scan();
  return token === jsoncCommaTokenKind
    ? {
        length: scanner.getTokenLength(),
        offset: scanner.getTokenOffset(),
      }
    : null;
}

function findPrecedingComma(
  content: string,
  start: number,
  end: number,
): { length: number; offset: number } | null {
  const scanner = createScanner(content, false);
  scanner.setPosition(start);
  let comma: { length: number; offset: number } | null = null;
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

function deleteWithFollowingComma(
  content: string,
  property: Node,
  followingComma: { length: number; offset: number },
): string {
  return `${content.slice(0, property.offset)}${content.slice(
    followingComma.offset + followingComma.length,
  )}`;
}

function getParentOffset(property: Node): number {
  if (property.parent === undefined) return property.offset;
  return property.parent.offset;
}

function getDeletionStart(property: Node, precedingOffset?: number): number {
  if (precedingOffset === undefined) return property.offset;
  return precedingOffset;
}

function deleteLastProperty(content: string, property: Node): string {
  const precedingComma = findPrecedingComma(
    content,
    getParentOffset(property),
    property.offset,
  );
  const deletionStart = getDeletionStart(property, precedingComma?.offset);
  return `${content.slice(0, deletionStart)}${content.slice(
    property.offset + property.length,
  )}`;
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
  return followingComma === null
    ? deleteLastProperty(content, property)
    : deleteWithFollowingComma(content, property, followingComma);
}
