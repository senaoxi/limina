import semver from 'semver';

function fail(message) {
  throw new Error(message);
}

function checkLowercaseStart(text, name) {
  if (!/^[a-z]/u.test(text))
    fail(`${name} must start with a lowercase English word`);
}

function checkRelease(lines) {
  const release = /^release: limina@(\S+), migrate@(\S+)$/u.exec(lines[0]);
  if (
    !release ||
    lines.length !== 1 ||
    release[1] !== release[2] ||
    !/^\d/u.test(release[1]) ||
    !semver.valid(release[1])
  )
    fail(
      'release messages must use the generated same-version limina/migrate pair',
    );
}

function checkBody(lines, isRevert) {
  if (isRevert && lines.length === 0)
    fail(
      'reverts must describe the reverted commit and reason in body bullets',
    );
  for (const line of lines) {
    if (!line.startsWith('- '))
      fail(
        'each body line must be a consecutive "- " bullet without blank or continuation lines',
      );
    const detail = line.slice(2);
    checkLowercaseStart(detail, 'body bullets');
    if (detail.endsWith('.')) fail('body bullets must not end with a period');
  }
}

function checkFooter(lines) {
  checkLowercaseStart(
    lines[0].slice('BREAKING CHANGE: '.length),
    'breaking descriptions',
  );
  for (const line of lines.slice(1)) {
    if (!line || /^(?:[-*] |\d+[.)] |BREAKING CHANGE:)/u.test(line))
      fail(
        'breaking footer continuation lines must be plain text without blank lines',
      );
  }
}

function checkLayout(parsed) {
  const lines = parsed.raw.replaceAll('\r\n', '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  if (lines.some((line) => /\p{Cc}/u.test(line) || line.trimEnd() !== line))
    fail(
      'message lines must not contain control characters or trailing whitespace',
    );
  if (parsed.type === 'release') {
    checkRelease(lines);
    return;
  }
  if (lines[0] !== parsed.header || !parsed.type || !parsed.subject)
    fail('use type(scope)!: subject with an optional "revert: " prefix');
  if (parsed.scope && parsed.scope.trim() !== parsed.scope)
    fail('scopes must not have surrounding whitespace');
  if (lines.length > 1 && (lines[1] !== '' || lines[2] === ''))
    fail('leave exactly one blank line after the title');

  const footerIndex = lines.findIndex((line) =>
    line.startsWith('BREAKING CHANGE: '),
  );
  if (Boolean(parsed.breaking) !== (footerIndex !== -1))
    fail('the ! marker and a BREAKING CHANGE: footer must appear together');
  const isRevert = parsed.header.startsWith('revert: ');
  if (footerIndex === -1) {
    checkBody(lines.slice(2), isRevert);
    return;
  }
  if (lines[footerIndex - 1] !== '')
    fail('leave exactly one blank line before the breaking footer');
  checkBody(lines.slice(2, footerIndex === 2 ? 2 : footerIndex - 1), isRevert);
  checkFooter(lines.slice(footerIndex));
}

function layoutRule(parsed) {
  try {
    checkLayout(parsed);
    return [true];
  } catch (error) {
    return [false, error.message];
  }
}

export default {
  extends: ['@commitlint/config-conventional'],
  defaultIgnores: false,
  parserPreset: {
    parserOpts: {
      headerPattern: /^(?:revert: )?([a-z]+)(?:\(([^()]+)\))?(!)?: (.+)$/u,
      headerCorrespondence: ['type', 'scope', 'breaking', 'subject'],
      noteKeywords: ['BREAKING CHANGE'],
    },
  },
  plugins: [
    {
      rules: {
        'limina-layout': layoutRule,
        'subject-lowercase-start': ({ subject }) => [
          !subject || /^[a-z]/u.test(subject),
          'subjects must start with a lowercase English word',
        ],
        'subject-character-limit': ({ subject, type }, _when, maximum) => [
          type === 'release' || !subject || [...subject].length <= maximum,
          `subjects must contain 1-${maximum} characters, excluding type, scope and !`,
        ],
        'body-footer-character-limit': ({ raw }, _when, maximum) => [
          raw
            .replaceAll('\r\n', '\n')
            .split('\n')
            .slice(1)
            .every((line) => [...line].length <= maximum),
          `body and footer lines must not exceed ${maximum} characters, including prefixes`,
        ],
      },
    },
  ],
  rules: {
    // Header length is governed by the subject limit, excluding type, scope and !.
    'header-max-length': [0],
    // Count raw body/footer characters without upstream URL exemptions or parser omissions.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'subject-case': [0],
    // The raw layout rule owns exact separators and the breaking footer spelling.
    'body-leading-blank': [0],
    'footer-leading-blank': [0],
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        // Only the exact generated pair passes limina-layout.
        'release',
      ],
    ],
    'limina-layout': [2, 'always'],
    'subject-lowercase-start': [2, 'always'],
    'subject-character-limit': [2, 'always', 50],
    'body-footer-character-limit': [2, 'always', 100],
  },
};
