import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDocumentation } from './privacy';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const arguments_ = process.argv.slice(2);
const isBuilt = arguments_.includes('--built');
const shouldCheckContextRecords = arguments_.includes('--context-records');
const targets = arguments_.filter(
  (argument) => argument !== '--built' && argument !== '--context-records',
);
if (targets.length === 0)
  targets.push(
    path.join(repo, shouldCheckContextRecords ? '.agents/docs' : 'docs'),
  );
if (isBuilt) targets.push(path.join(repo, 'docs/.vitepress/dist'));
let isFailed = false;
for (const [index, target] of targets.entries()) {
  try {
    const result = await scanDocumentation(
      path.resolve(target),
      ['node_modules', '.vitepress/cache', '.vitepress/dist', '.tsbuild'],
      shouldCheckContextRecords,
    );
    for (const issue of result.issues)
      process.stderr.write(
        `target ${index + 1}: ${issue.file}:${issue.line} [${issue.category}]\n`,
      );
    if (result.files === 0 || result.issues.length > 0) isFailed = true;
    process.stdout.write(
      `Privacy scan target ${index + 1}: ${result.files} files, ${result.issues.length} issues.\n`,
    );
  } catch {
    isFailed = true;
    process.stderr.write(
      `Privacy scan target ${index + 1} could not be completed.\n`,
    );
  }
}
if (isFailed) process.exitCode = 1;
