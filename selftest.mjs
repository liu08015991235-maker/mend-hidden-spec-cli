// selftest.mjs: a handful of checks for SPEC.md sentences the public practice set does not show, run the same way
// check.ts runs them (node main.ts in a fresh directory). `node selftest.mjs` prints one line per case.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

function run(files, argv, stdin = '') {
  const dir = mkdtempSync(join(tmpdir(), 'mend-self-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...argv], { cwd: dir, input: stdin, encoding: 'utf8' });
    const after = {};
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else after[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    return { exit: r.status, stdout: r.stdout, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let failed = 0;
const canon = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
function t(name, got, want) {
  const ok = got.exit === want.exit && got.stdout === want.stdout && canon(got.after) === canon(want.after);
  if (!ok) {
    failed += 1;
    console.log(`FAIL ${name}\n  got  exit ${got.exit} stdout ${JSON.stringify(got.stdout)} after ${JSON.stringify(got.after)}\n  want exit ${want.exit} stdout ${JSON.stringify(want.stdout)} after ${JSON.stringify(want.after)}`);
  } else {
    console.log(`ok ${name}`);
  }
}

// 1. An unsafe path in a SEARCH/REPLACE block fails that edit and writes nothing.
t('sr-unsafe', run({ 'p.patch': '../evil.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' }, ['p.patch']), {
  exit: 1, stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n',
  after: { 'p.patch': '../evil.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' },
});

// 2. A unified rename prints an R line, sorted by the new path among the other rows.
t('u-rename-sort', run({
  'a.txt': 'one\ntwo\n', 'b.txt': 'keep\n',
  'p.patch': '--- a/a.txt\n+++ b/z.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-keep\n+kept\n',
}, ['p.patch']), {
  exit: 0, stdout: 'M b.txt\nR a.txt -> z.txt\nok: 2 files\n',
  after: { 'b.txt': 'kept\n', 'z.txt': 'one\nTWO\n', 'p.patch': '--- a/a.txt\n+++ b/z.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-keep\n+kept\n' },
});

// 3. --check on a failing patch: exit 1 and the tree is untouched.
t('check-fail', run({ 'a.txt': 'x\n', 'p.patch': 'a.txt\n<<<<<<< SEARCH\nnope\n=======\ny\n>>>>>>> REPLACE\n' }, ['--check', 'p.patch']), {
  exit: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
  after: { 'a.txt': 'x\n', 'p.patch': 'a.txt\n<<<<<<< SEARCH\nnope\n=======\ny\n>>>>>>> REPLACE\n' },
});

// 4. A V4A update with Move to writes the updated lines at the new path and reports R.
t('v-move-update', run({
  'old.txt': 'alpha\nbeta\ngamma\n',
  'p.patch': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n alpha\n-beta\n+BETA\n gamma\n*** End Patch\n',
}, ['p.patch']), {
  exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n',
  after: { 'new.txt': 'alpha\nBETA\ngamma\n', 'p.patch': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n alpha\n-beta\n+BETA\n gamma\n*** End Patch\n' },
});

// 5. One failing edit of two: both are tried, nothing is written.
t('atomic-two-edits', run({
  'a.txt': 'x\n', 'b.txt': 'y\n',
  'p.patch': 'a.txt\n<<<<<<< SEARCH\nx\n=======\nX\n>>>>>>> REPLACE\n\nb.txt\n<<<<<<< SEARCH\nabsent\n=======\nY\n>>>>>>> REPLACE\n',
}, ['p.patch']), {
  exit: 1, stdout: 'error: no-match b.txt\nfailed: 1 of 2 edits\n',
  after: { 'a.txt': 'x\n', 'b.txt': 'y\n', 'p.patch': 'a.txt\n<<<<<<< SEARCH\nx\n=======\nX\n>>>>>>> REPLACE\n\nb.txt\n<<<<<<< SEARCH\nabsent\n=======\nY\n>>>>>>> REPLACE\n' },
});

// 6. JSON Lines read from standard input.
t('json-stdin', run({ 'a.txt': 'hello world\n' }, [], '{"command":"str_replace","path":"a.txt","old_str":"world","new_str":"mend"}\n'), {
  exit: 0, stdout: 'M a.txt\nok: 1 file\n', after: { 'a.txt': 'hello mend\n' },
});

// 7. A tier-2 SEARCH/REPLACE match re-indents the new lines to the file's own indent.
t('sr-tier2-reindent', run({
  'a.txt': 'if (x) {\n        run();\n}\n',
  'p.patch': 'a.txt\n<<<<<<< SEARCH\nrun();\n=======\nrun();\nlog();\n>>>>>>> REPLACE\n',
}, ['p.patch']), {
  exit: 0, stdout: 'M a.txt\nok: 1 file\n',
  after: { 'a.txt': 'if (x) {\n        run();\n        log();\n}\n', 'p.patch': 'a.txt\n<<<<<<< SEARCH\nrun();\n=======\nrun();\nlog();\n>>>>>>> REPLACE\n' },
});

// 8. Usage and no-patch errors.
t('usage', run({}, ['--format=bogus']), { exit: 2, stdout: 'error: usage\n', after: {} });
t('no-patch', run({}, ['gone.patch']), { exit: 2, stdout: 'error: no-patch\n', after: {} });
t('no-format', run({}, [], 'just some prose\n'), { exit: 2, stdout: 'error: format\n', after: {} });

// 9. A V4A patch with no End Patch names the line after the last.
t('v-parse-end', run({ 'p.patch': '*** Begin Patch\n*** Delete File: a.txt\n' }, ['p.patch']), {
  exit: 2, stdout: 'error: parse 3\n', after: { 'p.patch': '*** Begin Patch\n*** Delete File: a.txt\n' },
});

console.log(failed === 0 ? 'selftest: all passed' : `selftest: ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
