// SwiftMark driver: reads every case from /input/cases.json (or
// MAKEFUN_INPUT_DIR), renders each one alone with parse() from parse.js,
// and writes /output/html.json (or MAKEFUN_OUTPUT_DIR) as a JSON array of
// the HTML strings, in the cases' order.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
const n = cases.length;
for (let i = 0; i < n; i++) {
  html[i] = parse(cases[i].markdown);
}
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
