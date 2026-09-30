const severities = ['info', 'low', 'moderate', 'high', 'critical'] as const;
type Severity = (typeof severities)[number];

export interface AuditFinding {
  package: string;
  severity: Severity;
  title: string;
  url: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  counts: Record<Severity, number>;
  failed: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Audit output must contain JSON objects.');
  }
  return value as Record<string, unknown>;
}

export function analyzeAuditOutput(
  output: string,
  exitCode: number,
): AuditReport {
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`Audit command failed with exit code ${exitCode}.`);
  }
  const input = record(JSON.parse(output));
  if (input.error || !Object.hasOwn(input, 'advisories')) {
    throw new Error('Audit did not return the supported pnpm advisory report.');
  }
  const metadata = record(input.metadata);
  const metadataCounts = record(metadata.vulnerabilities);
  for (const severity of severities) {
    if (
      !Number.isSafeInteger(metadataCounts[severity]) ||
      Number(metadataCounts[severity]) < 0
    ) {
      throw new Error('Audit vulnerability metadata is incomplete or invalid.');
    }
  }
  const findings = Object.values(record(input.advisories)).map(
    (value): AuditFinding => {
      const advisory = record(value);
      const { module_name: packageName, severity, title, url } = advisory;
      if (
        typeof packageName !== 'string' ||
        typeof severity !== 'string' ||
        typeof title !== 'string' ||
        typeof url !== 'string' ||
        !packageName ||
        !title ||
        !severities.includes(severity as Severity) ||
        !/^https:\/\//u.test(url)
      ) {
        throw new Error(
          'Audit advisory is incomplete or has an unknown severity.',
        );
      }
      return {
        package: packageName,
        severity: severity as Severity,
        title,
        url,
      };
    },
  );
  if (exitCode === 1 && findings.length === 0) {
    throw new Error('Audit failed without any usable advisory details.');
  }
  const counts: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const finding of findings) counts[finding.severity]++;
  return { findings, counts, failed: counts.high > 0 || counts.critical > 0 };
}

function clean(text: string): string {
  return text.replaceAll(/[|\r\n`<>]/gu, ' ');
}

export function formatAuditReport(report: AuditReport): string {
  return [
    '# Dependency audit',
    '',
    'Counts use returned advisory entries after pnpm exclusions. Registry metadata may include excluded advisories.',
    '',
    `Gate: ${report.failed ? 'FAIL (high or critical findings)' : 'PASS'}`,
    '',
    '| Severity | Advisory count |',
    '| --- | ---: |',
    ...severities.map(
      (severity) => `| ${severity} | ${report.counts[severity]} |`,
    ),
    '',
    '| Package | Severity | Advisory |',
    '| --- | --- | --- |',
    ...report.findings.map(
      (finding) =>
        `| ${clean(finding.package)} | ${finding.severity} | ${clean(finding.title)} |`,
    ),
    '',
    'Advisory URLs and raw output are retained in the JSON reports. Existing exclusions live in pnpm-workspace.yaml; this command adds none.',
    '',
  ].join('\n');
}
