import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';

// const lastArg = process.argv[process.argv.length - 1];
const testFile = process.argv[2] || 'tests/engine.test.ts';
// const testFile = lastArg || 'tests/engine.test.ts';
const testOnly = process.argv.length > 2 ? process.argv[3] : '';
// --test-only
let testOnlyArr = testOnly ? (testOnly === '--test-only' ? ['--test-only'] : ['--test-name-pattern', testOnly] ) : [];
const outfile = 'tests/.bundle.test.mjs';

// 1. Bundle target test file
await build({
  entryPoints: [testFile],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { obsidian: './tests/mocks/obsidian.ts' },
  outfile,
});

// 2. Run with Node's native runner
const result = spawnSync(process.execPath, [...testOnlyArr, '--test', outfile], { stdio: 'inherit' });
process.exit(result.status ?? 1);

// run command: node scripts/run-test.mjs -- tests/activity-tracker.test.ts
