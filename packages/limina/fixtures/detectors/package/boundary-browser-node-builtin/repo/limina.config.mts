export default {
  package: {
    entries: [
      {
        boundary: {
          environment: 'browser',
        },
        checks: ['boundary'],
        name: '@fixture/boundary-browser-node-builtin',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
