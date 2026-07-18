import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env as inheritedEnvironment } from 'node:process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertDistArtifacts,
  type CommandResult,
  type ConsumerFixture,
  createConsumerFixture,
  packLiminaDist,
  runCommand,
  runPnpm,
} from './helpers';

const INVOCATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MODE = `mode 空格 ' " & | < > ^ %PATH% !LIMINA! ( ) \\ tail\\`;

interface ArgvProbePayload {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly execPath: string;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '');
}

function createShellEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    // The shell round-trip must inherit the exact caller PATH before pruning
    // consumer-local bins and any separately installed Limina executable.
    ...inheritedEnvironment,
    CI: 'true',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ...overrides,
  };

  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() !== 'path') {
      continue;
    }

    environment[key] = (environment[key] ?? '')
      .split(path.delimiter)
      .filter(
        (entry) =>
          !normalizePath(entry).toLowerCase().endsWith('/node_modules/.bin'),
      )
      .join(path.delimiter);
  }

  return environment;
}

async function removeResolvedBareLiminaFromPath(
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<NodeJS.ProcessEnv> {
  const resolution = await resolveBareLimina(environment, cwd);
  const resolvedDirectories = new Set(
    resolution.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((entry) => normalizePath(path.dirname(entry)).toLowerCase()),
  );
  const isolatedEnvironment = { ...environment };

  for (const key of Object.keys(isolatedEnvironment)) {
    if (key.toLowerCase() !== 'path') {
      continue;
    }

    isolatedEnvironment[key] = (isolatedEnvironment[key] ?? '')
      .split(path.delimiter)
      .filter(
        (entry) => !resolvedDirectories.has(normalizePath(entry).toLowerCase()),
      )
      .join(path.delimiter);
  }

  return isolatedEnvironment;
}

async function resolveBareLimina(
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CommandResult> {
  return process.platform === 'win32'
    ? runCommand('where.exe', ['limina'], {
        cwd,
        env: environment,
        reject: false,
        timeout: 30_000,
      })
    : runCommand('/bin/sh', ['-c', 'command -v limina'], {
        cwd,
        env: environment,
        reject: false,
        timeout: 30_000,
      });
}

function extractGeneratedCommand(stdout: string, label: string): string {
  const prefix = `${label}: `;
  const line = stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(prefix));

  if (!line) {
    throw new Error(`Expected generated command label ${label} in:\n${stdout}`);
  }

  return line.slice(prefix.length);
}

async function writeArgvProbe(outsideCwd: string): Promise<string> {
  const probePath = path.join(outsideCwd, 'limina-argv-probe.mjs');

  await writeFile(
    probePath,
    `import { writeFileSync } from 'node:fs';

const normalizedEntry = (process.argv[1] ?? '').replaceAll('\\\\', '/');
const outputPath = process.env.LIMINA_ARGV_PROBE_PATH;
if (outputPath && normalizedEntry.endsWith('/limina/bin/limina.js')) {
  writeFileSync(
    outputPath,
    JSON.stringify({ argv: process.argv, cwd: process.cwd(), execPath: process.execPath }),
    'utf8',
  );
}
`,
    'utf8',
  );

  return probePath;
}

async function assertGeneratedCommandRoundTrip(options: {
  command: string;
  environment: NodeJS.ProcessEnv;
  executable: string;
  fixture: ConsumerFixture;
  invocationId: string;
  outsideCwd: string;
  prefixArgs: readonly string[];
  probeModulePath: string;
  variantName: string;
}): Promise<void> {
  const probeOutputPath = path.join(
    options.outsideCwd,
    `argv-${options.variantName}.json`,
  );
  await rm(probeOutputPath, { force: true });
  const nodeOptions = [
    // Preserve caller instrumentation while adding the argv probe import.
    inheritedEnvironment.NODE_OPTIONS,
    `--import=${pathToFileURL(options.probeModulePath).href}`,
  ]
    .filter(Boolean)
    .join(' ');
  const result = await runCommand(
    options.executable,
    [...options.prefixArgs, options.command],
    {
      cwd: options.outsideCwd,
      env: createShellEnvironment({
        ...options.environment,
        LIMINA_ARGV_PROBE_PATH: probeOutputPath,
        NODE_OPTIONS: nodeOptions,
      }),
      reject: false,
      timeout: 180_000,
    },
  );

  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain(options.invocationId);

  const probe = JSON.parse(
    await readFile(probeOutputPath, 'utf8'),
  ) as ArgvProbePayload;
  const realFixtureDir = normalizePath(
    await realpath(options.fixture.fixtureDir),
  );
  const realProbeEntry = normalizePath(await realpath(probe.argv[1] ?? ''));
  expect(probe.argv.slice(2)).toEqual([
    '--config',
    normalizePath(options.fixture.configPath),
    '--config-loader',
    'native',
    '--mode',
    MODE,
    'check',
    '--issues',
    '--invocation',
    options.invocationId,
  ]);
  expect(normalizePath(await realpath(probe.cwd))).toBe(realFixtureDir);
  expect(realProbeEntry).toContain(`${realFixtureDir}/node_modules/`);
  expect(realProbeEntry).toMatch(/\/limina\/bin\/limina\.js$/u);
  expect(probe.execPath).toBeTruthy();
}

async function getPowerShellEvidence(
  executable: 'powershell.exe' | 'pwsh.exe',
  environment: NodeJS.ProcessEnv,
  outsideCwd: string,
): Promise<{ pnpmSource: string; version: string }> {
  const result = await runCommand(
    executable,
    [
      '-NoProfile',
      '-Command',
      '(Get-Command pnpm).Source; $PSVersionTable.PSVersion.ToString()',
    ],
    {
      cwd: outsideCwd,
      env: environment,
      timeout: 30_000,
    },
  );
  const [pnpmSource = '', version = ''] = result.stdout.split(/\r?\n/u);

  return { pnpmSource, version };
}

describe('smoke pnpm runner', () => {
  it('uses the Corepack JS entry when npm_execpath is unavailable', async () => {
    const corepackRoot = await mkdtemp(
      path.join(tmpdir(), 'limina-fake-corepack-'),
    );
    const forwardedArgs = ['exec', 'limina', '--mode', MODE];

    try {
      const corepackDistDir = path.join(corepackRoot, 'dist');
      await mkdir(corepackDistDir, { recursive: true });
      await writeFile(
        path.join(corepackDistDir, 'pnpm.js'),
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
        'utf8',
      );

      const result = await runPnpm(forwardedArgs, {
        cwd: corepackRoot,
        env: createShellEnvironment({
          COREPACK_ROOT: corepackRoot,
          npm_execpath: undefined,
        }),
      });

      expect(result.stdout).toBe(JSON.stringify(forwardedArgs));
    } finally {
      await rm(corepackRoot, { force: true, recursive: true });
    }
  });
});

describe('standalone invocation generated command', () => {
  it('round-trips the exact packed-consumer command through real shells', async () => {
    const manifest = assertDistArtifacts();
    const packedDist = await packLiminaDist();
    const outsideCwd = await mkdtemp(
      path.join(tmpdir(), 'limina-generated-command-outside-'),
    );
    let fixture: ConsumerFixture | undefined;

    try {
      fixture = await createConsumerFixture({
        configFileName: 'limina 空格 & ^ %PATH% !L! (x).mjs',
        directoryName: 'ws 空格漢字 & ^ %PATH% !L! (x)',
        manifest,
        sourceText: 'export const value: string = 1;\n',
        tarballPath: packedDist.tarballPath,
      });
      const environment = await removeResolvedBareLiminaFromPath(
        createShellEnvironment(),
        outsideCwd,
      );
      // Windows may report a missing extensionless command through cmd.exe's
      // numeric exit code instead of Execa's synthetic ENOENT.
      const bareLiminaResolution = await resolveBareLimina(
        environment,
        outsideCwd,
      );

      expect(
        bareLiminaResolution.failed,
        `${bareLiminaResolution.stdout}\n${bareLiminaResolution.stderr}`,
      ).toBe(true);
      expect(bareLiminaResolution.code).toBeUndefined();

      const failedCheck = await runPnpm(
        [
          'exec',
          'limina',
          '--config',
          fixture.configPath,
          '--config-loader',
          'native',
          '--mode',
          MODE,
          'checker',
          'build',
        ],
        {
          cwd: fixture.fixtureDir,
          env: environment,
          reject: false,
          timeout: 180_000,
        },
      );

      expect(
        failedCheck.exitCode,
        `${failedCheck.stdout}\n${failedCheck.stderr}`,
      ).toBe(1);
      const invocationId =
        /Standalone issue invocation: ([0-9a-f-]+)/u.exec(
          failedCheck.stdout,
        )?.[1] ?? '';
      expect(invocationId).toMatch(INVOCATION_ID_PATTERN);
      const probeModulePath = await writeArgvProbe(outsideCwd);

      if (process.platform === 'win32') {
        const powershellCommand = extractGeneratedCommand(
          failedCheck.stdout,
          'PowerShell',
        );
        const cmdCommand = extractGeneratedCommand(
          failedCheck.stdout,
          'cmd.exe (/V:OFF)',
        );
        expect(powershellCommand).toMatch(/^pnpm /u);
        expect(cmdCommand).toMatch(/^pnpm /u);

        const cmdPnpm = await runCommand(
          'cmd.exe',
          ['/d', '/v:off', '/s', '/c', 'where.exe pnpm'],
          {
            cwd: outsideCwd,
            env: environment,
            timeout: 30_000,
          },
        );
        expect(cmdPnpm.stdout.toLowerCase()).toContain('pnpm.cmd');
        const selectedCmdPnpm = await runCommand(
          'cmd.exe',
          ['/d', '/v:off', '/s', '/c', 'for %I in (pnpm) do @echo %~$PATH:I'],
          {
            cwd: outsideCwd,
            env: environment,
            timeout: 30_000,
          },
        );
        expect(selectedCmdPnpm.stdout.toLowerCase()).toMatch(/pnpm\.cmd$/u);

        const windowsPowerShell = await getPowerShellEvidence(
          'powershell.exe',
          environment,
          outsideCwd,
        );
        const powerShellSeven = await getPowerShellEvidence(
          'pwsh.exe',
          environment,
          outsideCwd,
        );
        expect(windowsPowerShell.pnpmSource).toBeTruthy();
        expect(windowsPowerShell.version).toMatch(/^5\.1(?:\.|$)/u);
        expect(powerShellSeven.pnpmSource).toBeTruthy();
        expect(powerShellSeven.version).toMatch(/^7\./u);
        process.stdout.write(
          `[limina generated-command Windows evidence] ${JSON.stringify({
            cmdSelectedPnpm: selectedCmdPnpm.stdout,
            powershell5: windowsPowerShell,
            powershell7: powerShellSeven,
            wherePnpm: cmdPnpm.stdout.split(/\r?\n/u),
          })}\n`,
        );

        await assertGeneratedCommandRoundTrip({
          command: cmdCommand,
          environment,
          executable: 'cmd.exe',
          fixture,
          invocationId,
          outsideCwd,
          prefixArgs: ['/d', '/v:off', '/s', '/c'],
          probeModulePath,
          variantName: 'cmd-v-off',
        });
        await assertGeneratedCommandRoundTrip({
          command: powershellCommand,
          environment,
          executable: 'powershell.exe',
          fixture,
          invocationId,
          outsideCwd,
          prefixArgs: ['-NoProfile', '-Command'],
          probeModulePath,
          variantName: 'windows-powershell-5',
        });
        await assertGeneratedCommandRoundTrip({
          command: powershellCommand,
          environment,
          executable: 'pwsh.exe',
          fixture,
          invocationId,
          outsideCwd,
          prefixArgs: ['-NoProfile', '-Command'],
          probeModulePath,
          variantName: 'powershell-7',
        });
      } else {
        const command = extractGeneratedCommand(failedCheck.stdout, 'Query');
        expect(command).toMatch(/^pnpm /u);
        await assertGeneratedCommandRoundTrip({
          command,
          environment,
          executable: '/bin/sh',
          fixture,
          invocationId,
          outsideCwd,
          prefixArgs: ['-c'],
          probeModulePath,
          variantName: 'posix',
        });
      }
    } finally {
      if (fixture) {
        await fixture.cleanup();
      }
      await packedDist.cleanup();
      await rm(outsideCwd, { force: true, recursive: true });
    }
  }, 600_000);
});
