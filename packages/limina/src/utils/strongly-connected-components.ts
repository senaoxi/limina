export function collectStronglyConnectedComponents<T>(
  nodes: readonly T[],
  getNeighbors: (node: T) => Iterable<T>,
): T[][] {
  const rankByNode = new Map<T, number>();

  for (const [rank, node] of nodes.entries()) {
    if (rankByNode.has(node)) {
      throw new Error(
        'Strongly connected components require unique input nodes.',
      );
    }

    rankByNode.set(node, rank);
  }

  const getNodeRank = (node: T): number => {
    const rank = rankByNode.get(node);

    if (rank === undefined) {
      throw new Error(
        'Strongly connected components received an edge to an unknown node.',
      );
    }

    return rank;
  };
  const indexByNode = new Map<T, number>();
  const lowLinkByNode = new Map<T, number>();
  const stack: T[] = [];
  const nodesOnStack = new Set<T>();
  const components: T[][] = [];
  let nextIndex = 0;

  const visit = (node: T): void => {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    nodesOnStack.add(node);

    for (const neighbor of getNeighbors(node)) {
      getNodeRank(neighbor);

      if (!indexByNode.has(neighbor)) {
        visit(neighbor);
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node)!, lowLinkByNode.get(neighbor)!),
        );
      } else if (nodesOnStack.has(neighbor)) {
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node)!, indexByNode.get(neighbor)!),
        );
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) {
      return;
    }

    const component: T[] = [];

    while (stack.length > 0) {
      const componentNode = stack.pop()!;

      nodesOnStack.delete(componentNode);
      component.push(componentNode);

      if (componentNode === node) {
        break;
      }
    }

    components.push(component);
  };

  for (const node of nodes) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  const compareByInputRank = (left: T, right: T): number =>
    getNodeRank(left) - getNodeRank(right);

  return components
    .map((component) => component.sort(compareByInputRank))
    .sort((left, right) => compareByInputRank(left[0]!, right[0]!));
}
