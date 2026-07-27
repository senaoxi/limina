import type {
  SourceFindingFactsByCode,
  SourceFindingForCode,
  SourceStructuredIssueCode,
} from './findings';

function getOwnerName(ownerName: string | undefined): string {
  return ownerName ?? '<workspace>';
}

function getToolName(tool: string | undefined): string {
  return tool ?? 'limina';
}

function getFixSteps(fix: string | undefined): string[] | undefined {
  return fix ? [fix] : undefined;
}

export function createSourceDiagnosticFinding<
  Code extends SourceStructuredIssueCode,
>(options: {
  checkerName?: string;
  code: Code;
  detailLines?: readonly string[];
  external?: SourceFindingForCode<Code>['external'];
  facts: SourceFindingFactsByCode[Code];
  filePath?: string;
  fix?: string;
  lines: readonly string[];
  locations?: SourceFindingForCode<Code>['locations'];
  ownerName?: string;
  packageJsonPath?: string;
  reason: string;
  scope?: string;
  title: string;
  tool?: string;
}): SourceFindingForCode<Code> {
  return {
    checkerName: options.checkerName,
    code: options.code,
    detailLines: options.detailLines,
    detector: 'source',
    evidence: [{ label: 'diagnostic', lines: [...options.lines] }],
    external: options.external,
    facts: options.facts,
    filePath: options.filePath,
    fix: options.fix,
    fixSteps: getFixSteps(options.fix),
    locations: options.locations,
    ownerName: getOwnerName(options.ownerName),
    packageJsonPath: options.packageJsonPath,
    reason: options.reason,
    scope: options.scope,
    summary: options.title,
    task: 'source:check',
    title: options.title,
    tool: getToolName(options.tool),
    verifyCommands: ['limina source check'],
  } as SourceFindingForCode<Code>;
}
