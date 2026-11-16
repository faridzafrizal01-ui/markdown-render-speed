// SwiftMark — a from-scratch CommonMark 0.31.2 + GFM renderer that returns,
// for every input, exactly the HTML marked 18.1.3 renders with its defaults
// (gfm on, breaks off, pedantic off, async off). Written from the CommonMark
// and GFM specs and from marked 18.1.3's published source (MIT, markedjs),
// reimplemented here in an original, single-file, dependency-free module
// with its own structure and its own speed-oriented design. No part of this
// file is copied from any earlier entry.
//
// Export: parse(markdown) -> string

// ---------------------------------------------------------------------------
// Regex builder: compose a big regex out of named fragments, the way the
// grammar is specified. `sub` splices a fragment's source in place of a
// placeholder name and strips a leading ^ from the fragment (a fragment's
// anchor means nothing once it sits inside a larger pattern).
// ---------------------------------------------------------------------------
const CARET = /(^|[^\[])\^/g;
function rx(source, flags = '') {
  let s = typeof source === 'string' ? source : source.source;
  const api = {
    sub(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(CARET, '$1');
      s = s.replace(name, v);
      return api;
    },
    done() { return new RegExp(s, flags); },
  };
  return api;
}

// ---------------------------------------------------------------------------
// "other": small shared patterns
// ---------------------------------------------------------------------------
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
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  // Neutralize a lazy setext underline, including one with trailing tabs.
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
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`),
  nextBulletRegex: cachedIndent((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: cachedIndent((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`)),
  fencesBeginRegex: cachedIndent((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndent((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndent((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndent((indent) => new RegExp(`^ {0,${indent}}>`)),
};
function cachedIndent(make) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) { re = make(idx); cache[idx] = re; }
    return re;
  };
}

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------
const NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/;
const HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_TEXT = /^[^\n]+/;
const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
function buildLheading(tableFrag) {
  const r = rx(LHEADING_CORE)
    .sub(/bull/g, BULLET)
    .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .sub(/blockquote/g, / {0,3}>/)
    .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .sub(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/)
    .sub(/html/g, / {0,3}<[^\n>]+>\n/);
  if (tableFrag) r.sub(/table/g, tableFrag);
  else r.sub(/\|table/g, '');
  return r.done();
}
const LHEADING = buildLheading('');

const DEF = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .sub('label', BLOCK_LABEL)
  .sub('title', /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .done();

const LIST_START = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).sub(/bull/g, BULLET).done();

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_BLOCK = rx(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))', 'i')
  .sub('comment', COMMENT)
  .sub('tag', TAG)
  .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s\"'=<>`]+)?/)
  .done();

const GFM_TABLE = rx(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .sub('hr', HR)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('blockquote', ' {0,3}>')
  .sub('code', '(?: {4}| {0,3}\\t)[^\\n]')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAG)
  .done();

const LHEADING_GFM = buildLheading(/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/);

// One combined test for the lines that can end a list item (fences,
// heading, html block, blockquote, next bullet, hr) and one for the four
// the previous line is checked against (fences, heading, html block, hr).
// The indent in the pattern is the clamped cache index (0-3), as in the
// single-purpose regexes above. Cached per indent, so a list pays for the
// construction once.
const _lineBeginCache = [[], []];
function lineBeginRegex(ci, full) {
  const arr = _lineBeginCache[full ? 1 : 0];
  let re = arr[ci];
  if (!re) {
    const mid = '(?:```|~~~)|#{1,6}(?:\\s|$)|</?(?:' + TAG + ')(?: +|$|/?>)'
      + '|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[';
    const tail = '|((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$))';
    const extra = full ? '|>|(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))' : '';
    re = new RegExp('^ {0,' + ci + '}(' + mid + extra + tail);
    arr[ci] = re;
  }
  return re;
}

const PARA_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listInterrupt, tableFrag) {
  const r = rx(PARA_CORE)
    .sub('hr', HR)
    .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .sub('|lheading', '');
  if (tableFrag) r.sub('table', tableFrag);
  else r.sub('|table', '');
  return r
    .sub('blockquote', ' {0,3}>')
    .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .sub('list', listInterrupt)
    .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .sub('tag', TAG)
    .done();
}
const PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, GFM_TABLE);
const BLOCKQUOTE_PARA = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, '');
const BLOCKQUOTE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).sub('paragraph', BLOCKQUOTE_PARA).done();

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------
const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM: ~ is not punctuation for strong/em (it is strikethrough's delimiter)
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

const PUNCTUATION = rx(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_OR_SPACE).done();

const BLOCK_SKIP = rx(/link|precode-code|html/, 'g')
  .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .sub('precode-', '(?<!`)()')
  .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub('html', /<(?! )[^<>]*?>/)
  .done();

const EM_STRONG_L_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_STRONG_L = rx(EM_STRONG_L_CORE, 'u').sub(/punct/g, PUNCT_GFM).done();

const EM_STRONG_R_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // skip orphan inside strong
  + '|[^*]+(?=[^*])' // consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter
const EM_STRONG_R_AST = rx(EM_STRONG_R_AST_CORE, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM)
  .sub(/punctSpace/g, PUNCT_OR_SPACE_GFM)
  .sub(/punct/g, PUNCT_GFM)
  .done();

// Normal: no rule 6 for _ (a___a cannot close as emphasis).
const EM_STRONG_R_UND = rx(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // skip orphan inside strong
  + '|[^_]+(?=[^_])' // consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .sub(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .sub(/punctSpace/g, PUNCT_OR_SPACE)
  .sub(/punct/g, PUNCT)
  .done();

const DEL_L = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).done();
const DEL_R_CORE =
  '^[^~]+(?=[^~])' // consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter
const DEL_R = rx(DEL_R_CORE, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .sub(/punctSpace/g, PUNCT_OR_SPACE)
  .sub(/punct/g, PUNCT)
  .done();

const ANY_PUNCT = rx(/\\(punct)/, 'gu').sub(/punct/g, PUNCT).done();
// Escapes outside code spans are masked for em/strong; a backslash inside a
// code span is literal, so the backticks inside the span are masked instead.
const ANY_PUNCT_OUTSIDE_CODE = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .sub(/punct/g, PUNCT)
  .done();

const AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .done();

const INLINE_COMMENT = rx(COMMENT).sub('(?:-->|$)', '-->').done();
const INLINE_TAG = rx(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction, e.g. <?php ?>
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration, e.g. <!DOCTYPE html>
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>') // CDATA section
  .sub('comment', INLINE_COMMENT)
  .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s\"'=<>`]+)?/)
  .done();

// One matched pair of brackets, holding no bracket of its own.
const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .sub('brackets', INLINE_LABEL_BRACKETS)
  .done();

const LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', INLINE_LABEL)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .done();

const REFLINK = rx(/^!?\[(label)\]\[(ref)\]/)
  .sub('label', INLINE_LABEL)
  .sub('ref', BLOCK_LABEL)
  .done();
const NOLINK = rx(/^!?\[(ref)\](?:\[\])?/)
  .sub('ref', BLOCK_LABEL)
  .done();

// reflinkSearch runs globally over a whole run, so its labels are bounded:
// the label itself to 999 items (CommonMark's cap) and the link text to 999
// bracket/escape/code-span items, leaving runs of ordinary characters
// unbounded so link text of any length is still found.
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .sub('brackets', INLINE_LABEL_BRACKETS)
  .done();
const REFLINK_SEARCH = rx(/reflink|nolink(?!\()/, 'g')
  .sub('reflink', rx(/^!?\[(label)\]\[(ref)\]/)
    .sub('label', BOUNDED_INLINE_LABEL)
    .sub('ref', BOUNDED_BLOCK_LABEL)
    .done())
  .sub('nolink', rx(/^!?\[(ref)\](?:\[\])?/)
    .sub('ref', BOUNDED_BLOCK_LABEL)
    .done())
  .done();

const CASE_INSENSITIVE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .sub(/email/g, EXTENDED_EMAIL)
  .done();
const GFM_URL = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub('emailProtocol', EXTENDED_EMAIL_PROTOCOL)
  .sub('protocol', CASE_INSENSITIVE_PROTOCOL)
  .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .done();
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// GFM inline text: stops at a delimiter, at an autolink start, or at a
// hard-break position. A www autolink starts only at a line start, after
// whitespace, or after *, _, ~ or (.
const INLINE_TEXT = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/)
  .sub('protocol', CASE_INSENSITIVE_PROTOCOL)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub('wwwStart', '(?<![^\\s*_~(])www\\.')
  .done();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(html, encode) {
  if (encode) {
    if (O.escapeTest.test(html)) return html.replace(O.escapeReplace, (ch) => ESCAPE_MAP[ch]);
  } else if (O.escapeTestNoEncode.test(html)) {
    return html.replace(O.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

// Numeric character references outside code stand for the character they
// name. Zero, out of range, or surrogate values become the replacement char.
// Every `&` that is not already a reference is escaped here, so a decoded
// character cannot join its neighbours into a new reference.
function decodeNumericRefs(text) {
  if (!O.numericCharacterReference.test(text)) return text;
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(O.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(O.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  }
  return cells;
}

// Remove trailing 'c's (or, with invert, trailing non-'c's). Equivalent to
// str.replace(/c*$/, '') but without the catastrophic-backtracking risk.
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str; // keep a single trailing blank line
  return lines.slice(0, end + 1).join('\n');
}

// CommonMark asks for a Unicode case fold, which toLowerCase() does not
// reach: ẞ lowercases to ß and so never meets SS. Round-tripping through
// upper case does, as in commonmark.js. Labels are also trimmed and their
// internal whitespace runs collapsed to one space.
function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

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

// One scan of a masked inline source for the last emphasis/strong and
// strikethrough closers, shared by every opener in the pass. A run can
// close only when it is not preceded by ASCII whitespace or the start of
// the string (the right-delim regexes accept a closer only in groups 1, 2,
// 5 and 6, and each of those requires that predecessor).
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
  return { lastEm, lastDel };
}

// ---------------------------------------------------------------------------
// Parse state: one fresh object per parse() call. Nothing is kept between
// calls, and nothing is written outside it.
// ---------------------------------------------------------------------------
function makeState() {
  return {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    inlineQueue: [],
    closerFrame: null, // { maskedSrc, lastEm, lastDel } for the current pass
  };
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes (S, src) and returns a token or undefined.
// `inline(S, src)` queues an inline pass: the tokens array is filled in
// later, once the block pass has collected every link definition.
// ---------------------------------------------------------------------------
function queueInline(S, src, tokens = []) {
  S.inlineQueue.push({ src, tokens });
  return tokens;
}

function tokSpace(S, src) {
  const cap = NEWLINE.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}

function tokCode(S, src) {
  const cap = BLOCK_CODE.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(O.codeRemoveIndent, '') };
  }
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(O.beginningSpace);
    if (mi === null) return node;
    // Up to the fence's own indentation is removed from each line, so a
    // line indented less than the fence loses whatever indentation it has.
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

function tokFences(S, src) {
  const cap = FENCES.exec(src);
  if (cap) {
    return {
      type: 'code',
      raw: cap[0],
      lang: cap[2] ? cap[2].trim().replace(ANY_PUNCT, '$1') : cap[2],
      text: indentCodeCompensation(cap[0], cap[3] || ''),
    };
  }
}

function tokHeading(S, src) {
  const cap = HEADING.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (O.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || O.endingSpaceTabChar.test(trimmed)) {
        // CommonMark requires a space or tab before trailing #s
        text = trimmed.trim();
      }
    }
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(S, text) };
  }
}

function tokHr(S, src) {
  const cap = HR.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokBlockquote(S, src) {
  const cap = BLOCKQUOTE.exec(src);
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
      // get lines up to a continuation
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
      // a tab after the block quote marker runs to the next tab stop, and
      // the marker only consumes one space of it; the rest is content
      .replace(O.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      // precede setext continuation with 4 spaces so it isn't a setext
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    // parse blockquote lines as top level tokens; merge paragraphs if this
    // is a continuation
    const top = S.top;
    S.top = true;
    blockTokens(S, currentText, tokens, true);
    S.top = top;

    if (lines.length === 0) break;

    const lastToken = tokens.at(-1);
    if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
      // blockquote continuation cannot be preceded by a code block, heading, hr, html block or table
      break;
    } else if (lastToken?.type === 'blockquote') {
      // include continuation in nested blockquote
      const oldToken = lastToken;
      // The continuation lines belong to the same nesting frame as the
      // nested blockquote, which already had one '>' marker stripped, so
      // strip one marker from them too.
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(S, newText);
      tokens[tokens.length - 1] = newToken;
      // Only include continuation lines the nested blockquote actually
      // consumed. Unconsumed trailing lines must stay out of `raw` so the
      // lexer can still tokenize them.
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      // A leftover line that starts with '>' still belongs to this
      // blockquote; any other leftover line ends it.
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.type === 'list') {
      // include continuation in nested list
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(S, newText);
      tokens[tokens.length - 1] = newToken;
      // The list raw has no '>' markers, so it cannot be cut out of `raw`.
      // Count the continuation lines the list took and add those lines instead.
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

function tokList(S, src) {
  let cap = LIST_START.exec(src);
  if (!cap) return;
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;

  const list = {
    type: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  const itemRegex = O.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    if (HR.test(src)) break; // bullet was actually HR

    const itemStart = taken();
    src = src.substring(cap[0].length);

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
    const nl0 = src.indexOf('\n');
    let nextLine = nl0 === -1 ? src : src.slice(0, nl0);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar); // find first non-space char
      indent = indent > 4 ? 1 : indent; // indented code blocks (> 4 spaces) count as 1 indent
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && O.blankLine.test(nextLine)) { // items begin with at most one blank line
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const ci = Math.max(0, Math.min(3, indent - 1));
      const beginAll = lineBeginRegex(ci, true);
      const begin4 = lineBeginRegex(ci, false);

      // Walk the remaining lines by index instead of slicing and
      // splitting the whole remainder once per line.
      let pos = 0;
      while (pos < src.length) {
        const nl = src.indexOf('\n', pos);
        const rawLine = nl === -1 ? src.slice(pos) : src.slice(pos, nl);
        nextLine = rawLine;
        const nextLineWithoutTabs = rawLine.includes('\t')
          ? rawLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace))
          : rawLine;

        if (beginAll.test(nextLine)) break; // fences, heading, html, blockquote, bullet or hr end the item

        if (nextLineWithoutTabs.search(O.nonSpaceChar) >= indent || O.blankLine.test(nextLine)) { // dedent if possible
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          // not enough indentation
          if (blankLine) break;
          // paragraph continuation unless last line was a different block level element
          if ((line.includes('\t') ? line.replace(O.tabCharGlobal, '    ') : line).search(O.nonSpaceChar) >= 4) break; // indented code block
          if (begin4.test(line)) break;
          // A lazy continuation can look like a setext underline after
          // list indentation is removed. Keep it in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && LHEADING_GFM.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = O.blankLine.test(nextLine);
        pos = nl === -1 ? src.length : nl + 1;
        line = nextLineWithoutTabs.slice(indent);
      }
      src = src.slice(pos);
    }

    // The loops above appended a '\n' the source may not have had. It could
    // only land on the item that exhausts src, whose raw is trimmed below.
    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (O.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      type: 'list_item',
      raw,
      task: !!O.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  // Do not consume newlines at end of final item.
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return; // not a list since there were no items
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  // Item child tokens handled here at end because we needed the final item trimmed first.
  // First pass: tokenize items and finalize list.loose from spacers before placing checkboxes.
  for (const item of list.items) {
    S.top = false;
    item.tokens = blockTokens(S, item.text, []);
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
      // Remove checkbox markdown from item tokens
      item.text = item.text.replace(O.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(O.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(O.listReplaceTask, '');
      for (let i = S.inlineQueue.length - 1; i >= 0; i--) {
        if (O.listIsTask.test(S.inlineQueue[i].src)) {
          S.inlineQueue[i].src = S.inlineQueue[i].src.replace(O.listReplaceTask, '');
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
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
            item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkboxToken);
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: checkboxToken.raw,
              text: checkboxToken.raw,
              tokens: [checkboxToken],
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

  // Set all items to loose if list is loose
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

function tokHtml(S, src) {
  const cap = HTML_BLOCK.exec(src);
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

function tokDef(S, src) {
  const cap = DEF.exec(src);
  if (cap) {
    // outside angle brackets a link destination holds only balanced parentheses
    if (!O.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokTable(S, src) {
  const cap = GFM_TABLE.exec(src);
  if (!cap) return;
  if (!O.tableDelimiter.test(cap[2])) {
    // delimiter row must have a pipe (|) or colon (:) otherwise it is a setext heading
    return;
  }
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];

  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) {
    // header and align columns must be equal, rows can be different
    return;
  }
  for (const align of aligns) {
    if (O.tableAlignRight.test(align)) item.align.push('right');
    else if (O.tableAlignCenter.test(align)) item.align.push('center');
    else if (O.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], tokens: queueInline(S, headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell, tokens: queueInline(S, cell), header: false, align: item.align[i],
    })));
  }
  return item;
}

function tokLheading(S, src) {
  if (!/\n {0,3}[=-]/.test(src)) return undefined;
  const cap = LHEADING_GFM.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: queueInline(S, text),
    };
  }
}

function tokParagraph(S, src) {
  const cap = PARAGRAPH.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(S, text) };
  }
}

function tokText(S, src) {
  const cap = BLOCK_TEXT.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(S, cap[0]) };
  }
}

function infiniteLoopError(byte) {
  throw new Error('Infinite loop on byte: ' + byte);
}

// The block pass. `lastParagraphClipped` is set when a blockquote feeds a
// clipped paragraph continuation: a paragraph token that follows one merges
// into it instead of starting a new one.
function blockTokens(S, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      infiniteLoopError(src.charCodeAt(0));
      break;
    }

    let token;

    // newline
    if (token = tokSpace(S, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        // a single \n as a spacer terminates the last line, so move it
        // there instead of making an unnecessary paragraph break
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    // code
    if (token = tokCode(S, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      // An indented code block cannot interrupt a paragraph.
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    // fences
    if (token = tokFences(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // heading
    if (token = tokHeading(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // hr
    if (token = tokHr(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // blockquote
    if (token = tokBlockquote(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // list
    if (token = tokList(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // html
    if (token = tokHtml(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // def
    if (token = tokDef(S, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        S.inlineQueue.at(-1).src = lastToken.text;
      } else {
        // The first definition of a label wins, but a later one still consumes its text
        if (!S.links[token.tag]) {
          S.links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }

    // table (gfm)
    if (token = tokTable(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // lheading
    if (token = tokLheading(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // top-level paragraph
    if (S.top && (token = tokParagraph(S, src))) {
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.inlineQueue.pop();
        S.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      src = src.substring(token.raw.length);
      lastParagraphClipped = false;
      continue;
    }

    // text
    if (token = tokText(S, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.inlineQueue.pop();
        S.inlineQueue.at(-1).src = lastToken.text;
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

  S.top = true;
  return tokens;
}

// Top-level lex: normalize line endings, run the block pass, then flush the
// queued inline passes (link definitions are all known by then).
function lex(S, src) {
  if (src.includes('\r')) src = src.replace(O.carriageReturn, '\n');
  const tokens = [];
  tokens.links = S.links;
  blockTokens(S, src, tokens);
  for (let i = 0; i < S.inlineQueue.length; i++) {
    const next = S.inlineQueue[i];
    // an inline <pre>, <code>, <kbd> or <script> left open ends with the
    // block holding it; carried over, it would stop every later block's
    // text from being escaped
    S.inRawBlock = false;
    inlineTokens(S, next.src, next.tokens);
  }
  S.inlineQueue = [];
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline tokenizers
// ---------------------------------------------------------------------------
function outputLink(S, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const tokens = inlineTokens(S, text);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;

  if (!isImage) {
    // CommonMark: "Links may not contain other links, at any level of nesting."
    // Bail so the caller falls through to text and the inner link is kept.
    // Images are exempt: their text is flattened into an alt attribute.
    if (textHasLink) {
      // these tokens are discarded, so undo the raw-block state they opened;
      // leaving it set would suppress escaping for the text that is re-scanned
      S.inRawBlock = outerInRawBlock;
      return undefined;
    }
    S.linkEmitted = true;
  }

  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE_TAG.exec(tokenSrc) || AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function tokEscape(S, src) {
  const cap = INLINE_ESCAPE.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}

function tokTag(S, src) {
  const cap = INLINE_TAG.exec(src);
  if (cap) {
    if (!S.inLink && O.startATag.test(cap[0])) S.inLink = true;
    else if (S.inLink && O.endATag.test(cap[0])) S.inLink = false;
    if (!S.inRawBlock && O.startPreScriptTag.test(cap[0])) S.inRawBlock = true;
    else if (S.inRawBlock && O.endPreScriptTag.test(cap[0])) S.inRawBlock = false;
    return {
      type: 'html',
      raw: cap[0],
      inLink: S.inLink,
      inRawBlock: S.inRawBlock,
      block: false,
      text: cap[0],
    };
  }
}

function tokLink(S, src) {
  // The link regex backtracks quadratically over unterminated-link inputs
  // like '[a](b'.repeat(n): at every '[' its greedy unquoted-href run
  // re-partitions the whole remainder while hunting for a ')' that never
  // comes. inlineTokens anchors one paren scan per run in
  // linkParenPossible; when it is false the regex cannot match, so bail
  // out before running it.
  if (S.linkParenPossible === false) return undefined;
  const cap = LINK.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;

    const trimmedUrl = cap[2].trim();
    if (O.startAngleBracket.test(trimmedUrl)) {
      // commonmark requires matching angle brackets
      if (!(O.endAngleBracket.test(trimmedUrl))) return undefined;
      // ending angle bracket cannot be escaped
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return undefined;
    } else {
      // find closing parenthesis
      const lastParenIndex = findClosingBracket(cap[2], '()');
      if (lastParenIndex === -2) return undefined; // more open parens than closed
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    // The ')' that ends the match is the link closer only when it is not
    // escaped. `[foo](/url\)` has no closer; that paren is destination text.
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;
    let href = cap[2];
    let title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (O.startAngleBracket.test(href)) {
      href = href.slice(1, -1);
    }
    return outputLink(S, cap, {
      href: href ? href.replace(ANY_PUNCT, '$1') : href,
      title: title ? title.replace(ANY_PUNCT, '$1') : title,
    }, cap[0]);
  }
}

function tokReflink(S, src) {
  let cap;
  if ((cap = REFLINK.exec(src)) || (cap = NOLINK.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;
    const link = S.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return outputLink(S, cap, link, cap[0]);
  }
}

function lastEmStrongCloser(S, maskedSrc, delim) {
  const frame = S.closerFrame;
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastEm[delim];
  return scanClosers(maskedSrc).lastEm[delim];
}
function lastDelCloser(S, maskedSrc) {
  const frame = S.closerFrame;
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastDel;
  return scanClosers(maskedSrc).lastDel;
}

function tokEmStrong(S, src, maskedSrc, prevChar = '') {
  let match = EM_STRONG_L.exec(src);
  if (!match) return undefined;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;

  const delimChar = match[0][0];
  // A mid-run opener (for example the second star of an unmatched `**`)
  // must only pair with a delimiter that can only close, otherwise it
  // steals the opener of a later span (`**a*b*c` must be `**a<em>b</em>c`).
  const midRun = prevChar === delimChar;

  // The start of this delimiter run may already be behind src, either
  // taken as text after the whole run failed to match or used to close an
  // earlier span. Flanking and rules 9-10 are about the whole run, so find
  // its start.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = runStart > 0 ? maskedSrc[runStart - 1] : '';
  // The other delimiter character counts as punctuation here (`_**a*`)
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!PUNCTUATION.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!PUNCTUATION.exec(prevChar);

  // _ can't be between two alphanumerics. \p{L}\p{N} includes non-english alphabet/numbers as well
  if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return undefined;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    // unicode Regex counts emoji as 1 char; spread into array for proper count (used multiple times below)
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    // Rules 9-10 count the whole run, and also apply when the opener could
    // close as well (`a*b**`, where `*` is both left- and right-flanking).
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return undefined;
    const endReg = delimChar === '*' ? EM_STRONG_R_AST : EM_STRONG_R_UND;
    const lastPossibleEmStrongCloserIndex = lastEmStrongCloser(S, maskedSrc, delimChar);
    const emStrongCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleEmStrongCloserIndex < emStrongCloserWindowStart) return undefined;
    // Clip maskedSrc to same section of string as src
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleEmStrongCloserIndexInWindow = lastPossibleEmStrongCloserIndex - emStrongCloserWindowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleEmStrongCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

      if (!rDelim) continue; // skip single * in __abc*abc__

      rLength = [...rDelim].length;

      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either Left or Right Delim
        if (midRun && (match[5] || match[6])) {
          // A mid-run opener cannot close against an ambiguous delimiter
          // that can also open; that delimiter opens its own emphasis span.
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark Emphasis Rules 9-10
        }
      }

      delimTotal -= rLength;

      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters. *a*** -> *a*
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      // char length can be >1 for unicode characters;
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      // Create `em` if smallest delimiter has odd char count. *a***
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(S, text) };
      }

      // Create 'strong' if smallest delimiter has even char count. **a***
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(S, text) };
    }
  }
}

function tokCodespan(S, src) {
  const cap = INLINE_CODE.exec(src);
  if (cap) {
    let text = cap[2].replace(O.newLineCharGlobal, ' ');
    const hasNonSpaceChars = O.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
      text = text.substring(1, text.length - 1);
    }
    return { type: 'codespan', raw: cap[0], text };
  }
}

function tokBr(S, src) {
  const cap = INLINE_BR.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}

function tokDel(S, src, maskedSrc, prevChar = '') {
  let match = DEL_L.exec(src);
  if (!match) return undefined;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || PUNCTUATION.exec(prevChar)) {
    // unicode Regex counts emoji as 1 char; spread into array for proper count
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;

    const endReg = DEL_R;
    const lastPossibleDelCloserIndex = lastDelCloser(S, maskedSrc);
    const delCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleDelCloserIndex < delCloserWindowStart) return undefined;
    // Clip maskedSrc to same section of string as src
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleDelCloserIndexInWindow = lastPossibleDelCloserIndex - delCloserWindowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleDelCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

      if (!rDelim) continue;

      rLength = [...rDelim].length;

      if (rLength !== lLength) continue;

      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      }

      delimTotal -= rLength;

      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters
      rLength = Math.min(rLength, rLength + delimTotal);
      // char length can be >1 for unicode characters
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      // Create del token - only single ~ or double ~~ supported
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(S, text) };
    }
  }
}

function tokAutolink(S, src) {
  const cap = AUTOLINK.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

function tokUrl(S, src) {
  let cap;
  if (cap = GFM_URL.exec(src)) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      // do extended autolink path validation
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = BACKPEDAL.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      if (cap[1] === 'www.') {
        href = 'http://' + cap[0];
      } else {
        href = cap[0];
      }
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

const INLINE_TEXT_TRIGGER = /[\\<!\[`*~_]|www\.|mailto:|xmpp:|\/\/|@| {2,}\n/;
function tokInlineText(S, src) {
  const cap = INLINE_TEXT_TRIGGER.test(src) ? INLINE_TEXT.exec(src) : [src];
  if (cap) {
    const escaped = S.inRawBlock;
    return {
      type: 'text',
      raw: cap[0],
      // raw HTML keeps whatever it was written with, everywhere else a
      // numeric character reference stands for the character itself
      text: escaped ? cap[0] : decodeNumericRefs(cap[0]),
      escaped,
    };
  }
}

// ---------------------------------------------------------------------------
// Masking: links, code spans, html and escapes are hidden from emStrong and
// del so their delimiters are not mistaken for emphasis markers. Every mask
// keeps the length it replaces: emStrong and del line maskedSrc up with src
// by slicing from the end.
// ---------------------------------------------------------------------------
function linkInText(S, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP)) {
    // blockSkip also matches code spans and html, and the `!` of an image
    // is left out of the match, so read the character before it.
    if (LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    // a candidate holding a link is not a link either, so it does not count
    if (refStart > 1 && linkInText(S, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

function maskSrc(S, src) {
  let maskedSrc = src;

  // Mask out reflinks
  if (S.links && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      // CommonMark: "Links may not contain other links, at any level of
      // nesting." A candidate whose text already holds one never becomes a
      // link, so flattening the whole span would hide the emphasis that
      // does still apply inside it. Mask the links it holds instead.
      // Images are exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(S, text)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(REFLINK_SEARCH, maskReflink);
  }

  // Mask out escaped characters and other blocks. Both passes can only
  // match when the source holds a backslash, a backtick, a '<' or a '[';
  // one cheap test skips both whole-string replaces when it holds none.
  // `anyPunctuation` matches unicode punctuation, so an escaped astral
  // character is 3 code units. A backslash inside a code span is literal,
  // not an escape. Mask the backticks inside the span instead, so
  // blockSkip still skips all of it.
  if (/[\\`<[]/.test(maskedSrc)) {
    maskedSrc = maskedSrc.replace(ANY_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });

    // Mask out other blocks
    maskedSrc = maskedSrc.replace(BLOCK_SKIP, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }

  return maskedSrc;
}

function inlineTokens(S, src, tokens = []) {
  // One paren scan per inline run, shared with tokLink: without a ')'
  // ahead the link regex cannot match, and skipping it avoids its
  // quadratic backtracking over unterminated-link inputs like
  // `'[a](b'.repeat(n)`. A nested run receives a substring of the outer
  // run, so if the outer had no ')' neither does this substring — skip
  // the scan in that case.
  const prevLinkParenPossible = S.linkParenPossible;
  S.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(S, src, tokens);
  } finally {
    // A nested run (e.g. a link label) anchored on its own substring;
    // restore the outer run's flag for the rest of its loop.
    S.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(S, src, tokens) {
  // The masked source is only read by emStrong and del, which need a *,
  // _ or ~ to start. Skip building it for a run without one.
  const maskedSrc = src.includes('*') || src.includes('_') || src.includes('~')
    ? maskSrc(S, src)
    : src;

  // One scan of this maskedSrc for the last emphasis, strong, and
  // strikethrough closers, shared by every opener in the pass.
  const prevFrame = S.closerFrame;
  S.closerFrame = { maskedSrc, ...scanClosers(maskedSrc) };
  try {
    return tokenizeInlines(S, src, maskedSrc, tokens);
  } finally {
    S.closerFrame = prevFrame;
  }
}

function tokenizeInlines(S, src, maskedSrc, tokens) {
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

    let token;

    // escape
    if (token = tokEscape(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // tag
    if (token = tokTag(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // link
    if (token = tokLink(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // reflink, nolink
    if (token = tokReflink(S, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.type === 'text' && lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    // em & strong
    if (token = tokEmStrong(S, src, maskedSrc, prevChar)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // code
    if (token = tokCodespan(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // br
    if (token = tokBr(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // del (gfm)
    if (token = tokDel(S, src, maskedSrc, prevChar)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // autolink
    if (token = tokAutolink(S, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // url (gfm)
    if (!S.inLink && (token = tokUrl(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // text
    if (token = tokInlineText(S, src)) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') { // track prevChar before a run of ____ started
        prevChar = token.raw.slice(-1);
      }
      keepPrevChar = true;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
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

  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering: tokens -> HTML. Adjacent text tokens were already merged in
// the inline loop, so entity-escaping here always sees the whole run at
// once (merging after escaping would double-escape a reference split
// across two runs).
// ---------------------------------------------------------------------------
function renderInline(S, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'escape':
      case 'text': {
        out += token.escaped ? token.text : escapeHtml(token.text);
        break;
      }
      case 'html': {
        out += token.text;
        break;
      }
      case 'link': {
        // References are not resolved inside an autolink, so every `&`
        // there is literal. Elsewhere only an `&` that cannot start one
        // needs escaping.
        const parsedText = token.autolink
          ? escapeHtml(token.text, true)
          : renderInline(S, token.tokens);
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) {
          out += parsedText;
          break;
        }
        const href = escapeHtml(cleanHref, token.autolink);
        let linkOut = '<a href="' + href + '"';
        if (token.title) linkOut += ' title="' + escapeHtml(token.title) + '"';
        linkOut += '>' + parsedText + '</a>';
        out += linkOut;
        break;
      }
      case 'image': {
        let text = token.text;
        if (token.tokens) text = renderPlainText(S, token.tokens);
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) {
          out += escapeHtml(text);
          break;
        }
        let imgOut = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(text)}"`;
        if (token.title) imgOut += ` title="${escapeHtml(token.title)}"`;
        imgOut += '>';
        out += imgOut;
        break;
      }
      case 'checkbox': {
        out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      }
      case 'strong': {
        out += `<strong>${renderInline(S, token.tokens)}</strong>`;
        break;
      }
      case 'em': {
        out += `<em>${renderInline(S, token.tokens)}</em>`;
        break;
      }
      case 'codespan': {
        out += `<code>${escapeHtml(token.text, true)}</code>`;
        break;
      }
      case 'br': {
        out += '<br>';
        break;
      }
      case 'del': {
        out += `<del>${renderInline(S, token.tokens)}</del>`;
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
  return out;
}

// Plain-text rendering for image alt text: no tags, no links, just text.
function renderPlainText(S, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'text':
      case 'escape':
        out += token.text;
        break;
      case 'html':
        out += token.text;
        break;
      case 'link':
      case 'image':
        out += renderPlainText(S, token.tokens);
        break;
      case 'strong':
      case 'em':
      case 'del':
        out += renderPlainText(S, token.tokens);
        break;
      case 'codespan':
        out += token.text;
        break;
      case 'br':
        out += '';
        break;
      case 'checkbox':
        out += token.raw;
        break;
      default:
        break;
    }
  }
  return out;
}

function renderTokens(S, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'space': {
        break;
      }
      case 'hr': {
        out += '<hr>\n';
        break;
      }
      case 'heading': {
        out += `<h${token.depth}>${renderInline(S, token.tokens)}</h${token.depth}>\n`;
        break;
      }
      case 'code': {
        const langString = (token.lang || '').match(O.notSpaceStart)?.[0];
        // An empty code block has no content, so it must not gain a newline.
        const code = token.text ? token.text.replace(O.endingNewline, '') + '\n' : '';
        if (!langString) {
          out += '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-' + escapeHtml(langString) + '">'
            + escapeHtml(code, true) + '</code></pre>\n';
        }
        break;
      }
      case 'table': {
        let header = '';
        let cell = '';
        for (let j = 0; j < token.header.length; j++) {
          cell += renderTableCell(S, token.header[j]);
        }
        header += `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (let j = 0; j < token.rows.length; j++) {
          const row = token.rows[j];
          cell = '';
          for (let k = 0; k < row.length; k++) {
            cell += renderTableCell(S, row[k]);
          }
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n' + '<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote': {
        out += `<blockquote>\n${renderTokens(S, token.tokens)}</blockquote>\n`;
        break;
      }
      case 'list': {
        let body = '';
        for (let j = 0; j < token.items.length; j++) {
          body += `<li>${renderTokens(S, token.items[j].tokens)}</li>\n`;
        }
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox': {
        out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      }
      case 'html': {
        out += token.text;
        break;
      }
      case 'def': {
        break;
      }
      case 'paragraph': {
        out += `<p>${renderInline(S, token.tokens)}</p>\n`;
        break;
      }
      case 'text': {
        out += 'tokens' in token && token.tokens
          ? renderInline(S, token.tokens)
          : escapeHtml(token.text);
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
  return out;
}

function renderTableCell(S, cellToken) {
  const content = renderInline(S, cellToken.tokens);
  const type = cellToken.header ? 'th' : 'td';
  const tag = cellToken.align ? `<${type} align="${cellToken.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function parse(markdown) {
  const S = makeState();
  const tokens = lex(S, markdown);
  return renderTokens(S, tokens);
}
