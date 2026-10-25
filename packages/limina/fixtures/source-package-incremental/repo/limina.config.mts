export default {
  scope: {
    checkers: { tsc: { include: ['tsconfig.json'] } },
    source: { include: ['packages/**/*.ts'] },
  },
  graph: { rules: {} },
  source: { knip: false },
  proof: { allowlist: [] },
};
