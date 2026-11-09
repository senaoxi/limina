import { spawn, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  type ModelProfile,
  verifyProfileBinary,
  verifyProfileCatalog,
} from '../core/model-profile.ts';
import { sha256 } from '../core/snapshot.ts';
import { preparePnpmTool } from './pnpm-tool.ts';

// Shared by native preflight and every formal slot; the raw pnpm stays file-only.
export function taskTools(workspace: string, node: string, pnpm: string) {
  const pnpmTools = preparePnpmTool(workspace, node, pnpm);
  return {
    readableToolRoots: [
      path.dirname(node),
      pnpm,
      '/System/Library/OpenSSL',
      pnpmTools,
    ],
    toolDirectories: [
      pnpmTools,
      path.dirname(node),
      path.dirname(pnpm),
      path.join(workspace, 'node_modules/.bin'),
    ],
  };
}

export interface CodexIdentity {
  executable: string;
  version: '0.166.0';
  sha256: string;
  codeModeHostSha256: string;
}

/**
Construct rather than filter the inherited environment: provider keys, proxy
credentials, Docker sockets, NODE_OPTIONS and shell startup hooks never pass.
*/
export function codexEnvironment(
  home: string,
  temporaryDirectory: string,
  toolDirectories: string[],
  clientHome = temporaryDirectory,
): NodeJS.ProcessEnv {
  const codexHome = path.join(clientHome, 'codex-home');
  if (codexHome === path.join(home, '.codex'))
    throw new Error('Agent configuration home must be isolated');
  return {
    HOME: clientHome,
    CODEX_HOME: codexHome,
    TMPDIR: temporaryDirectory,
    PATH: [...toolDirectories, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
      path.delimiter,
    ),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    npm_config_verify_deps_before_run: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_offline: 'true',
  };
}

// Delegate only the existing credential file, never the host instruction/config tree.
export function prepareCodexHome(
  authHome: string,
  environment: NodeJS.ProcessEnv,
) {
  const home = environment.CODEX_HOME;
  if (!home || !path.isAbsolute(home) || home === path.join(authHome, '.codex'))
    throw new Error('A separate controller-owned Codex home is required');
  const auth = path.join(authHome, '.codex/auth.json');
  if (
    realpathSync(auth) !== auth ||
    !lstatSync(auth).isFile() ||
    (lstatSync(auth).mode & 0o022) !== 0
  )
    throw new Error('Canonical host authentication file required');
  mkdirSync(home, { mode: 0o700 });
  if (realpathSync(home) !== home) throw new Error('Aliased Codex home');
  const delegated = path.join(home, 'auth.json');
  symlinkSync(auth, delegated);
  const assertClean = () => {
    if (
      !lstatSync(delegated).isSymbolicLink() ||
      readlinkSync(delegated) !== auth
    )
      throw new Error('Isolated authentication delegate changed');
    for (const name of [
      'AGENTS.md',
      'AGENTS.override.md',
      'config.toml',
      'instructions.md',
      'skills',
      'plugins',
    ]) {
      try {
        lstatSync(path.join(home, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error(
        'Unexpected instructions or configuration in isolated Codex home',
      );
    }
  };
  assertClean();
  return {
    policy: 'isolated-auth-only-v1' as const,
    assertClean,
    dispose() {
      // Unlink the delegate itself; never follow it or remove host credentials.
      try {
        unlinkSync(delegated);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

export function hasAgentInstructions(input: unknown): boolean {
  return (
    Array.isArray(input) &&
    input.some(
      (item: { role?: string; content?: { text?: unknown }[] } | null) =>
        item !== null &&
        typeof item === 'object' &&
        item.role === 'user' &&
        Array.isArray(item.content) &&
        item.content.some(
          (part) =>
            typeof part.text === 'string' &&
            part.text.trimStart().startsWith('# AGENTS.md instructions'),
        ),
    )
  );
}

// Native context assembly without starting a turn or inference.
export function verifyPromptInput(
  identity: CodexIdentity,
  environment: NodeJS.ProcessEnv,
  workspace: string,
  prompt: string,
  roots: string[],
  disabledSkills: string[] = [],
  profile?: ModelProfile,
) {
  verifyCodex(identity, environment);
  const result = spawnSync(
    identity.executable,
    [
      '-C',
      workspace,
      'debug',
      'prompt-input',
      ...workspaceOverrides(workspace, roots, disabledSkills, profile).flatMap(
        (value) => ['-c', value],
      ),
      prompt,
    ],
    {
      // Inspection creates a zero-inference rollout. Keep it out of the actual
      // attempt's single-session native trace, which is validated independently.
      env: { ...environment, CODEX_ROLLOUT_TRACE_ROOT: undefined },
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error('Native prompt-input inspection failed');
  const inputs: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(inputs) || hasAgentInstructions(inputs))
    throw new Error('Unexpected Agent instructions in native prompt input');
  return {
    policy: 'isolated-auth-only-v1' as const,
    inputDigest: sha256(result.stdout),
  };
}

export function verifyCodex(
  identity: CodexIdentity,
  environment: NodeJS.ProcessEnv,
): void {
  if (
    !path.isAbsolute(identity.executable) ||
    realpathSync(identity.executable) !== identity.executable ||
    !statSync(identity.executable).isFile()
  )
    throw new Error(
      'Codex must be an absolute native executable, not a launcher or symlink',
    );
  if (sha256(readFileSync(identity.executable)) !== identity.sha256)
    throw new Error('Codex binary identity changed');
  const helper = path.join(
    path.dirname(identity.executable),
    'codex-code-mode-host',
  );
  if (
    realpathSync(helper) !== helper ||
    sha256(readFileSync(helper)) !== identity.codeModeHostSha256
  )
    throw new Error('Codex Code Mode host identity changed');
  const result = spawnSync(identity.executable, ['--version'], {
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (
    result.status !== 0 ||
    result.stdout.trim() !== `codex-cli ${identity.version}`
  )
    throw new Error('Codex version check failed');
}

const disabledFeatures = [
  'multi_agent',
  'multi_agent_v2',
  'multi_agent_v2_dynamic_tools',
  'fast_mode',
  'ultrafast_mode',
  'daemon_auto_start',
  'apps',
  'plugins',
  'plugin_discovery_prefetch',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'memories',
  'skill_mcp_dependency_install',
  'shell_snapshot',
  'api_key_model_discovery',
  'code_mode',
  'code_mode_tool_search',
  'goals',
  'hooks',
  'guardian_approval',
  'in_app_chat',
  'in_app_local_automation',
  'in_app_voice',
  'browser_use_full_cdp_access',
];

/**
No legacy --sandbox flag: it would override the restricted permission profile.
This profile grants workspace writes, denies host reads and denies tool network.
*/
export function localCodexConfig(
  readableToolRoots: string[],
  disabledSkillPaths: string[] = [],
  profile?: ModelProfile,
): string[] {
  for (const root of readableToolRoots) {
    if (
      root === '/' ||
      root === '/Users' ||
      root === '/home' ||
      !path.isAbsolute(root)
    )
      throw new Error('Unsafe toolchain read root');
  }
  return [
    'model_provider="openai"',
    'forced_login_method="chatgpt"',
    `model=${JSON.stringify(profile?.canonicalModelId ?? 'gpt-6.1-terra')}`,
    `model_reasoning_effort=${JSON.stringify(profile?.reasoningEffort ?? 'high')}`,
    'service_tier="default"',
    ...(profile
      ? [
          `model_context_window=${profile.execution.contextWindow}`,
          `model_auto_compact_token_limit=${profile.execution.autoCompactTokenLimit}`,
        ]
      : []),
    'approval_policy="never"',
    'approvals_reviewer="user"',
    'default_permissions="limina-eval"',
    `permissions={limina-eval={extends=":workspace",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"${readableToolRoots.map((root) => `,${JSON.stringify(root)}="read"`).join('')}},network={enabled=false}}}`,
    'mcp_servers={computer-use={enabled=false,command="/usr/bin/false"},node_repl={enabled=false,command="/usr/bin/false"}}',
    'features.code_mode_host=true',
    'features.shell_tool=true',
    'features.unified_exec=true',
    'agents.enabled=false',
    `skills={bundled={enabled=false},config=[${disabledSkillPaths.map((skillPath) => `{path=${JSON.stringify(skillPath)},enabled=false}`).join(',')}]}`,
    'web_search="disabled"',
    'allow_login_shell=false',
    'shell_environment_policy.set={npm_config_verify_deps_before_run="false",npm_config_ignore_scripts="true",npm_config_offline="true"}',
    'project_doc_max_bytes=0',
    'features.skip_host_skill_discovery=true',
    'analytics.enabled=false',
    'feedback.enabled=false',
    ...disabledFeatures.map((feature) => `features.${feature}=false`),
  ];
}

function workspaceOverrides(
  workspace: string,
  readableToolRoots: string[],
  disabledSkillPaths: string[] = [],
  profile?: ModelProfile,
): string[] {
  return [
    ...localCodexConfig(
      [
        ...new Set([
          ...readableToolRoots,
          path.join(workspace, '.agents'),
          path.join(workspace, 'node_modules'),
        ]),
      ],
      disabledSkillPaths,
      profile,
    ),
    `shell_environment_policy.set.TMPDIR=${JSON.stringify(path.join(workspace, '.eval-tmp'))}`,
  ];
}

export function localCodexArguments(
  workspace: string,
  readableToolRoots: string[],
  disabledSkillPaths: string[] = [],
  profile?: ModelProfile,
): string[] {
  return [
    '--no-daemon',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--ephemeral',
    '--json',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-C',
    workspace,
    ...workspaceOverrides(
      workspace,
      readableToolRoots,
      disabledSkillPaths,
      profile,
    ).flatMap((value) => ['-c', value]),
    '-',
  ];
}

/**
Parse the exact invocation overrides without authentication or model calls.
*/
export function verifyLocalConfig(
  identity: CodexIdentity,
  controllerDirectory: string,
  readableToolRoots: string[],
  disabledSkillPaths: string[],
  workspace: string,
  profile?: ModelProfile,
): void {
  const emptyHome = mkdtempSync(
    path.join(controllerDirectory, 'config-preflight-'),
  );
  try {
    const result = spawnSync(
      identity.executable,
      [
        'app-server',
        '--strict-config',
        '--stdio',
        ...workspaceOverrides(
          workspace,
          readableToolRoots,
          disabledSkillPaths,
          profile,
        ).flatMap((value) => ['-c', value]),
      ],
      {
        env: {
          HOME: emptyHome,
          CODEX_HOME: emptyHome,
          PATH: '/usr/bin:/bin',
          TMPDIR: emptyHome,
        },
        input: '',
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Isolated Codex configuration rejected: ${result.stderr.slice(0, 2000)}`,
      );
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
}

export interface AccountObservation {
  skills: { path: string; name: string; enabled: boolean }[] | null;
  observedAt: string;
  auth: { type: string | null; planType: string | null };
  ordinaryUsageAllowed: boolean | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  primary: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  spendControlReached: boolean | null;
  model: {
    model: string;
    supportedReasoningEfforts: { reasoningEffort: string }[];
  } | null;
}

/**
Read-only app-server methods use the CLI's own OAuth handling. Raw account
responses and notifications (including identifying fields) are never returned.
*/
export async function inspectAccount(
  identity: CodexIdentity,
  environment: NodeJS.ProcessEnv,
  discovery?: { workspace: string; disabledSkillPaths: string[] },
  profile?: ModelProfile,
): Promise<AccountObservation> {
  verifyCodex(identity, environment);
  const child = spawn(
    identity.executable,
    [
      'app-server',
      '--stdio',
      ...localCodexConfig([], discovery?.disabledSkillPaths, profile).flatMap(
        (value) => ['-c', value],
      ),
    ],
    { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  child.stderr.resume();
  const pending = new Map<
    number,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
    }
  >();
  let sequence = 0;
  const fail = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.on('error', fail);
  child.on('close', () => fail(new Error('Account inspection process closed')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message: {
      id?: number;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) {
      const category = /429|too many requests|rate.limit/i.test(
        message.error.message ?? '',
      )
        ? 'rate_limit'
        : /timeout|timed out/i.test(message.error.message ?? '')
          ? 'timeout'
          : /401|403|unauthorized|credential/i.test(message.error.message ?? '')
            ? 'authentication'
            : /connect|network|TLS|certificate/i.test(
                  message.error.message ?? '',
                )
              ? 'network'
              : 'unknown';
      entry.reject(
        new Error(
          `Read-only account RPC ${entry.method} failed: ${message.error.code} (${category})`,
        ),
      );
    } else entry.resolve(message.result);
  });
  const request = (method: string, parameters: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { method, resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ id, method, params: parameters })}\n`,
      );
    });
  const timeout = setTimeout(() => {
    fail(new Error('Account inspection timed out'));
    child.kill('SIGKILL');
  }, 45_000);
  try {
    await request('initialize', {
      clientInfo: { name: 'limina_evals_preflight', version: '1' },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const account = (await request('account/read', {
      refreshToken: false,
    })) as { account?: { type?: string; planType?: string } };
    if (account.account?.type !== 'chatgpt')
      throw new Error(
        'ChatGPT OAuth login required; API-key fallback is forbidden',
      );
    const limits = (await request('account/rateLimits/read', {})) as {
      ordinaryUsageAllowed?: boolean;
      rateLimits: Omit<
        AccountObservation,
        'auth' | 'model' | 'observedAt' | 'ordinaryUsageAllowed'
      >;
    };
    let cursor: string | null = null;
    let model: AccountObservation['model'] = null;
    do {
      const page = (await request('model/list', {
        limit: 100,
        includeHidden: false,
        cursor,
      })) as {
        data: NonNullable<AccountObservation['model']>[];
        nextCursor?: string | null;
      };
      const match = page.data.find(
        (entry) =>
          entry.model === (profile?.canonicalModelId ?? 'gpt-6.1-terra'),
      );
      if (match && model) throw new Error('Ambiguous model discovery');
      if (match)
        model = {
          model: match.model,
          supportedReasoningEfforts: match.supportedReasoningEfforts.map(
            ({ reasoningEffort }) => ({ reasoningEffort }),
          ),
        };
      cursor = page.nextCursor ?? null;
    } while (cursor);
    let skills: AccountObservation['skills'] = null;
    if (discovery) {
      const response = (await request('skills/list', {
        cwds: [discovery.workspace],
        forceReload: true,
      })) as {
        data: {
          errors: unknown[];
          skills: NonNullable<AccountObservation['skills']>;
        }[];
      };
      if (
        response.data.length !== 1 ||
        response.data.some((entry) => entry.errors.length > 0)
      )
        throw new Error('Native Skill discovery failed');
      skills = response.data.flatMap((entry) =>
        entry.skills.map(({ path, name, enabled }) => ({
          path,
          name,
          enabled,
        })),
      );
    }
    return {
      skills,
      observedAt: new Date().toISOString(),
      auth: {
        type: account.account.type,
        planType: account.account.planType ?? null,
      },
      ordinaryUsageAllowed: limits.ordinaryUsageAllowed ?? null,
      credits: limits.rateLimits.credits ?? null,
      primary: limits.rateLimits.primary ?? null,
      individualLimit: limits.rateLimits.individualLimit ?? null,
      spendControlReached: limits.rateLimits.spendControlReached ?? null,
      model,
    };
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
    await closed;
    clearTimeout(kill);
  }
}

export function verifyPinnedModelCatalog(
  identity: CodexIdentity,
  environment: NodeJS.ProcessEnv,
  profile: ModelProfile,
): void {
  verifyProfileBinary(profile, identity);
  verifyCodex(identity, environment);
  const result = spawnSync(
    identity.executable,
    ['debug', 'models', '--bundled'],
    {
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error)
    throw new Error('Pinned catalog discovery failed');
  const catalog = JSON.parse(result.stdout) as {
    models: Record<string, unknown>[];
  };
  verifyProfileCatalog(profile, catalog.models);
}
