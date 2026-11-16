// A fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
//
// Written from scratch for the markdown-render-speed competition. It
// reproduces, byte for byte, the HTML that marked 18.1.3 produces with its
// default options (gfm on, breaks off, pedantic off, async off). Where
// marked's behaviour departs from the spec text, this file follows marked:
// the reference implementation is the spec here.
//
// Architecture (my own take on the classic two-phase design):
//   1. Block lexing turns the source into a flat token list. Inline
//      content is not tokenised yet: each block token that carries inline
//      text only records the raw string in a queue.
//   2. Once every block (and therefore every link reference definition)
//      is known, the queued inline strings are tokenised in order.
//   3. A small renderer walks the token trees and emits HTML strings.
//
// parse() is pure: it keeps no state between calls and reads no
// environment, clock or network. Every regular expression below is a
// module-level constant so nothing is recompiled per call.

/* ------------------------------------------------------------------ */
/* Small string helpers                                                */
/* ------------------------------------------------------------------ */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeReplacement = (ch) => ESCAPE_MAP[ch];

const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Escape a string for HTML. With `encode`, every `&` becomes `&amp;`;
 *  without it, an `&` that already starts a character reference is left. */
function escapeHtml(text, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(text)) return text.replace(ESCAPE_REPLACE, escapeReplacement);
  } else if (ESCAPE_TEST_NO_ENCODE.test(text)) {
    return text.replace(ESCAPE_REPLACE_NO_ENCODE, escapeReplacement);
  }
  return text;
}

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Turn numeric character references into the characters they name.
 *  Zero, out-of-range and surrogate values become U+FFFD; a bare `&`
 *  that is not part of a reference becomes `&amp;` so it cannot join its
 *  neighbours into a new reference. */
function decodeNumericRefs(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

/** Percent-encode a link destination the way a browser would, keeping
 *  literal `%` characters. Returns null when the URL cannot be encoded. */
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

/** Split one table row on its unescaped pipes, trimming cells and
 *  padding/truncating to `count` columns when asked. */
function splitCells(rowText, count) {
  const row = rowText.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

/** Remove a trailing run of `c` characters (or, with `invert`, of
 *  characters that are not `c`). Written as a loop: /c*$/ backtracks. */
function rtrim(str, c, invert) {
  const len = str.length;
  if (len === 0) return '';
  let suffLen = 0;
  while (suffLen < len) {
    const ch = str.charAt(len - suffLen - 1);
    if (ch === c && !invert) suffLen++;
    else if (ch !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, len - suffLen);
}

/** Drop trailing blank lines, but keep a single one when that is all
 *  there is (a code block keeps its final newline that way). */
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

/** Normalise a link label for definition/reference matching: trim,
 *  collapse inner whitespace to one space, and Unicode case-fold by
 *  round-tripping through upper case (so `ẞ` meets `SS`). */
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Index of the closing bracket that balances the first opening one in
 *  `str`, or -1 when there is none and -2 when opens outnumber closes. */
function findClosingBracket(str, brackets) {
  if (str.indexOf(brackets[0]) === -1 && str.indexOf(brackets[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === brackets[0]) level++;
    else if (str[i] === brackets[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

/** Expand tabs to spaces, tracking the column from `indent`. */
function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

/* ------------------------------------------------------------------ */
/* Emphasis closer hints                                               */
/*                                                                     */
/* Scanning a masked inline source once for the last `*` / `_` run    */
/* that can close emphasis and the last `~` run that can close         */
/* strikethrough lets every opener in the run bail out early when     */
/* there is nothing left that could close it. A run can close only     */
/* when it is not preceded by whitespace or the start of the string.   */
/* Frames are stacked because inline tokenising nests (link labels,   */
/* emphasis contents) and popped when a pass ends.                     */
/* ------------------------------------------------------------------ */

function scanClosers(src) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm, lastDel };
}

/* ------------------------------------------------------------------ */
/* Grammar                                                             */
/*                                                                     */
/* The patterns below are the CommonMark 0.31.2 + GFM 0.29 grammar as  */
/* realised by the reference implementation. Several of them are built */
/* by splicing smaller pieces into a template; a piece that starts     */
/* with a `^` anchor loses it when spliced into the middle of a larger */
/* pattern, exactly as the reference grammar builder does.             */
/* ------------------------------------------------------------------ */

// Splice `parts` ([name, value] pairs, in order) into `template` and
// return the resulting RegExp. `name` may be a string (first occurrence
// only) or a RegExp (all matches when global).
const CARET_STRIP = /(^|[^\[])\^/g;
function compose(template, parts, flags = '') {
  let src = typeof template === 'string' ? template : template.source;
  for (const [name, val] of parts) {
    let v = typeof val === 'string' ? val : val.source;
    v = v.replace(CARET_STRIP, '$1');
    src = src.replace(name, v);
  }
  return new RegExp(src, flags);
}

// A regex factory cached by indent level (0..3): the same pattern is
// used with `{0,0}` .. `{0,3}` depending on how far the list item or
// block is indented, and indent 4+ behaves like 3.
function indentCached(build) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) {
      re = build(idx);
      cache[idx] = re;
    }
    return re;
  };
}

// Block tag names that may open an HTML block (CommonMark §4.6).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const INLINE_COMMENT = compose(HTML_COMMENT, [['(?:-->|$)', '-->']]);

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  // A setext underline line inside a paragraph's text.
  lheadingProbe: /\n {0,3}(=+|-+)[ \t]*(?:\n|$)/,
  blockquoteStart: /^ {0,3}>/,
  // Neutralise a lazy setext underline (one may end with tabs).
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: NUMERIC_REF,
  numericCharacterReferenceOrAmpersand: NUMERIC_REF_OR_AMP,
  escapeTest: ESCAPE_TEST,
  escapeReplace: ESCAPE_REPLACE,
  escapeTestNoEncode: ESCAPE_TEST_NO_ENCODE,
  escapeReplaceNoEncode: ESCAPE_REPLACE_NO_ENCODE,
  caret: CARET_STRIP,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: indentCached((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: indentCached((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: indentCached((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: indentCached((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: indentCached((i) => new RegExp(`^ {0,${i}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: indentCached((i) => new RegExp(`^ {0,${i}}>`)),
};

/* ---- Block grammar ---- */

const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_TEXT = /^[^\n]+/;

// A link label: no unescaped `]` inside, may span lines but not blank ones.
const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

const BLOCK_DEF = compose(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
  [
    ['label', BLOCK_LABEL],
    // An escaped delimiter belongs to the title, so a backslash consumes
    // the next character; an optional closer lets that character
    // backtrack into the closing quote.
    ['title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/],
  ],
);

const BLOCK_LIST = compose(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, [[/bull/g, BULLET]]);

const BLOCK_HTML = compose(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' // (1)
  + '|comment[^\\n]*(\\n+|$)' // (2)
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' // (3)
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' // (4)
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' // (5)
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (6)
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) open tag
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) closing tag
  + ')',
  [
    ['comment', HTML_COMMENT],
    ['tag', BLOCK_TAGS],
    ['attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/],
  ],
  'i',
);

// Setext underline: the text may not start with something that is itself
// a block start, and a line inside it may not start a new block either.
const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
function buildLheading(tablePart) {
  return compose(LHEADING_CORE, [
    [/bull/g, BULLET],
    [/blockCode/g, /(?: {4}| {0,3}\t)/],
    [/fences/g, / {0,3}(?:`{3,}|~{3,})/],
    [/blockquote/g, / {0,3}>/],
    [/heading/g, / {0,3}#{1,6}(?:\s|$)/],
    [/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
    [/html/g, / {0,3}<[^\n>]+>\n/],
    tablePart,
  ]);
}
const BLOCK_LHEADING = buildLheading([/\|table/g, '']);

// A paragraph stops at a line that starts another block. GFM adds tables
// to the list of interrupters; a setext underline never interrupts.
const PARAGRAPH_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listInterrupt, tablePart) {
  return compose(PARAGRAPH_CORE, [
    ['hr', BLOCK_HR],
    ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
    ['|lheading', ''],
    tablePart,
    ['blockquote', ' {0,3}>'],
    ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
    ['list', listInterrupt],
    ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
    ['tag', BLOCK_TAGS],
  ]);
}
// Only non-empty lists starting from 1 can interrupt a paragraph.
const BLOCK_PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, ['|table', '']);
// Inside a blockquote a bare list marker (any number) starts a sibling
// list, so it must not be lazily continued as paragraph text.
const BLOCKQUOTE_PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, ['|table', '']);

const BLOCK_BLOCKQUOTE = compose(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
  [['paragraph', BLOCKQUOTE_PARAGRAPH]],
);

const BLOCK_TABLE = compose(
  '^ *([^\\n ].*)\\n' // header row
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' // delimiter row
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)', // body rows
  [
    ['hr', BLOCK_HR],
    ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
    ['blockquote', ' {0,3}>'],
    ['code', '(?: {4}| {0,3}\t)[^\\n]'],
    ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
    ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
    ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
    ['tag', BLOCK_TAGS],
  ],
);

// The GFM paragraph can be interrupted by a table.
const BLOCK_PARAGRAPH_GFM = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, ['table', BLOCK_TABLE]);
const BLOCK_LHEADING_GFM = buildLheading([/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/]);

const BLOCK = {
  blockquote: BLOCK_BLOCKQUOTE,
  code: BLOCK_CODE,
  def: BLOCK_DEF,
  fences: BLOCK_FENCES,
  heading: BLOCK_HEADING,
  hr: BLOCK_HR,
  html: BLOCK_HTML,
  lheading: BLOCK_LHEADING_GFM,
  list: BLOCK_LIST,
  newline: BLOCK_NEWLINE,
  paragraph: BLOCK_PARAGRAPH_GFM,
  table: BLOCK_TABLE,
  text: BLOCK_TEXT,
};

/* ---- Inline grammar ---- */

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INLINE_TEXT_PLAIN = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;

// Unicode classes used by the emphasis rules.
const PUNCT = /[\p{P}\p{S}]/u; // any punctuation or symbol
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM lets `~` take part in emphasis (strikethrough lives inside it),
// so `~` is not punctuation for the emphasis rules.
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

// A run of `*` / `_` can open emphasis only when the next character is
// punctuation or not whitespace; `_` additionally needs the previous
// character not to be alphanumeric (handled in code).
const EM_STRONG_L_DELIM_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_STRONG_L_DELIM = compose(EM_STRONG_L_DELIM_CORE, [[/punct/g, PUNCT_GFM]], 'u');

// How a later `*` run can close emphasis. Each alternative reports, in
// its capture group, whether the run is left-flanking, right-flanking,
// or either: groups 1-2 right only, 3-4 left only, 5-6 either.
const EM_STRONG_R_DELIM_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // skip an orphan inside strong
  + '|[^*]+(?=[^*])' // consume up to the next run
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only close
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only close
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only open
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only open
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either
const EM_STRONG_R_DELIM_AST = compose(EM_STRONG_R_DELIM_AST_CORE, [
  [/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM],
  [/punctSpace/g, PUNCT_OR_SPACE_GFM],
  [/punct/g, PUNCT_GFM],
], 'gu');

// `_` has no rule 6: a___a cannot close as emphasis.
const EM_STRONG_R_DELIM_UND = compose(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)',
  [
    [/notPunctSpace/g, NOT_PUNCT_OR_SPACE],
    [/punctSpace/g, PUNCT_OR_SPACE],
    [/punct/g, PUNCT],
  ],
  'gu',
);

// Strikethrough delimiters follow the same flanking rules as `*`.
const DEL_L_DELIM = compose(/^~~?(?:((?!~)punct)|[^\s~])/, [['punct', PUNCT]], 'u');
const DEL_R_DELIM = compose(
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)',
  [
    [/notPunctSpace/g, NOT_PUNCT_OR_SPACE],
    [/punctSpace/g, PUNCT_OR_SPACE],
    [/punct/g, PUNCT],
  ],
  'gu',
);
const INLINE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Any punctuation, for unescaping `\` + punctuation in destinations.
const ANY_PUNCTUATION = compose(/\\(punct)/, [['punct', PUNCT]], 'gu');
// The same, but a backslash inside a code span is literal: code spans
// are matched whole and kept, lone backtick runs are kept, and only the
// escapes outside code spans are masked.
const ANY_PUNCTUATION_OUTSIDE_CODE = compose(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  [['punct', PUNCT]],
  'gu',
);

// Is this single character punctuation-or-space (and not `*`/`_`)?
const PUNCTUATION = compose(/^((?![*_])punctSpace)/, [['punctSpace', PUNCT_OR_SPACE]], 'u');

// Autolink: <scheme:...> or <email>.
const INLINE_AUTOLINK = compose(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, [
  ['scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/],
  ['email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/],
]);

const INLINE_TAG = compose(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', // CDATA section
  [
    ['comment', INLINE_COMMENT],
    ['attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/],
  ],
);

// One matched pair of brackets holding no bracket of its own.
const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
// A link label may nest brackets; the regex stops at a fixed depth of
// two, which is all the spec suite exercises.
const INLINE_LABEL = compose(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  [['brackets', INLINE_LABEL_BRACKETS]],
);

const INLINE_LINK = compose(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
  [
    ['label', INLINE_LABEL],
    ['href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
    ['title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/],
  ],
);

const INLINE_REFLINK = compose(/^!?\[(label)\]\[(ref)\]/, [
  ['label', INLINE_LABEL],
  ['ref', BLOCK_LABEL],
]);
const INLINE_NOLINK = compose(/^!?\[(ref)\](?:\[\])?/, [['ref', BLOCK_LABEL]]);

// Bounded labels for the masking/search pass: a candidate that can
// never match must not scan to the end of the source, or the whole pass
// costs O(n^2). The label itself is capped at 999 items, the most
// CommonMark allows inside square brackets.
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = compose(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  [['brackets', INLINE_LABEL_BRACKETS]],
);
const REFLINK_SEARCH = compose('reflink|nolink(?!\\()', [
  ['reflink', compose(/^!?\[(label)\]\[(ref)\]/, [['label', BOUNDED_INLINE_LABEL], ['ref', BOUNDED_BLOCK_LABEL]])],
  ['nolink', compose(/^!?\[(ref)\](?:\[\])?/, [['ref', BOUNDED_BLOCK_LABEL]])],
], 'g');

// Sequences emphasis must skip over: [title](link), `code`, <html>.
// Built directly so the capture-group layout is explicit: group 1 is
// the backtick run inside a link label, group 2 is the empty pre-code
// group, group 3 is the backtick run of a code span.
const _blockSkipSrc = (() => {
  const link = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/;
  const code = /(?<b>`+)[^`]+\k<b>(?!`)/;
  const html = /<(?! )[^<>]*?>/;
  return new RegExp(
    link.source + '|(?<!`)()' + code.source + '|' + html.source,
    'g',
  );
})();

// Extended autolinks: www., scheme://, and bare email addresses.
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = compose(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, [[/email/g, EXTENDED_EMAIL]]);
const INLINE_URL = compose(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
  [
    ['emailProtocol', EXTENDED_EMAIL_PROTOCOL],
    ['protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/],
    ['email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/],
  ],
);
// Trims trailing punctuation off an extended autolink, one step at a
// time until the match is stable.
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// GFM inline text: stops before code, emphasis, links, tags, autolink
// starts and hard breaks, so the main loop can dispatch on them.
const INLINE_TEXT_GFM = compose(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  [
    ['protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/],
    [/emailProtocol/g, /(?:mailto|xmpp):/],
    // A www autolink starts only at a line start, after whitespace, or
    // after `*`, `_`, `~` or `(`.
    ['wwwStart', '(?<![^\\s*_~(])www\\.'],
  ],
);

// The stops for a plain-text run, as one regex: a special character,
// a URL scheme, a `www.` with a valid start, a hard-break run, a
// character before a mailto:/xmpp: or an email address. The first
// three (and the hard-break run) end the text where they start; the
// character before a mailto: or an email belongs to the text, so
// those end one past the match. Groups 1-3 are the former, 4-5 the
// latter; the hard-break run matches empty.
const INLINE_TEXT_STOP = /([\\<!\[`*~_])|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/)|((?<![^\s*_~(])www\.)|(?= {2,}\n)|([^a-zA-Z0-9](?=(?:mailto|xmpp):))|([^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))/g;
// An email address starting at the search position (sticky): the one
// immediate stop after the first unit that the scan below cannot
// see, since it needs the character before the address.
const INLINE_EMAIL_START = /[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@/y;

const INLINE = {
  _backpedal: URL_BACKPEDAL,
  anyPunctuation: ANY_PUNCTUATION,
  anyPunctuationOutsideCode: ANY_PUNCTUATION_OUTSIDE_CODE,
  autolink: INLINE_AUTOLINK,
  blockSkip: _blockSkipSrc,
  br: INLINE_BR,
  code: INLINE_CODE,
  del: INLINE_DEL,
  delLDelim: DEL_L_DELIM,
  delRDelim: DEL_R_DELIM,
  emStrongLDelim: EM_STRONG_L_DELIM,
  emStrongRDelimAst: EM_STRONG_R_DELIM_AST,
  emStrongRDelimUnd: EM_STRONG_R_DELIM_UND,
  escape: INLINE_ESCAPE,
  link: INLINE_LINK,
  nolink: INLINE_NOLINK,
  punctuation: PUNCTUATION,
  reflink: INLINE_REFLINK,
  reflinkSearch: REFLINK_SEARCH,
  tag: INLINE_TAG,
  text: INLINE_TEXT_GFM,
  url: INLINE_URL,
};

/* ------------------------------------------------------------------ */
/* Lexing state                                                        */
/*                                                                     */
/* One object per parse() call. `tokens` is the block token list;      */
/* `links` holds every link reference definition found while block     */
/* lexing (inline runs only start once all of them are known);         */
/* `inlineQueue` holds the raw inline strings waiting to be            */
/* tokenised, in the order their blocks were found.                    */
/* ------------------------------------------------------------------ */

function newContext() {
  const tokens = [];
  tokens.links = Object.create(null);
  return {
    tokens,
    hasLinks: false,
    inlineQueue: [],
    state: {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    },
    closerStack: [],
  };
}

function infiniteLoopError(byte) {
  throw new Error('Infinite loop on byte: ' + byte);
}

/** Queue an inline string for later rendering. `holder` is the block
 *  token (or table cell) whose `html` field the inline phase will fill
 *  with the rendered string. Nothing is tokenised yet: inline runs
 *  only start once every block, and therefore every link reference
 *  definition, is known. */
function queueInline(ctx, src, holder) {
  ctx.inlineQueue.push({ src, holder });
}

/* ------------------------------------------------------------------ */
/* Block tokenizers                                                    */
/* ------------------------------------------------------------------ */

function tokenizeSpace(ctx, src) {
  const cap = BLOCK.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}

function tokenizeCode(ctx, src) {
  const cap = BLOCK.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(O.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const matchIndent = node.match(O.beginningSpace);
    if (matchIndent === null) return node;
    const indentInNode = matchIndent[0];
    return node.slice(Math.min(indentInNode.length, indentToCode.length));
  }).join('\n');
}

function tokenizeFences(ctx, src) {
  const cap = BLOCK.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(INLINE.anyPunctuation, '$1') : cap[2],
      text,
    };
  }
}

function tokenizeHeading(ctx, src) {
  const cap = BLOCK.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (O.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || O.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    const token = {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[1].length,
      text,
      html: '',
    };
    queueInline(ctx, text, token);
    return token;
  }
}

function tokenizeHr(ctx, src) {
  const cap = BLOCK.hr.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokenizeBlockquote(ctx, src) {
  const cap = BLOCK.blockquote.exec(src);
  if (!cap) return;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      // collect lines up to a lazy continuation
      if (O.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // a tab after the marker runs to the next tab stop; the marker
      // only consumes one space of it, the rest is content
      .replace(O.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      // precede a setext continuation with 4 spaces so it is not a setext
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    // parse blockquote lines as top level tokens; merge paragraphs
    // when this chunk continues the previous one
    const top = ctx.state.top;
    ctx.state.top = true;
    blockTokens(ctx, currentText, tokens, true);
    ctx.state.top = top;

    if (lines.length === 0) break;

    const lastToken = tokens.at(-1);
    if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
      // a continuation cannot follow a code block, heading, hr, html
      // block or table
      break;
    } else if (lastToken?.type === 'blockquote') {
      // include the continuation in the nested blockquote
      const oldToken = lastToken;
      // The continuation lines belong to the same nesting frame as the
      // nested blockquote, which already had one '>' stripped, so strip
      // one marker from them too.
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const newToken = tokenizeBlockquote(ctx, newText);
      tokens[tokens.length - 1] = newToken;
      // Only include continuation lines the nested blockquote actually
      // consumed; unconsumed trailing lines stay for the outer lexer.
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      // A leftover line starting with '>' still belongs to this
      // blockquote; any other leftover line ends it.
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.type === 'list') {
      // include the continuation in the nested list
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokenizeList(ctx, newText);
      tokens[tokens.length - 1] = newToken;
      // The list raw has no '>' markers, so count the continuation
      // lines the list took and add those lines instead.
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { type: 'blockquote', raw, tokens, text };
}

function tokenizeList(ctx, src) {
  let cap = BLOCK.list.exec(src);
  if (!cap) return;
  // src is only consumed from the front, so every raw below is a slice
  // of listSrc rather than a string built up line by line
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isOrdered = bull.length > 1;

  const list = {
    type: 'list',
    raw: '',
    ordered: isOrdered,
    start: isOrdered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  bull = isOrdered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  const itemRegex = O.listItemRegex(bull);
  let endsWithBlankLine = false;

  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    // End the list if the bullet was actually a thematic break.
    if (BLOCK.hr.test(src)) break;

    const itemStart = taken();
    src = src.substring(cap[0].length);

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    const line0 = firstLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let line = line0;
    let nextLine = src.split('\n', 1)[0];
    const blankLine0 = !line.trim();
    let blankLine = blankLine0;

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar);
      // Treat indented code blocks (> 4 spaces) as having only 1 indent.
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && O.blankLine.test(nextLine)) {
      // Items begin with at most one blank line.
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);

      while (src) {
        const rawLine = src.split('\n', 1)[0];
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws));

        if (fencesBeginRegex.test(nextLine)) break;
        if (headingBeginRegex.test(nextLine)) break;
        if (htmlBeginRegex.test(nextLine)) break;
        if (blockquoteBeginRegex.test(nextLine)) break;
        if (nextBulletRegex.test(nextLine)) break;
        if (hrRegex.test(nextLine)) break;

        if (nextLineWithoutTabs.search(O.nonSpaceChar) >= indent || !nextLine.trim()) {
          // Dedent if possible.
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          // Not enough indentation.
          if (blankLine) break;
          // Paragraph continuation unless the last line was a
          // different block level element.
          if (line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4) break; // indented code block
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;

          // A lazy continuation can look like a setext underline once
          // list indentation is removed. Keep it in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && BLOCK.lheading.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = !nextLine.trim();
        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    // The loops above appended a '\n' the source may not have had. It
    // can only land on the item that exhausts src, whose raw is trimmed
    // below, and after which nothing reads endsWithBlankLine.
    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (hasTrailingBlankLine(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      type: 'list_item',
      raw,
      task: O.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  // Do not consume newlines at the end of the final item.
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return; // not a list since there were no items
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  // Item child tokens are handled here at the end because the final
  // item had to be trimmed first. First pass: tokenise items and
  // finalise list.loose from spacers, before placing checkboxes.
  for (const item of list.items) {
    ctx.state.top = false;
    item.tokens = blockTokens(ctx, item.text, []);

    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => O.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }

  // Second pass: place task checkboxes using the final list.loose.
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      // Remove the checkbox markdown from the item tokens.
      item.text = item.text.replace(O.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(O.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(O.listReplaceTask, '');
      for (let i = ctx.inlineQueue.length - 1; i >= 0; i--) {
        if (O.listIsTask.test(ctx.inlineQueue[i].src)) {
          ctx.inlineQueue[i].src = ctx.inlineQueue[i].src.replace(O.listReplaceTask, '');
          break;
        }
      }

      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = {
          type: 'checkbox',
          raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && (item.tokens[0].type === 'paragraph' || item.tokens[0].type === 'text')) {
            // The checkbox renders first inside the paragraph's inline
            // content; the inline phase prepends its HTML.
            item.tokens[0].leadCheckbox = checkboxToken;
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: checkboxToken.raw,
              text: checkboxToken.raw,
              html: checkboxHtml(checkboxToken.checked),
            });
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  // Set all items to loose if the list is loose.
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }

  return list;
}

function tokenizeHtml(ctx, src) {
  const cap = BLOCK.html.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
}

function tokenizeDef(ctx, src) {
  const cap = BLOCK.def.exec(src);
  if (cap) {
    // Outside angle brackets a link destination holds only balanced
    // parentheses.
    if (!O.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE.anyPunctuation, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokenizeTable(ctx, src) {
  const cap = BLOCK.table.exec(src);
  if (!cap) return;
  // The delimiter row must hold a pipe or a colon, otherwise this is a
  // setext heading.
  if (!O.tableDelimiter.test(cap[2])) return;

  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];

  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return; // header and align columns must be equal

  for (const align of aligns) {
    if (O.tableAlignRight.test(align)) item.align.push('right');
    else if (O.tableAlignCenter.test(align)) item.align.push('center');
    else if (O.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    const cell = {
      text: headers[i],
      html: '',
      header: true,
      align: item.align[i],
    };
    queueInline(ctx, headers[i], cell);
    item.header.push(cell);
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cellText, i) => {
      const cell = {
        text: cellText,
        html: '',
        header: false,
        align: item.align[i],
      };
      queueInline(ctx, cellText, cell);
      return cell;
    }));
  }
  return item;
}

function tokenizeLheading(ctx, src) {
  const cap = BLOCK.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    const token = {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      html: '',
    };
    queueInline(ctx, text, token);
    return token;
  }
}

/** Build a paragraph token from a paragraph-regex match and queue
 *  its inline content. Split from the regex so the setext probe in
 *  blockTokens can run the regex once and decide about the heading
 *  before any inline content is queued. */
function paragraphToken(ctx, cap) {
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  const token = { type: 'paragraph', raw: cap[0], text, html: '' };
  queueInline(ctx, text, token);
  return token;
}

/** The paragraph ended at `offset`; the line there stopped it. Could
 *  a setext underline lie at or just past that line? Three ways: the
 *  stopped-at line is itself an underline (`---`, which is also a
 *  thematic break); it starts with `<` (an html line the paragraph
 *  stops at but a setext text may cross, since a bare tag line has
 *  no `>`); or it is a table header whose delimiter line is a bare
 *  dashes line, which is both delimiter and underline. */
function lheadingAfterParagraph(src, offset) {
  // The paragraph's text ends just before the newline that precedes
  // the stopped-at line; skip it so line 1 is that line.
  if (src.charCodeAt(offset) === 10) offset++;
  const i = offset;
  const line1End = src.indexOf('\n', i);
  const end1 = line1End === -1 ? src.length : line1End;
  // The stopped-at line is itself an underline.
  if (isUnderlineLine(src, i, end1)) return true;
  // An html line: the underline may lie past it.
  let k = i;
  while (k < i + 3 && src.charCodeAt(k) === 32) k++;
  if (src.charCodeAt(k) === 60) return true;
  // A table header whose delimiter is a bare dashes line.
  if (line1End !== -1) {
    let m = i;
    while (m < end1 && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
    if (m < end1) {
      const line2Start = line1End + 1;
      const line2End = src.indexOf('\n', line2Start);
      const end2 = line2End === -1 ? src.length : line2End;
      if (isDashesLine(src, line2Start, end2)) return true;
    }
  }
  return false;
}

/** Is `src[start..end)` (one line, without its newline) a setext
 *  underline: up to three spaces, then only `=` or only `-`, then
 *  only spaces or tabs? */
function isUnderlineLine(src, start, end) {
  let i = start;
  while (i < start + 3 && src.charCodeAt(i) === 32) i++;
  if (i >= end) return false;
  const ch = src.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return false; // = or -
  while (i < end && src.charCodeAt(i) === ch) i++;
  while (i < end && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  return i === end;
}

/** Is `src[start..end)` a bare dashes line (the table-delimiter /
 *  setext-underline overlap)? */
function isDashesLine(src, start, end) {
  let i = start;
  while (i < start + 3 && src.charCodeAt(i) === 32) i++;
  if (i >= end || src.charCodeAt(i) !== 45) return false;
  while (i < end && src.charCodeAt(i) === 45) i++;
  while (i < end && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  return i === end;
}

/** Does `raw` end with a blank line: a newline, only spaces or
 *  tabs, another newline, only spaces or tabs, then the end? (The
 *  manual form of /\n[ \t]*\n[ \t]*$/ — the regex scans the whole
 *  raw text, this only walks its tail.) */
function hasTrailingBlankLine(raw) {
  let i = raw.length;
  while (i > 0 && (raw.charCodeAt(i - 1) === 32 || raw.charCodeAt(i - 1) === 9)) i--;
  if (i === 0 || raw.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0 && (raw.charCodeAt(i - 1) === 32 || raw.charCodeAt(i - 1) === 9)) i--;
  return i > 0 && raw.charCodeAt(i - 1) === 10;
}

function tokenizeText(ctx, src) {
  const cap = BLOCK.text.exec(src);
  if (cap) {
    const token = { type: 'text', raw: cap[0], text: cap[0], html: '' };
    queueInline(ctx, cap[0], token);
    return token;
  }
}

/* ------------------------------------------------------------------ */
/* Block loop                                                          */
/*                                                                     */
/* Tries the block tokenizers in the reference order. A few tokens    */
/* are merged into the previous one instead of being pushed: a single  */
/* newline is appended to the previous token's raw, and indented code  */
/* or a link definition that follows a paragraph is folded into that   */
/* paragraph (an indented code block cannot interrupt a paragraph).    */
/* ------------------------------------------------------------------ */

function blockTokens(ctx, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      infiniteLoopError(src.charCodeAt(0));
      break;
    }

    let token;

    // First-char dispatch: most block markers allow up to three
    // leading spaces, so the significant character is the first
    // non-space within them (`sig` is its index, or 3 when the line
    // starts with four or more spaces, which is indented-code
    // territory). A tokenizer whose marker cannot start there is
    // skipped; the trial order among the rest is unchanged.
    const ch0 = src.charCodeAt(0);
    let sig = 0;
    if (ch0 === 32) {
      while (sig < 3 && src.charCodeAt(sig) === 32) sig++;
    }
    const sigCh = src.charCodeAt(sig);

    // newline
    if ((ch0 === 32 || ch0 === 9 || ch0 === 10) && (token = tokenizeSpace(ctx, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        // A single \n as a spacer terminates the last line, so move it
        // there instead of emitting an empty paragraph break.
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    // indented code
    if ((sigCh === 32 || sigCh === 9) && (token = tokenizeCode(ctx, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        ctx.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    // fenced code
    if ((sigCh === 96 || sigCh === 126) && (token = tokenizeFences(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // ATX heading
    if (sigCh === 35 && (token = tokenizeHeading(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // thematic break
    if ((sigCh === 45 || sigCh === 95 || sigCh === 42) && (token = tokenizeHr(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // blockquote
    if (sigCh === 62 && (token = tokenizeBlockquote(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // list
    if ((sigCh === 42 || sigCh === 43 || sigCh === 45 || (sigCh >= 48 && sigCh <= 57))
      && (token = tokenizeList(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // raw HTML block
    if (sigCh === 60 && (token = tokenizeHtml(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // link reference definition
    if (sigCh === 91 && (token = tokenizeDef(ctx, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        ctx.inlineQueue.at(-1).src = lastToken.text;
      } else {
        // The first definition of a label wins, but a later one still
        // consumes its text.
        if (!ctx.tokens.links[token.tag]) {
          ctx.tokens.links[token.tag] = { href: token.href, title: token.title };
          ctx.hasLinks = true;
        }
        tokens.push(token);
      }
      continue;
    }

    // table (GFM)
    if (token = tokenizeTable(ctx, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // setext heading (only when this is not a top-level pass; at the
    // top level the paragraph below probes for it instead). The
    // paragraph regex is the probe span here too: it covers at least
    // the lines a setext text may span (its list interrupt is the
    // narrow top-level one), so an underline it misses cannot be
    // reached by a heading either.
    if (!ctx.state.top) {
      const cap = BLOCK.paragraph.exec(src);
      if (cap && (O.lheadingProbe.test(cap[1]) || lheadingAfterParagraph(src, cap[0].length))) {
        if (token = tokenizeLheading(ctx, src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      }
    }

    // top-level paragraph (only when this is a top-level pass; inside
    // a list item the same text becomes a plain text token instead).
    // A setext heading is a paragraph followed by an underline, so
    // the paragraph regex runs first and the underline is probed
    // inside its text: the lheading regex only runs when an underline
    // line is present, or when the paragraph stopped at an html line
    // a setext text may cross.
    if (ctx.state.top) {
      const cap = BLOCK.paragraph.exec(src);
      if (cap) {
        let lh;
        if (O.lheadingProbe.test(cap[1]) || lheadingAfterParagraph(src, cap[0].length)) {
          lh = tokenizeLheading(ctx, src);
        }
        if (lh) {
          src = src.substring(lh.raw.length);
          tokens.push(lh);
          continue;
        }
        const token = paragraphToken(ctx, cap);
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          ctx.inlineQueue.pop();
          ctx.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        src = src.substring(token.raw.length);
        continue;
      }
    }

    // plain text
    if (token = tokenizeText(ctx, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        ctx.inlineQueue.pop();
        ctx.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) {
      infiniteLoopError(src.charCodeAt(0));
      break;
    }
  }

  ctx.state.top = true;
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Inline tokenizers                                                   */
/* ------------------------------------------------------------------ */

/** The HTML for a checkbox token. */
function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

/** Render an inline link or image into `out`. Returns the number of
 *  source characters consumed, or 0 when the link bails (a link may
 *  not contain another link, so the caller falls through to plain
 *  text and the inner link is the one kept). `textMode` renders only
 *  the textual part, as an image's alt text needs. */
function appendLink(ctx, cap, link, raw, out, textMode) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = ctx.state.inLink;
  const outerLinkEmitted = ctx.state.linkEmitted;
  const outerInRawBlock = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  // A link's label renders as HTML; an image's label renders as plain
  // text for its alt attribute.
  const inner = inlineToHtml(ctx, text, isImage);
  const textHasLink = ctx.state.linkEmitted;
  ctx.state.linkEmitted = outerLinkEmitted;
  ctx.state.inLink = outerInLink;

  if (!isImage) {
    // Links may not contain other links, at any level of nesting.
    if (textHasLink) {
      // This rendering is discarded, so undo the raw-block state it
      // opened; leaving it set would suppress escaping for the text
      // that is re-scanned.
      ctx.state.inRawBlock = outerInRawBlock;
      return 0;
    }
    ctx.state.linkEmitted = true;
    if (textMode) {
      out.push(inner);
      return raw.length;
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      out.push(inner);
      return raw.length;
    }
    let s = '<a href="' + escapeHtml(cleanHref, false) + '"';
    if (title) s += ' title="' + escapeHtml(title) + '"';
    s += '>' + inner + '</a>';
    out.push(s);
    return raw.length;
  }

  // Image: the label became the alt text.
  if (textMode) {
    out.push(inner);
    return raw.length;
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    out.push(escapeHtml(inner));
    return raw.length;
  }
  let s = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(inner)}"`;
  if (title) s += ` title="${escapeHtml(title)}"`;
  s += '>';
  out.push(s);
  return raw.length;
}

function isLabelEndInsideToken(ctx, src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE.tag.exec(tokenSrc) || INLINE.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function appendEscape(ctx, src, out, textMode) {
  const cap = INLINE.escape.exec(src);
  if (cap) {
    out.push(textMode ? cap[1] : escapeHtml(cap[1]));
    return cap[0].length;
  }
  return 0;
}

function appendTag(ctx, src, out, textMode) {
  const cap = INLINE.tag.exec(src);
  if (cap) {
    if (!ctx.state.inLink && O.startATag.test(cap[0])) ctx.state.inLink = true;
    else if (ctx.state.inLink && O.endATag.test(cap[0])) ctx.state.inLink = false;
    if (!ctx.state.inRawBlock && O.startPreScriptTag.test(cap[0])) ctx.state.inRawBlock = true;
    else if (ctx.state.inRawBlock && O.endPreScriptTag.test(cap[0])) ctx.state.inRawBlock = false;
    out.push(cap[0]);
    return cap[0].length;
  }
  return 0;
}

function appendLinkToken(ctx, src, out, textMode) {
  // The link regex backtracks quadratically over unterminated-link
  // inputs like '[a](b'.repeat(n). inlineToHtml anchors one paren scan
  // per run in state.linkParenPossible; when it is false the regex
  // cannot match, so bail out before running it.
  if (ctx.state.linkParenPossible === false) return 0;
  const cap = INLINE.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(ctx, src, cap[1], labelStart)) return 0;

    const trimmedUrl = cap[2].trim();
    if (O.startAngleBracket.test(trimmedUrl)) {
      // CommonMark requires matching angle brackets.
      if (!O.endAngleBracket.test(trimmedUrl)) return 0;
      // The ending angle bracket cannot be escaped.
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return 0;
    } else {
      // Find the closing parenthesis.
      const lastParenIndex = findClosingBracket(cap[2], '()');
      if (lastParenIndex === -2) return 0; // more open parens than closed
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    // The ')' that ends the match is the link closer only when it is
    // not escaped. `[foo](/url\)` has no closer; that paren is
    // destination text.
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return 0;

    let href = cap[2];
    let title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
    return appendLink(ctx, cap, {
      href: href ? href.replace(INLINE.anyPunctuation, '$1') : href,
      title: title ? title.replace(INLINE.anyPunctuation, '$1') : title,
    }, cap[0], out, textMode);
  }
  return 0;
}

function appendReflink(ctx, src, out, textMode) {
  let cap;
  if ((cap = INLINE.reflink.exec(src)) || (cap = INLINE.nolink.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(ctx, src, cap[1], labelStart)) return 0;
    const link = ctx.tokens.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      // Not a defined reference: only the opening character is text.
      out.push(cap[0].charAt(0));
      return 1;
    }
    return appendLink(ctx, cap, link, cap[0], out, textMode);
  }
  return 0;
}

function lastPossibleEmStrongCloser(ctx, maskedSrc, delim) {
  const frame = ctx.closerStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastEm[delim];
  return scanClosers(maskedSrc).lastEm[delim];
}

function lastPossibleDelCloser(ctx, maskedSrc) {
  const frame = ctx.closerStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastDel;
  return scanClosers(maskedSrc).lastDel;
}

function appendEmStrong(ctx, src, maskedSrc, prevChar, out, textMode) {
  let match = INLINE.emStrongLDelim.exec(src);
  if (!match) return 0;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return 0;

  const delimChar = match[0][0];
  // A mid-run opener (for example the second star of an unmatched `**`)
  // must only pair with a delimiter that can only close, otherwise it
  // steals the opener of a later span.
  const midRun = prevChar === delimChar;

  // The start of this delimiter run may already be behind src, either
  // taken as text after the whole run failed to match or used to close
  // an earlier span. Flanking and rules 9-10 are about the whole run,
  // so find its start.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  // The other delimiter character counts as punctuation here (`_**a*`).
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INLINE.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE.punctuation.exec(prevChar);

  // `_` cannot open between two alphanumerics.
  if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return 0;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    // Spread into an array: the regex counts emoji as one character.
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    // Rules 9-10 count the whole run, and also apply when the opener
    // could close as well (`a*b**`, where `*` is both left- and
    // right-flanking).
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return 0;
    const endReg = delimChar === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastPossible = lastPossibleEmStrongCloser(ctx, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return 0;
    // Clip maskedSrc to the same section of string as src.
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip single * in __abc*abc__

      rLength = [...rDelim].length;

      if (match[3] || match[4]) {
        // Found another left delimiter.
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        // Either a left or a right delimiter.
        if (midRun && (match[5] || match[6])) {
          // A mid-run opener cannot close against an ambiguous
          // delimiter that can also open; that delimiter opens its own
          // emphasis span instead.
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark emphasis rules 9-10
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // not enough closing delimiters yet

      // Remove extra characters: *a*** -> *a*
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      if (Math.min(lLength, rLength) % 2) {
        // Odd smallest delimiter: emphasis.
        const inner = inlineToHtml(ctx, raw.slice(1, -1), textMode);
        if (textMode) out.push(inner);
        else out.push(`<em>${inner}</em>`);
        return raw.length;
      }
      // Even smallest delimiter: strong emphasis.
      const inner = inlineToHtml(ctx, raw.slice(2, -2), textMode);
      if (textMode) out.push(inner);
      else out.push(`<strong>${inner}</strong>`);
      return raw.length;
    }
  }
  return 0;
}

function appendCodespan(ctx, src, out, textMode) {
  const cap = INLINE.code.exec(src);
  if (cap) {
    let text = cap[2].replace(O.newLineCharGlobal, ' ');
    const hasNonSpaceChars = O.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
    out.push(textMode ? text : `<code>${escapeHtml(text, true)}</code>`);
    return cap[0].length;
  }
  return 0;
}

function appendBr(ctx, src, out, textMode) {
  const cap = INLINE.br.exec(src);
  if (cap) {
    out.push(textMode ? '' : '<br>');
    return cap[0].length;
  }
  return 0;
}

function appendDel(ctx, src, maskedSrc, prevChar, out, textMode) {
  let match = INLINE.delLDelim.exec(src);
  if (!match) return 0;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = INLINE.delRDelim;
    const lastPossible = lastPossibleDelCloser(ctx, maskedSrc);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return 0;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        // Found another left delimiter.
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const inner = inlineToHtml(ctx, raw.slice(lLength, -lLength), textMode);
      if (textMode) out.push(inner);
      else out.push(`<del>${inner}</del>`);
      return raw.length;
    }
  }
  return 0;
}

function appendAutolink(ctx, src, out, textMode) {
  const cap = INLINE.autolink.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    if (textMode) {
      out.push(text);
      return cap[0].length;
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      out.push(escapeHtml(text, true));
      return cap[0].length;
    }
    out.push('<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>');
    return cap[0].length;
  }
  return 0;
}

function appendUrl(ctx, src, out, textMode) {
  let cap;
  if (cap = INLINE.url.exec(src)) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      // Extended autolink path validation: trim trailing punctuation
      // until the match is stable.
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = INLINE._backpedal.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    if (textMode) {
      out.push(text);
      return cap[0].length;
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      out.push(escapeHtml(text, true));
      return cap[0].length;
    }
    out.push('<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>');
    return cap[0].length;
  }
  return 0;
}

/** Length of the plain-text run at the start of `src`, per the
 *  inline text rule: the first unit (a backtick run, a tilde run, or
 *  one character), then up to the earliest stop — a special character
 *  (`\ < ! [ ` * ~ _`), a URL scheme, a `www.` with a valid start, a
 *  `  \n` hard-break run, a `mailto:`/`xmpp:` (the character before
 *  it belongs to the text), an email address (same), or the end. */
function inlineTextLength(src) {
  const c0 = src.charCodeAt(0);
  const isAlnum = (c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
  // A single non-alphanumeric character followed by mailto:/xmpp: is
  // the whole text.
  if (!isAlnum && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) return 1;
  // First unit: a backtick run, a tilde run, or one character.
  let start = 1;
  if (c0 === 96) {
    while (src.charCodeAt(start) === 96) start++;
  } else if (c0 === 126) {
    while (src.charCodeAt(start) === 126) start++;
  }
  // An email address starting right after the first unit ends the
  // text there. (The other immediate stops — a backtick, a tilde, a
  // hard-break run — are found by the scan below.)
  INLINE_EMAIL_START.lastIndex = start;
  if (INLINE_EMAIL_START.test(src)) return start;
  INLINE_TEXT_STOP.lastIndex = start;
  const m = INLINE_TEXT_STOP.exec(src);
  if (!m) return src.length;
  if (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined || m[0] === '') return m.index;
  return m.index + 1;
}

function appendInlineText(ctx, src, out, textMode) {
  const len = inlineTextLength(src);
  if (len > 0) {
    // A raw-text entry, not yet decoded or escaped: adjacent text
    // tokens are merged before escaping (see renderInlineOut), so a
    // `&` split from its reference by a `_` is still one reference.
    // `e` records whether the run sits inside raw HTML, which keeps
    // whatever it was written with.
    out.push({ t: src.slice(0, len), e: ctx.state.inRawBlock });
    return len;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Emphasis masking                                                    */
/*                                                                     */
/* Before scanning for emphasis, links, code spans, HTML and escapes  */
/* are masked out of a copy of the source so their `*`, `_` and `~`   */
/* cannot pair with delimiters outside them. Every mask keeps the     */
/* length it replaces, because emStrong and del line the masked copy   */
/* up with the original by slicing from the end.                       */
/* ------------------------------------------------------------------ */

// Does this link text hold a link already? An image does not count: an
// image may hold a link, a link may not.
function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  const linkRule = INLINE.link;
  for (const match of text.matchAll(INLINE.blockSkip)) {
    // blockSkip also matches code spans and html, and the `!` of an
    // image is left out of the match, so read the character before it.
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(INLINE.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    // A candidate holding a link is not a link either, so it does not count.
    if (refStart > 1 && linkInText(ctx, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

function maskSrc(ctx, src) {
  let maskedSrc = src;

  // Mask out reference links. Only when at least one definition
  // exists: with no links, no candidate can match and the scan is
  // pure overhead.
  if (src.includes('[') && ctx.hasLinks) {
    const reflinkSearch = INLINE.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      // A candidate whose text already holds a link never becomes one,
      // so flattening the whole span would hide the emphasis that does
      // still apply inside it. Mask the links it holds instead. Images
      // are exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }

  // Mask out escaped characters. A backslash is literal inside a code
  // span, so a code span is matched whole and kept; only the escapes
  // outside code spans are masked. With no backslash and no backtick
  // in the run, nothing can match.
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(INLINE.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }

  // Mask out other blocks (links, code spans, html). Each alternative
  // needs one of `[`, backtick or `<` to start.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(INLINE.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }

  return maskedSrc;
}

/* ------------------------------------------------------------------ */
/* Inline loop                                                         */
/* ------------------------------------------------------------------ */

/** Render an inline string to HTML directly, without building an
 *  intermediate token tree. `textMode` renders only the textual part
 *  (image alt text: links become their label, code spans their raw
 *  text, hard breaks disappear). Returns the HTML string. */
function inlineToHtml(ctx, src, textMode) {
  // One paren scan per inline run, shared with appendLinkToken:
  // without a ')' ahead the link regex cannot match. A nested run
  // receives a substring of the outer run, so if the outer had no ')'
  // neither does this substring.
  const prevLinkParenPossible = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
  // The masked source is only read by emStrong and del, which need a
  // `*`, `_` or `~` to start. Skip building it for a run without one.
  const maskedSrc = (src.includes('*') || src.includes('_') || src.includes('~'))
    ? maskSrc(ctx, src)
    : src;

  // One scan of this maskedSrc for the last emphasis, strong and
  // strikethrough closers, shared by every opener in the pass. Popped
  // when the pass ends so the source is not retained.
  ctx.closerStack.push(scanClosers(maskedSrc));
  try {
    const out = [];
    appendInline(ctx, src, maskedSrc, out, textMode);
    return renderInlineOut(out, textMode);
  } finally {
    ctx.closerStack.pop();
    // A nested run anchored on its own substring; restore the outer
    // run's flag for the rest of its loop.
    ctx.state.linkParenPossible = prevLinkParenPossible;
  }
}

/** Join an inline output array. String entries are finished HTML and
 *  pass through as they are. Object entries are raw text runs, and
 *  adjacent runs are merged before decoding and escaping — that is
 *  what marked does with adjacent text tokens, and it is what keeps
 *  a `&` followed by `_;` from being escaped when a `_` split the
 *  text in two. Adjacent runs always share their raw-block state (a
 *  tag, which is what changes it, is a string entry that flushes),
 *  but a changed state flushes anyway, to be safe. */
function renderInlineOut(out, textMode) {
  let result = '';
  let pending = '';
  let pendingEscaped = false;
  const flush = () => {
    if (pending !== '') {
      const text = pendingEscaped ? pending : decodeNumericRefs(pending);
      result += textMode ? text : (pendingEscaped ? text : escapeHtml(text));
      pending = '';
    }
  };
  for (const item of out) {
    if (typeof item === 'string') {
      flush();
      result += item;
    } else {
      if (pending !== '' && pendingEscaped !== item.e) flush();
      pending += item.t;
      pendingEscaped = item.e;
    }
  }
  flush();
  return result;
}

function appendInline(ctx, src, maskedSrc, out, textMode) {
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      infiniteLoopError(src.charCodeAt(0));
      break;
    }

    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;

    let consumed = 0;
    const ch = src.charCodeAt(0);

    // Dispatch on the first character: only the renderers that can
    // possibly match there are tried, in the reference order. Plain
    // text (the common case) falls straight through to the text rule.
    if (ch === 92) { // backslash
      if (consumed = appendEscape(ctx, src, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
      if (consumed = appendBr(ctx, src, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
    } else if (ch === 60) { // <
      if (consumed = appendTag(ctx, src, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
      if (consumed = appendAutolink(ctx, src, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
    } else if (ch === 91 || ch === 33) { // [ or !
      if (consumed = appendLinkToken(ctx, src, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
      if (consumed = appendReflink(ctx, src, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
    } else if (ch === 42 || ch === 95) { // * or _
      if (consumed = appendEmStrong(ctx, src, maskedSrc, prevChar, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
      // `_` can start an extended autolink (an email address, whose
      // local part includes `_`); `*` cannot, so only `_` falls
      // through to it before plain text.
      if (ch === 95 && !ctx.state.inLink
        && (consumed = appendUrl(ctx, src, out, textMode))) {
        src = src.substring(consumed);
        continue;
      }
    } else if (ch === 96) { // `
      if (consumed = appendCodespan(ctx, src, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
    } else if (ch === 126) { // ~
      if (consumed = appendDel(ctx, src, maskedSrc, prevChar, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
    } else if (ch === 32) { // space
      if (consumed = appendBr(ctx, src, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
    } else if (!ctx.state.inLink
      && (ch === 46 || ch === 95 || ch === 43 || ch === 45 // . _ + -
        || (ch >= 48 && ch <= 57) // 0-9
        || (ch >= 65 && ch <= 90) // A-Z
        || (ch >= 97 && ch <= 122))) { // a-z
      // Only these first characters can start an extended autolink.
      if (consumed = appendUrl(ctx, src, out, textMode)) {
        src = src.substring(consumed);
        continue;
      }
    }

    // plain text
    if (consumed = appendInlineText(ctx, src, out, textMode)) {
      // Track prevChar before a run of ____ started.
      if (src.charAt(consumed - 1) !== '_') prevChar = src.charAt(consumed - 1);
      src = src.substring(consumed);
      keepPrevChar = true;
      continue;
    }

    if (src) {
      infiniteLoopError(src.charCodeAt(0));
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/*                                                                     */
/* Inline strings are rendered directly to HTML during the inline      */
/* phase and stored on their block token's `html` field (or a table    */
/* cell's `html` field); the block renderer only assembles those       */
/* strings with the block-level tags.                                  */
/* ------------------------------------------------------------------ */

function renderBlock(tokens) {
  const out = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'heading':
        out.push(`<h${token.depth}>${token.html}</h${token.depth}>\n`);
        break;
      case 'code': {
        const langString = (token.lang || '').match(O.notSpaceStart)?.[0];
        // An empty code block has no content, so it must not gain a
        // newline.
        const code = token.text ? token.text.replace(O.endingNewline, '') + '\n' : '';
        if (!langString) {
          out.push('<pre><code>' + escapeHtml(code, true) + '</code></pre>\n');
        } else {
          out.push('<pre><code class="language-' + escapeHtml(langString) + '">'
            + escapeHtml(code, true) + '</code></pre>\n');
        }
        break;
      }
      case 'table': {
        let header = '';
        let cell = '';
        for (const head of token.header) cell += renderTableCell(head);
        header += `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (const row of token.rows) {
          cell = '';
          for (const c of row) cell += renderTableCell(c);
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out.push('<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n');
        break;
      }
      case 'blockquote':
        out.push(`<blockquote>\n${renderBlock(token.tokens)}</blockquote>\n`);
        break;
      case 'list': {
        let body = '';
        for (const item of token.items) body += `<li>${renderBlock(item.tokens)}</li>\n`;
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
        out.push('<' + type + startAttr + '>\n' + body + '</' + type + '>\n');
        break;
      }
      case 'checkbox':
        out.push(checkboxHtml(token.checked));
        break;
      case 'html':
        out.push(token.text);
        break;
      case 'def':
        break;
      case 'paragraph':
        out.push(`<p>${token.html}</p>\n`);
        break;
      case 'text':
        out.push(token.html);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out.join('');
}

function renderTableCell(token) {
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + token.html + `</${type}>\n`;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** Lex `src` into block tokens, then render the queued inline
 *  strings in order, storing each result on its holder's `html`
 *  field. An inline `<pre>`, `<code>`, `<kbd>` or `<script>` left
 *  open ends with the block holding it; carried over, it would stop
 *  every later block's text from being escaped. */
function lex(ctx, src) {
  if (src.includes('\r')) src = src.replace(O.carriageReturn, '\n');
  blockTokens(ctx, src, ctx.tokens);
  for (const next of ctx.inlineQueue) {
    ctx.state.inRawBlock = false;
    const lead = next.holder.leadCheckbox ? checkboxHtml(next.holder.leadCheckbox.checked) : '';
    next.holder.html = lead + inlineToHtml(ctx, next.src, false);
  }
  ctx.inlineQueue = [];
  return ctx.tokens;
}

/** The HTML marked 18.1.3 renders for `markdown` with its defaults. */
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const ctx = newContext();
  return renderBlock(lex(ctx, markdown));
}
