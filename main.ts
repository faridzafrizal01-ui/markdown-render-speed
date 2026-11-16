// SwiftMark driver: the program the harness runs with Node 22.
//
// It renders the whole scored set. The harness mounts the cases at
// /input/cases.json (a JSON array of {id, markdown}) and expects the HTML
// back at /output/html.json (a JSON array of strings, one per case, in
// the cases' order). When run outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output, so the same file
// can be exercised locally against a practice set.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

function dirFromEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const inputDir = dirFromEnv('MAKEFUN_INPUT_DIR', '/input');
const outputDir = dirFromEnv('MAKEFUN_OUTPUT_DIR', '/output');

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as Array<{ id: string; markdown: string }>;

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  // A case without a markdown string renders as empty output rather
  // than crashing the whole run.
  rendered[i] = parse(cases[i].markdown ?? '');
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
