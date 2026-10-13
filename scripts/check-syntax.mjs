#!/usr/bin/env node
// Syntax check: parses every project JS file as an ES module using `node --check`.
// Any syntax error, duplicate declaration or stray PHP-era code fails the run.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['js', 'scripts', 'tests'];
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(name)) files.push(p);
  }
}

for (const r of roots) {
  try { walk(r); } catch { /* directory may not exist yet */ }
}

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`ok    ${f}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${f}\n${err.stderr || err.stdout || err.message}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} files passed syntax check`);
process.exit(failed ? 1 : 0);
