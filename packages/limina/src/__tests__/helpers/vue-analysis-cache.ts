import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnalysisSnapshot } from '../../core/analysis-cache/contracts';
import {
  readStoredAnalysisSnapshot,
  writeStoredAnalysisSnapshot,
} from './analysis-snapshot';
import { createFixturePathResolver } from './path';

export interface VueCacheRun {
  events: { kind: string; count: number }[];
  graph: unknown;
  passed: boolean;
  vuePrograms: number;
  generation: number;
  identities: { generation: number; hasRuntime: boolean }[];
  execution?: {
    before: number | string;
    after: number | string;
    starts: number;
  };
}

export function createVueCacheFixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-vue-cache-'));
  const rootDirectory = realpathSync.native(temporary);
  const file = createFixturePathResolver(rootDirectory);
  const write = (name: string, content: string) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), content);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
      packageManager: 'npm@11.6.1',
    }),
  );
  write(
    'package-lock.json',
    JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }),
  );
  for (const name of ['typescript', 'vue-tsc', 'vue']) {
    const target = path.dirname(
      createRequire(import.meta.url).resolve(`${name}/package.json`),
    );
    mkdirSync(file('node_modules'), { recursive: true });
    symlinkSync(target, file('node_modules', name), 'junction');
  }
  write(
    'limina.config.mjs',
    `export default {scope:{source:{include:['vue/src/**/*.{ts,vue}','native/src/**/*.ts']},checkers:{'vue-tsc':{include:['vue/tsconfig.json']},tsc:{include:['native/tsconfig.json']}}}};`,
  );
  const options = {
    composite: true,
    declaration: true,
    types: [],
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    allowArbitraryExtensions: true,
    outDir: 'dist',
  };
  write(
    'vue/tsconfig.json',
    JSON.stringify({ compilerOptions: options, include: ['src/**/*'] }),
  );
  write(
    'native/tsconfig.json',
    JSON.stringify({ compilerOptions: options, include: ['src/**/*'] }),
  );
  write('native/src/index.ts', 'export const native = 1;');
  write(
    'vue/src/Widget.vue',
    `<script setup lang="ts">import theme from './theme.css'; import { value } from './value.js'; const result = value + theme;</script><template>{{result}}</template>`,
  );
  write('vue/src/value.ts', 'export const value = 1;');
  write(
    'vue/src/index.ts',
    "import { value } from './value.js'; export { value };",
  );
  write('vue/src/theme.css', '.theme { color: red; }');
  write(
    'vue/src/ambient.d.ts',
    'declare module "*.css" { const value: string; export default value; }',
  );
  const url = (name: string) =>
    new URL(`../../${name}.ts`, import.meta.url).href;
  write(
    'runner.mjs',
    `
import {loadConfig} from ${JSON.stringify(url('config/loader'))};
import {LiminaPreflightManager} from ${JSON.stringify(url('preflight/manager'))};
import {createPreflightGenerationController} from ${JSON.stringify(url('preflight/generation'))};
import {isRunGraphCheckImpl} from ${JSON.stringify(url('graph-check/runner'))};
import {VueSemanticContext} from ${JSON.stringify(url('core/vue-semantic/context-handle'))};
import {createCheckerTarget} from ${JSON.stringify(url('typecheck/targets'))};
import {ExecutionAdmission} from ${JSON.stringify(url('typecheck/admission/execution-admission'))};
import {executeAuthorizedTypecheck} from ${JSON.stringify(url('typecheck/checker/typecheck-execution'))};
import {writeFileSync} from 'node:fs';
const descriptor=Object.getOwnPropertyDescriptor(VueSemanticContext.prototype,'program');
const seen=new WeakSet();let vuePrograms=0;
Object.defineProperty(VueSemanticContext.prototype,'program',{...descriptor,get(){const program=descriptor.get.call(this);if(!seen.has(program)){seen.add(program);vuePrograms++;}return program;}});
const options=JSON.parse(process.argv[2]);
const config=await loadConfig({configPath:${JSON.stringify(file('limina.config.mjs'))}});
const events=[];
const manager=new LiminaPreflightManager({config,analysisCache:options.cache??true,forceAnalysisCache:options.force,metrics:{record:event=>events.push(event)}});
try {
  await manager.ensureGeneratedArtifactsMaterialized();
  if(options.refresh)createPreflightGenerationController(manager).startNextGeneration();
  const graph=await manager.ensureGeneratedGraph();
  const passed=await isRunGraphCheckImpl(config,{preflight:manager});
  await manager.publishAnalysisCache();
  let execution;
  if(options.executionDrift) {
    const target=createCheckerTarget({checker:graph.checkers.find(checker=>checker.name==='vue-tsc'), configPath:graph.checkerEntries.get('vue-tsc'), executionKind:'build',projectRootDir:config.rootDir});
    const admission=new ExecutionAdmission(manager,graph,[target]);let starts=0;
    const run=()=>executeAuthorizedTypecheck({admission:admission},target,()=>{starts++;return {configPath:target.configPath,status:0};});
    const before=(await run()).status;
    writeFileSync(options.executionDrift.path,options.executionDrift.content);
    execution={before,after:(await run()).status,starts};
  }
  const identities=[...graph.governedSources.values()].flatMap(units=>[...units.values()]).flatMap(unit=>unit.context.vueSemanticIdentity ? [{generation:unit.context.vueSemanticIdentity.generation,hasRuntime:typeof unit.context.vueSemanticIdentity.toolchain.tsModule.createProgram==='function'}] : []);
  console.log(JSON.stringify({events,graph:{manifest:graph.manifest,ownershipPlan:graph.ownershipPlan},passed,vuePrograms,identities,execution}));
}finally{manager.dispose();}
`,
  );
  const run = (
    options: {
      cache?: boolean | 'read-only';
      force?: boolean;
      refresh?: boolean;
      executionDrift?: { path: string; content: string };
    } = {},
  ): VueCacheRun => {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        file('runner.mjs'),
        JSON.stringify(options),
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(output.trim().split('\n').at(-1)!);
  };
  const snapshotFile = () => {
    const base = file('.limina/cache/analysis-v2');
    const entry = readdirSync(base, { recursive: true }).find(
      (name) => typeof name === 'string' && name.endsWith('index.liminainfo'),
    );
    if (typeof entry !== 'string')
      throw new Error('Expected published analysis snapshot.');
    return file('.limina/cache/analysis-v2', entry);
  };
  const snapshot = (): AnalysisSnapshot => {
    return readStoredAnalysisSnapshot(snapshotFile());
  };
  return {
    rootDir: rootDirectory,
    path: file,
    write,
    run,
    snapshot,
    writeSnapshot: (value: AnalysisSnapshot) =>
      writeStoredAnalysisSnapshot(snapshotFile(), value),
    snapshotFile,
    cleanup: () => rmSync(rootDirectory, { recursive: true, force: true }),
  };
}

export function cacheMetric(run: VueCacheRun, kind: string): number {
  return run.events
    .filter((event) => event.kind === kind)
    .reduce((sum, event) => sum + event.count, 0);
}
