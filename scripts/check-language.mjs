#!/usr/bin/env node
/**
 * Fails when a tracked file contains CJK characters outside the whitelist.
 *
 * This is the rule most likely to be broken in a hurry, and breaking it
 * produces no symptom at all: the code runs perfectly with Chinese comments
 * in it. Only a check holds the line (spec 13.1, 13.3).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = [
  /^spec\.md$/,
  /^packages\/shared\/src\/i18n\/zh-TW\.ts$/,
  /^packages\/[^/]+\/test\/fixtures\/user-content\.ts$/,
];

/**
 * Code point ranges, not a literal character class: writing the ranges as
 * characters would put CJK into this very file and trip the check it runs.
 */
const RANGES = [
  [0x3040, 0x30ff], // kana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xf900, 0xfaff], // compatibility ideographs
];

function hasCjk(line) {
  for (const character of line) {
    const point = character.codePointAt(0);
    if (point === undefined) continue;
    for (const [low, high] of RANGES) {
      if (point >= low && point <= high) return true;
    }
  }
  return false;
}

// Untracked files count too. Scanning only what git already knows about
// means a new file is checked for the first time *after* it was committed,
// which is exactly one commit too late. `--exclude-standard` keeps ignored
// build output and the local database out of it.
const tracked = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((path) => /\.(ts|tsx|js|jsx|mjs|json|md|css|html|yml|yaml|sql|sh)$/.test(path));

const offenders = [];

for (const path of tracked) {
  if (ALLOWED.some((pattern) => pattern.test(path))) continue;

  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    continue;
  }

  for (const [index, line] of contents.split('\n').entries()) {
    if (hasCjk(line)) offenders.push(`${path}:${index + 1}: ${line.trim().slice(0, 70)}`);
  }
}

if (offenders.length > 0) {
  console.error('Chinese text found outside the whitelist:\n');
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error('\nInterface copy belongs in packages/shared/src/i18n/zh-TW.ts.');
  process.exit(1);
}

console.log(`Language check passed (${tracked.length} files scanned).`);
