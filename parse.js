// SwiftMark — a dependency-free CommonMark + GFM parser matching marked 18.1.3.
// Written from scratch against the CommonMark/GFM spec and differential
// testing against marked; architecture and code are my own.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_FULL_TEST = /[&<>"']/;
const ESC_FULL_RE = /[&<>"']/g;
// No-encode: an & that already starts an entity-like sequence stays literal.
const ESC_TEXT_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_TEXT_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escFull(s) {
  if (!ESC_FULL_TEST.test(s)) return s;
  return s.replace(ESC_FULL_RE, (ch) => ESCAPE_MAP[ch]);
}

function escText(s) {
  if (!ESC_TEXT_TEST.test(s)) return s;
  return s.replace(ESC_TEXT_RE, (ch) => ESCAPE_MAP[ch]);
}

// Numeric character references only (named entities pass through verbatim).
// A bare & that cannot start a reference becomes &amp; here.
const NUM_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumRefs(s) {
  if (!NUM_REF_TEST.test(s)) return s;
  return s.replace(NUM_REF_RE, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

// Expand tabs to spaces; `indent` is the column the whitespace starts at.
function expandTabs(line, indent) {
  let col = indent || 0;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ASCII punctuation table (code points 0x21-0x2F, 0x3A-0x40, 0x5B-0x60, 0x7B-0x7E).
const ASCII_PUNCT = new Uint8Array(128);
for (let c = 0x21; c <= 0x2F; c++) ASCII_PUNCT[c] = 1;
for (let c = 0x3A; c <= 0x40; c++) ASCII_PUNCT[c] = 1;
for (let c = 0x5B; c <= 0x60; c++) ASCII_PUNCT[c] = 1;
for (let c = 0x7B; c <= 0x7E; c++) ASCII_PUNCT[c] = 1;
// Characters that may appear in an email address (the extended-autolink
// email character class, ASCII only).
const EMAIL_CHAR_TABLE = new Uint8Array(128);
for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&\'*+/=?^_`{|}~-') EMAIL_CHAR_TABLE[ch.charCodeAt(0)] = 1;

const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/u;

// Unicode punctuation or symbol (plain set: ~ counts as punctuation).
function isPunct(ch) {
  const code = ch.codePointAt(0);
  if (code < 128) return ASCII_PUNCT[code] === 1;
  return UNICODE_PUNCT_RE.test(ch);
}

// GFM emphasis flanking: ~ is a word character, not punctuation.
function isPunctGfm(ch) {
  return ch !== '~' && isPunct(ch);
}

function isSpace(ch) {
  return SPACE_RE.test(ch);
}

function isSpaceOrPunct(ch) {
  return isSpace(ch) || isPunct(ch);
}

function isNotSpaceOrPunct(ch) {
  return !isSpace(ch) && !isPunct(ch);
}

function isSpaceOrPunctGfm(ch) {
  return isSpace(ch) || isPunctGfm(ch);
}

function isNotSpaceOrPunctGfm(ch) {
  return !isSpace(ch) && !isPunctGfm(ch);
}

// The `punctuation` rule: whitespace or punctuation, except * and _.
function isPunctSpace(ch) {
  return ch !== '*' && ch !== '_' && (isSpace(ch) || isPunct(ch));
}

function rtrim(s, c) {
  let i = s.length;
  while (i > 0 && s[i - 1] === c) i--;
  return s.slice(0, i);
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find a closing bracket: index of an excess ')', -2 if more '(' than ')',
// -1 if there is no unbalanced ')' (balanced or none at all).
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Remove backslashes before punctuation (unicode punctuation set).
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
function unescapePunct(s) {
  return s.replace(ANY_PUNCT_RE, '$1');
}

// ---------------------------------------------------------------------------
// Inline matchers
// ---------------------------------------------------------------------------

// <scheme:...> or <email>; group 2 is '@' for the email form.
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;

function matchAutolink(s, i) {
  const m = AUTOLINK_RE.exec(s.slice(i));
  if (!m) return null;
  const text = m[1];
  return { text, href: m[2] === '@' ? 'mailto:' + text : text, end: i + m[0].length };
}

// GFM extended autolink: mailto:/xmpp: email, protocol:// or www. host,
// or a bare email. Group 1 is the protocol/www prefix, group 2 is '@'.
const EMAIL_SRC = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const URL_RE = new RegExp(
  '^(?:mailto:' + EMAIL_SRC
  + '|xmpp:' + EMAIL_SRC + '(?:\\/[A-Za-z0-9@.]+)?'
  + '|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*'
  + '|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-]))'
);

function matchUrl(s, i, prev, skipWwwCheck) {
  const m = URL_RE.exec(s.slice(i));
  if (!m) return null;
  const text = m[0];
  if (m[2] === '@') return { text, href: 'mailto:' + text, backpedal: false, www: false, email: true };
  if (m[1] === 'www.') {
    // www. only after the start, whitespace, *, _, ~ or ( — unless the
    // lexer is at a fresh position (just after a token: marked's url
    // rule itself has no lookbehind, so it matches there whatever the
    // previous character is), reached the 'w' via the email lookahead
    // walk, or the email lookahead is true here (an '@' ahead reachable
    // through email characters): marked's text rule then shrinks one
    // character at a time until the url rule fires, so the www. link is
    // made even after a failed '[', backtick or '<' that became text
    if (!skipWwwCheck && prev !== '' && !/[\s*_~(]/.test(prev)) {
      EMAIL_AHEAD_RE.lastIndex = i;
      if (!EMAIL_AHEAD_RE.test(s)) return null;
    }
    return { text, href: 'http://' + text, backpedal: true, www: true, email: false };
  }
  if (text.startsWith('mailto:') || text.startsWith('xmpp:')) {
    if (prev !== '' && /[A-Za-z0-9]/.test(prev)) return null;
  }
  return { text, href: text, backpedal: true, www: false, email: false };
}

// Trims trailing punctuation, unbalanced '(' and trailing &entity; from a
// matched extended autolink, run until stable.
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(text) {
  let prev;
  do {
    prev = text;
    text = BACKPEDAL_RE.exec(text)?.[0] ?? '';
  } while (text !== prev);
  return text;
}

// Length of the backtick run starting at s[i].
function backtickRun(s, i) {
  let j = i;
  while (j < s.length && s[j] === '`') j++;
  return j - i;
}

// Index just past the closing backtick run of length k for a code span
// opening at s[i] (run length k), or -1. The closing run must be exactly k
// backticks and the content must be at least one character.
function codeSpanEnd(s, i, k) {
  let j = i + k;
  while (j < s.length) {
    if (s[j] === '`') {
      let e = j;
      while (e < s.length && s[e] === '`') e++;
      if (e - j === k && e > i + k) return e;
      j = e;
    } else {
      j++;
    }
  }
  return -1;
}

// A bracket group starting at s[i] === '[': '[' + (nested groups | escapes
// | other chars)* + ']'. `levels` is how many more nested groups may appear
// inside. Returns the index just after the closing ']' or -1.
function bracketGroupEnd(s, i, levels) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') {
      if (levels <= 0) return -1;
      const inner = bracketGroupEnd(s, j, levels - 1);
      if (inner === -1) return -1;
      j = inner;
      continue;
    }
    if (c === ']') return j + 1;
    j++;
  }
  return -1;
}

// Code-span fragment inside a link label: a backtick run, non-backtick
// content, a backtick run (any length, not followed by a backtick), or a
// backtick run right before the closing ']'.
const LABEL_CODE_RE = /^`+(?!`)[^`]*?`+(?!`)|^``+(?=\])/;

// End of an inline link label starting at s[start] === '[': the index just
// after its closing ']', or -1. Labels nest to two levels, hold escapes and
// code spans; a bare backtick that opens no code span ends the label.
function labelEnd(s, start) {
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = backtickRun(s, i);
      // A run of 2+ backticks immediately before the closing ']' ends the
      // label (the `` ``+(?=\]) `` alternative). It must be tried before the
      // loose code-span pattern, which would otherwise pair this run with a
      // far-away backtick and swallow the label's real end.
      if (k >= 2 && s[i + k] === ']') {
        i += k;
        continue;
      }
      const m = LABEL_CODE_RE.exec(s.slice(i));
      if (!m) return -1;
      i += m[0].length;
      continue;
    }
    if (c === '[') {
      const g = bracketGroupEnd(s, i, 1);
      if (g === -1) return -1;
      i = g;
      continue;
    }
    if (c === ']') return i + 1;
    i++;
  }
  return -1;
}

// End of a block label (link reference, reflink ref) starting at s[start]
// === '[': the index just after its closing ']', or -1. A block label holds
// escapes and any character except '[', ']' and a newline (a newline is
// allowed only when the next line is not blank), and may not be empty.
function blockLabelEnd(s, start) {
  let i = start + 1;
  // the (?!\\s*\\]) guard: no empty or whitespace-only label
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= s.length || s[j] === ']') return -1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      // newline allowed only when the next line is not blank
      let k = i + 1;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= s.length || s[k] === '\n') return -1;
      i++;
      continue;
    }
    if (c === '[' || c === ']') {
      if (c === ']') return i + 1;
      return -1;
    }
    i++;
  }
  return -1;
}

// True when the label's closing ']' sits inside an HTML tag or autolink
// that starts inside the label. `labelStart` is the index of the label's
// first character in s.
function labelEndInsideToken(s, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(label.slice(i));
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = s.slice(labelStart + i);
    const tag = matchTag(tokenSrc, 0);
    const auto = tag === null ? matchAutolink(tokenSrc, 0) : null;
    if (tag === null && auto === null) continue;
    const len = tag !== null ? tag.length : auto.end;
    if (len > label.length - i) return true;
    i += len - 1;
  }
  return false;
}

// Parse an inline link destination starting at s[i] === '('.
// Returns {href, title, end} or null. Mirrors the link regex plus its
// post-processing: an angle-bracket destination must close with an
// unescaped '>', a bare destination is cut back at an excess ')', and the
// closing ')' itself must not be escaped.
function parseInlineDest(s, i) {
  let j = i + 1;
  // whitespace (spaces, tabs, newlines) after '('
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= s.length) return null;
  let href = '';
  let title = '';
  let end = -1;
  if (s[j] === '<') {
    // angle-bracket destination: <...> with escapes, no newline or '<' '>'
    let k = j + 1;
    let ok = false;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === '\n' || c === '<' || c === '>') {
        ok = c === '>';
        break;
      }
      k++;
    }
    if (!ok) return null;
    // the '>' must not be escaped (odd number of backslashes before it)
    let backslashes = 0;
    let p = k - 1;
    while (p > j && s[p] === '\\') {
      backslashes++;
      p--;
    }
    if (backslashes % 2 === 1) return null;
    href = s.slice(j + 1, k);
    const rest = k + 1;
    // optional title, then whitespace, then ')'
    const after = destTail(s, rest);
    if (!after) return null;
    title = after.title;
    end = after.end;
  } else {
    // bare destination: a run of non-space, non-control characters
    let k = j;
    while (k < s.length) {
      const c = s[k];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      k++;
    }
    if (k === j) {
      // empty destination: allowed only when ')' follows immediately
      if (s[j] !== ')') return null;
      return { href: '', title: '', end: j + 1 };
    }
    const runEnd = k;
    // the tail after the run: a title, or whitespace then ')', else the
    // link closes at the last ')' inside the run
    let tail = destTail(s, runEnd);
    if (tail) {
      href = s.slice(j, runEnd);
      title = tail.title;
      end = tail.end;
    } else {
      let cut = runEnd - 1;
      while (cut >= j && s[cut] !== ')') cut--;
      if (cut < j) return null;
      href = s.slice(j, cut);
      end = cut + 1;
    }
    // cut back at an excess ')' inside the destination (drops any title).
    // marked's truncation counts from the '(' without the whitespace
    // before the destination, so the link ends at i + paren + 2 even when
    // that lands inside the destination text.
    const paren = findClosingBracket(href, '()');
    if (paren === -2) return null;
    if (paren > -1) {
      href = href.slice(0, paren);
      title = '';
      end = i + paren + 2;
    }
  }
  // the closing ')' must not be escaped
  let backslashes = 0;
  let p = end - 2;
  while (p >= i && s[p] === '\\') {
    backslashes++;
    p--;
  }
  if (backslashes % 2 === 1) return null;
  return { href: unescapePunct(href), title: unescapePunct(title), end };
}

// The tail of an inline link destination starting at s[i]: an optional
// title (after whitespace) followed by whitespace and ')', or just
// whitespace and ')'. Returns {title, end} (end = index just after the
// closing ')') or null.
function destTail(s, i) {
  let t = i;
  // whitespace before the title or the closer
  let sep = t;
  while (sep < s.length && (s[sep] === ' ' || s[sep] === '\t')) sep++;
  if (sep < s.length && s[sep] === '\n') {
    let after = sep + 1;
    while (after < s.length && (s[after] === ' ' || s[after] === '\t')) after++;
    sep = after;
  }
  if (sep > t) {
    const titleRes = tryTitle(s, sep);
    if (titleRes) {
      let e = titleRes.end;
      while (e < s.length && (s[e] === ' ' || s[e] === '\t' || s[e] === '\n')) e++;
      if (e < s.length && s[e] === ')') return { title: titleRes.title, end: e + 1 };
    }
  }
  let e = i;
  while (e < s.length && (s[e] === ' ' || s[e] === '\t' || s[e] === '\n')) e++;
  if (e < s.length && s[e] === ')') return { title: '', end: e + 1 };
  return null;
}

// Try to read a link title at s[i]: "..." / '...' / (...). Newlines are
// allowed in all three forms. Returns {title, end} (end = index just after
// the closer) or null.
function tryTitle(s, i) {
  const open = s[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === close) return { title: s.slice(i + 1, j), end: j + 1 };
    j++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline HTML tag matcher
// ---------------------------------------------------------------------------

// An attribute inside an open tag: whitespace, a name, an optional value.
function matchAttr(s, i) {
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r' || s[j] === '\f')) j++;
  if (j === i) return -1;
  const c = s[j];
  if (!/[a-zA-Z:_]/.test(c)) return -1;
  j++;
  while (j < s.length && /[\w.:-]/.test(s[j])) j++;
  // optional = value
  let k = j;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r' || s[k] === '\f')) k++;
  if (s[k] === '=') {
    k++;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r' || s[k] === '\f')) k++;
    if (s[k] === '"') {
      let e = k + 1;
      while (e < s.length && s[e] !== '"') e++;
      if (e >= s.length) return -1;
      return e + 1;
    }
    if (s[k] === "'") {
      let e = k + 1;
      while (e < s.length && s[e] !== "'") e++;
      if (e >= s.length) return -1;
      return e + 1;
    }
    let e = k;
    while (e < s.length) {
      const d = s[e];
      if (d === ' ' || d === '\t' || d === '\n' || d === '\r' || d === '\f' || d === '"' || d === "'" || d === '=' || d === '<' || d === '>' || d === '`') break;
      e++;
    }
    if (e === k) return -1;
    return e;
  }
  return j;
}

// Match an inline HTML tag starting at s[i] === '<'.
// Returns the tag string or null.
function matchTag(s, i) {
  if (s[i] !== '<') return null;
  const c1 = s[i + 1];
  if (c1 === '!') {
    // comment
    if (s.startsWith('<!--', i)) {
      if (s[i + 4] === '-' && s[i + 5] === '>') return s.slice(i, i + 6);
      if (s[i + 4] === '>') return s.slice(i, i + 5);
      const end = s.indexOf('-->', i + 4);
      if (end === -1) return s.slice(i);
      return s.slice(i, end + 3);
    }
    // CDATA
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end === -1) return null;
      return s.slice(i, end + 3);
    }
    // declaration: <![A-Za-z]+\s ... >
    if (/[a-zA-Z]/.test(s[i + 2] || '')) {
      let j = i + 2;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      if (j < s.length && /\s/.test(s[j])) {
        const end = s.indexOf('>', j);
        if (end === -1) return null;
        return s.slice(i, end + 1);
      }
    }
    return null;
  }
  if (c1 === '?') {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return null;
    return s.slice(i, end + 2);
  }
  if (c1 === '/') {
    // closing tag: </name\s*>
    if (!/[a-zA-Z]/.test(s[i + 2] || '')) return null;
    let j = i + 2;
    while (j < s.length && /[a-zA-Z0-9-]/.test(s[j])) j++;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r' || s[j] === '\f')) j++;
    if (s[j] !== '>') return null;
    return s.slice(i, j + 1);
  }
  if (/[a-zA-Z]/.test(c1 || '')) {
    // open tag: <name (attribute)*? \s*/?>
    let j = i + 1;
    while (j < s.length && /[a-zA-Z0-9-]/.test(s[j])) j++;
    while (true) {
      // try to close first (attributes are lazy)
      let k = j;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r' || s[k] === '\f')) k++;
      if (s[k] === '>') return s.slice(i, k + 1);
      if (s[k] === '/' && s[k + 1] === '>') return s.slice(i, k + 2);
      const attrEnd = matchAttr(s, j);
      if (attrEnd === -1) return null;
      j = attrEnd;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL start detection (for the text loop)
// ---------------------------------------------------------------------------

const EMAIL_RE_STICKY = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const PROTO_RE_STICKY = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//y;
// the text rule's email lookahead: email characters then '@' (used to
// decide whether a www. with a bad previous character is still reached)
const EMAIL_AHEAD_RE = /[A-Za-z0-9.!#$%&'*+\/=?_`{|}~-]+@/y;
const EMAIL_CHAR_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;

// True when an extended autolink can start at s[j] (with the lookbehind
// rules of the text rule: www. only after the start, whitespace, *, _, ~
// or (; mailto:/xmpp: only when the previous char is not alphanumeric).
// A bare email has NO previous-character rule: marked's text rule stops
// before an email whenever the text ahead is email characters plus '@',
// so an email may start after any character, even another email character.
// When noMailto is set, a mailto:/xmpp: protocol is not a start: marked's
// text rule opens a token with a run of `+ or ~+ and swallows a following
// mailto:/xmpp: into that token, so after a text run of two or more
// backticks or tildes the protocol is literal text and only the email
// inside it is linked. Callers guarantee s[j] is a url-start character,
// so the email branch needs no character-class test of its own; hasAt
// tells whether '@' occurs anywhere in s (without one no email can
// start, so the email regex is skipped outright).
function urlStartAt(s, j, noMailto, hasAt) {
  const c = s[j];
  if (c === 'w') {
    if (s[j + 1] === 'w' && s[j + 2] === 'w' && s[j + 3] === '.'
      && (j === 0 || /[\s*_~(]/.test(s[j - 1]))) return true;
  } else if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
    // http and ftp both continue with 't'; skip the regex otherwise
    const c1 = s[j + 1];
    if (c1 === 't' || c1 === 'T') {
      PROTO_RE_STICKY.lastIndex = j;
      if (PROTO_RE_STICKY.test(s)) return true;
    }
  } else if ((c === 'm' || c === 'x') && !noMailto) {
    if ((s.startsWith('mailto:', j) || s.startsWith('xmpp:', j))
      && (j === 0 || !/[A-Za-z0-9]/.test(s[j - 1]))) return true;
  }
  if (hasAt) {
    EMAIL_RE_STICKY.lastIndex = j;
    if (EMAIL_RE_STICKY.test(s)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Masking (for the emphasis / strikethrough scans)
// ---------------------------------------------------------------------------

// Last delimiter runs that can close emphasis, strong, or strikethrough:
// a run whose preceding character is not ASCII whitespace (and not the
// start of the string). Indexes are run starts in the masked string.
function scanClosers(m) {
  let star = -1;
  let und = -1;
  let tilde = -1;
  // Scan backwards: the hint is the LAST run of each delimiter whose
  // preceding char is not whitespace, so the first such run met from the
  // end is the answer and the scan usually stops almost immediately.
  for (let i = m.length - 1; i >= 0; i--) {
    const ch = m[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    let j = i;
    while (j > 0 && m[j - 1] === ch) j--;
    const prev = j === 0 ? '\n' : m[j - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') { if (tilde === -1) tilde = j; }
      else if (ch === '*') { if (star === -1) star = j; }
      else { if (und === -1) und = j; }
    }
    i = j;
    if (star !== -1 && und !== -1 && tilde !== -1) break;
  }
  return { star, und, tilde };
}

// A code span starting at s[i] (run length k) for masking: the index just
// past its closing run, or -1. The content is one or more non-backtick
// characters and the closing run must equal the opening run.
function maskCodeSpanEnd(s, i, k) {
  let j = i + k;
  while (j < s.length && s[j] !== '`') j++;
  if (j >= s.length) return -1;
  let e = j;
  while (e < s.length && s[e] === '`') e++;
  if (e - j !== k) return -1;
  return e;
}

// An inline link for masking ([label](dest)): the index just after the
// closing ')', or -1. The label holds no brackets and code spans only;
// the destination nests parentheses one level deep.
function maskLinkEnd(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === ']') break;
    if (c === '[') return -1;
    if (c === '`') {
      const k = backtickRun(s, j);
      const close = maskCodeSpanEnd(s, j, k);
      if (close === -1) return -1;
      j = close;
      continue;
    }
    j++;
  }
  if (j >= s.length || s[j] !== ']' || s[j + 1] !== '(') return -1;
  let d = j + 2;
  let depth = 0;
  while (d < s.length) {
    const c = s[d];
    if (c === '\\') {
      d += 2;
      continue;
    }
    if (c === '(') {
      if (depth >= 1) return -1;
      depth++;
      d++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) return d + 1;
      depth--;
      d++;
      continue;
    }
    d++;
  }
  return -1;
}

// Does this text hold a link (inline or reference)? Used to decide whether
// a resolved reference link is masked whole or only its inner links are.
function linkInText(text, refs) {
  if (!text.includes('[')) return false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '`') {
      const k = backtickRun(text, i);
      const close = codeSpanEnd(text, i, k);
      if (close !== -1) {
        i = close;
        continue;
      }
      i += k;
      continue;
    }
    if (c === '<') {
      const tag = matchTag(text, i);
      if (tag !== null) {
        i += tag.length;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const bang = c === '!';
      const lb = bang ? i + 1 : i;
      const le = labelEnd(text, lb);
      if (le === -1) {
        i++;
        continue;
      }
      if (text[le] === '(') {
        const dest = parseInlineDest(text, le);
        if (dest) {
          if (!bang) return true;
          i = dest.end;
          continue;
        }
        i = le;
        continue;
      }
      // reference link or shortcut
      let refKey = null;
      let spanEnd = -1;
      let refStart = -1;
      if (text[le] === '[') {
        const re = blockLabelEnd(text, le);
        if (re !== -1) {
          refKey = text.slice(le + 1, re - 1);
          spanEnd = re;
          refStart = le;
        }
      }
      if (refKey === null) {
        if (text[le] === '[' && text[le + 1] === ']') {
          refKey = '';
          spanEnd = le + 2;
          refStart = le;
        } else {
          refKey = text.slice(lb + 1, le - 1);
          spanEnd = le;
          refStart = lb;
        }
      }
      if (refs[normalizeLabel(refKey)] === undefined) {
        i++;
        continue;
      }
      if (refStart > lb + 1 && linkInText(text.slice(lb + 1, le - 1), refs)) {
        i = spanEnd;
        continue;
      }
      return true;
    }
    i++;
  }
  return false;
}

// Mask resolved reference links: a resolved [label][ref] or [label]
// becomes [aaa...] so its delimiters cannot open emphasis. A reference
// whose label already holds a link is masked only inside that label.
function maskReflinks(s, refs) {
  let out = '';
  let i = 0;
  let last = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '[' && !(c === '!' && s[i + 1] === '[')) {
      i++;
      continue;
    }
    const bang = c === '!';
    const lb = bang ? i + 1 : i;
    const le = labelEnd(s, lb);
    if (le === -1) {
      i++;
      continue;
    }
    let refKey = null;
    let matchEnd = -1;
    let refStart = -1;
    if (s[le] === '[') {
      const re = blockLabelEnd(s, le);
      if (re !== -1) {
        refKey = s.slice(le + 1, re - 1);
        matchEnd = re;
        refStart = le;
      }
    }
    if (refKey === null) {
      if (s[le] === '[' && s[le + 1] === ']') {
        refKey = '';
        matchEnd = le + 2;
        refStart = le;
      } else {
        // a shortcut is not a candidate when '(' follows
        if (s[le] === '(') {
          i++;
          continue;
        }
        refKey = s.slice(lb + 1, le - 1);
        matchEnd = le;
        refStart = lb;
      }
    }
    if (refs[normalizeLabel(refKey)] === undefined) {
      i++;
      continue;
    }
    const matchLen = matchEnd - i;
    out += s.slice(last, i);
    if (refStart > lb + 1 && !bang) {
      const labelText = s.slice(lb + 1, le - 1);
      if (linkInText(labelText, refs)) {
        const maskedLabel = maskReflinks(labelText, refs);
        out += '[' + maskedLabel + '][' + 'a'.repeat(matchLen - (refStart - i) - 2) + ']';
        last = matchEnd;
        i = matchEnd;
        continue;
      }
    }
    out += '[' + 'a'.repeat(matchLen - 2) + ']';
    last = matchEnd;
    i = matchEnd;
  }
  out += s.slice(last);
  return out;
}

// Mask escapes outside code spans: \X becomes ++ (an astral punct becomes
// +++); the backticks inside a code span become + so the span still scans
// whole. Bare backtick runs are left alone.
function maskEscapes(s) {
  if (!/[`\\]/.test(s)) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') {
      const k = backtickRun(s, i);
      const close = codeSpanEnd(s, i, k);
      if (close !== -1) {
        out += s.slice(i, i + k);
        out += s.slice(i + k, close - k).replace(/`/g, '+');
        out += s.slice(close - k, close);
        i = close;
        continue;
      }
      out += s.slice(i, i + k);
      i += k;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      const cp = s.codePointAt(i + 1);
      const ch = String.fromCodePoint(cp);
      if (isPunct(ch)) {
        out += '+'.repeat(1 + ch.length);
        i += 1 + ch.length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// Mask inline links, code spans, and HTML so their delimiters cannot open
// emphasis. Every replacement keeps its length.
function maskBlocks(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '[') {
      const e = maskLinkEnd(s, i);
      if (e !== -1) {
        out += '[' + 'a'.repeat(e - i - 2) + ']';
        i = e;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '`') {
      const k = backtickRun(s, i);
      const close = codeSpanEnd(s, i, k);
      if (close !== -1) {
        out += '[' + 'a'.repeat(close - i - 2) + ']';
        i = close;
        continue;
      }
      out += s.slice(i, i + k);
      i += k;
      continue;
    }
    if (c === '<' && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
      let e = i + 1;
      let ok = false;
      while (e < s.length) {
        if (s[e] === '<') break;
        if (s[e] === '>') {
          ok = true;
          break;
        }
        e++;
      }
      if (ok) {
        out += '[' + 'a'.repeat(e - i - 1) + ']';
        i = e + 1;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// The masked string for one inline pass, with its closer hints. Plain
// strings (no [, \, backtick or <) need no masking at all.
// Any character that forces the full masking pass (a link bracket, an
// escape backslash, a code-span backtick, or an html tag open). One regex
// scan replaces four separate includes() scans on the fast-path test.
const MASK_CHARS_RE = /[[\\`<]/;

function buildMasked(s, refs) {
  if (!MASK_CHARS_RE.test(s)) {
    return { m: s, hints: scanClosers(s) };
  }
  let m = s;
  if (s.includes('[')) m = maskReflinks(m, refs);
  m = maskEscapes(m);
  m = maskBlocks(m);
  return { m, hints: scanClosers(m) };
}

// The code point ending at position a in m ('' at the start).
function charBefore(m, a) {
  if (a <= 0) return '';
  if (a >= 2) {
    const lo = m.charCodeAt(a - 1);
    const hi = m.charCodeAt(a - 2);
    if (lo >= 0xDC00 && lo <= 0xDFFF && hi >= 0xD800 && hi <= 0xDBFF) return m.slice(a - 2, a);
  }
  return m[a - 1];
}

// The code point starting at position b in m ('' at the end).
function charAfter(m, b) {
  if (b >= m.length) return '';
  return String.fromCodePoint(m.codePointAt(b));
}

// Classify a delimiter run [a, b) in the masked string by the CommonMark
// flanking rules 1-6 (0 when it is neither left nor right flanking).
// `gfm` selects the GFM punctuation set, where ~ is a word character.
function classifyRun(m, a, b, gfm) {
  if (a === 0) return 0;
  const prev = charBefore(m, a);
  const next = charAfter(m, b);
  const prevPunct = gfm ? isPunctGfm(prev) : isPunct(prev);
  const prevSpace = isSpace(prev);
  const prevWord = !prevSpace && !prevPunct;
  const nextPunct = gfm ? isPunctGfm(next) : isPunct(next);
  const nextSpace = next === '' || isSpace(next);
  const nextWord = next !== '' && !nextSpace && !nextPunct;
  if (prevPunct && nextSpace) return 1;
  if (prevWord && (nextSpace || nextPunct)) return 2;
  if ((prevPunct || prevSpace) && nextWord) return 3;
  if (prevSpace && nextPunct) return 4;
  if (prevPunct && nextPunct) return 5;
  if (prevWord && nextWord) return 6;
  return 0;
}

// The "skip orphan inside strong" prefix: at the start of the clipped
// string, a `__...*...__` (for a '*' opener) or `**..._...**` (for a '_'
// opener) is skipped whole. Returns the position of the closing run, or pos.
function skipOrphan(m, pos, delim) {
  const other = delim === '*' ? '_' : '*';
  // The span starts with non-delimiter chars, then an 'other' run. The
  // first delimiter run must be that 'other' run: a lone 'other' char
  // in the prefix fails the match, because [^_*] cannot match it.
  let i1 = pos;
  while (i1 + 1 < m.length) {
    const c = m[i1];
    if (c === delim) return pos;
    if (c === other) {
      if (m[i1 + 1] === other) break;
      return pos;
    }
    i1++;
  }
  if (i1 + 1 >= m.length) return pos;
  // After the 'other' run, the first delimiter must be a delim run.
  let i2 = -1;
  for (let i = i1 + 2; i < m.length; i++) {
    const d = m[i];
    if (d === delim) { i2 = i; break; }
    if (d === other) return pos;
  }
  if (i2 === -1) return pos;
  // After the delim run, only non-delimiter chars may precede the closing
  // 'other' run; a lone delimiter ends the span without a match.
  for (let i = i2 + 1; i + 1 < m.length; i++) {
    const d = m[i];
    if (d === other && m[i + 1] === other) return i;
    if (d === delim || d === other) return pos;
  }
  return pos;
}

// Try emphasis or strong starting at s[i] (a '*' or '_' run).
// Returns {kind, text, end} or null. `prevCh` is the lexer's prevChar.
function tryEmStrong(s, masked, i, delim, prevCh) {
  const m = masked.m;
  // the run from i, and its start (it may extend before i)
  let j = i;
  while (j < s.length && s[j] === delim) j++;
  const lLength = j - i;
  const next = s[j];
  if (next === undefined || next === delim || isSpace(next)) return null;
  let runStart = i;
  while (runStart > 0 && m[runStart - 1] === delim) runStart--;
  const runPrevChar = charBefore(m, runStart);
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || isPunctSpace(runPrevChar);
  let effPrevCh = prevCh;
  let effPrevPunct = isPunctSpace(prevCh);
  if (runStart < i) {
    effPrevCh = runPrevChar;
    effPrevPunct = runPrevPunct;
  }
  // _ cannot open between two alphanumerics (next is a word character)
  if (delim === '_' && !isPunctGfm(next) && effPrevCh !== '' && /[\p{L}\p{N}]/u.test(effPrevCh)) return null;
  // left-flanking gate: no punct after, or no prev char, or prev is punct
  const nextPunct = isPunctGfm(next);
  if (nextPunct && effPrevCh !== '' && !effPrevPunct) return null;
  const runLength = j - runStart;
  const openerCanClose = runPrevChar !== '' && runPrevChar.trim() !== ''
    && (nextPunct || (delim === '*' && !runPrevPunct));
  const midRun = prevCh === delim;
  const hint = delim === '*' ? masked.hints.star : masked.hints.und;
  const windowStart = i + lLength;
  if (hint < windowStart) return null;
  const hintInClip = hint - windowStart;
  const clip = m.slice(windowStart);
  let delimTotal = lLength;
  let midTotal = 0;
  let pos = 0;
  if (delim === '*') pos = skipOrphan(clip, 0, '*');
  else pos = skipOrphan(clip, 0, '_');
  while (pos < clip.length) {
    if (clip[pos] !== delim) {
      pos++;
      continue;
    }
    // a run of the delimiter
    let a = pos;
    let b = pos;
    while (b < clip.length && clip[b] === delim) b++;
    if (a > hintInClip) break;
    const rule = classifyRun(clip, a, b, delim === '*');
    if (rule === 0) {
      pos = b;
      continue;
    }
    const rLength = b - a;
    if (delim === '_' && rule === 6) {
      pos = b;
      continue;
    }
    if (rule === 3 || rule === 4) {
      delimTotal += rLength;
      pos = b;
      continue;
    }
    if (rule === 5 || rule === 6 || openerCanClose) {
      if (midRun && (rule === 5 || rule === 6)) break;
      if (runLength % 3 !== 0 && (runLength + rLength) % 3 === 0) {
        midTotal += rLength;
        pos = b;
        continue;
      }
    }
    delimTotal -= rLength;
    if (delimTotal > 0) {
      pos = b;
      continue;
    }
    const useLen = Math.min(rLength, rLength + delimTotal + midTotal);
    const rawEnd = i + lLength + a + useLen;
    const kind = Math.min(lLength, useLen) % 2 === 1 ? 'em' : 'strong';
    const cut = kind === 'em' ? 1 : 2;
    return { kind, text: s.slice(i + cut, rawEnd - cut), end: rawEnd };
  }
  return null;
}

// Try strikethrough starting at s[i] (a '~' run).
// Returns {text, end} or null.
function tryDel(s, masked, i, prevCh) {
  const m = masked.m;
  let j = i;
  while (j < s.length && s[j] === '~') j++;
  const runLen = j - i;
  if (runLen > 2) return null;
  const next = s[j];
  if (next === undefined || next === '~' || isSpace(next)) return null;
  // gate: no punct after, or no prev char, or prev is punct/space
  const nextPunct = isPunct(next);
  if (nextPunct && prevCh !== '' && !isPunctSpace(prevCh)) return null;
  const lLength = runLen;
  const hint = masked.hints.tilde;
  const windowStart = i + lLength;
  if (hint < windowStart) return null;
  const hintInClip = hint - windowStart;
  const clip = m.slice(windowStart);
  let delimTotal = lLength;
  let pos = 0;
  while (pos < clip.length) {
    if (clip[pos] !== '~') {
      pos++;
      continue;
    }
    let a = pos;
    let b = pos;
    while (b < clip.length && clip[b] === '~') b++;
    if (a > hintInClip) break;
    const rule = classifyRun(clip, a, b, false);
    if (rule === 0) {
      pos = b;
      continue;
    }
    const rLength = b - a;
    if (rLength !== lLength) {
      pos = b;
      continue;
    }
    if (rule === 3 || rule === 4) {
      delimTotal += rLength;
      pos = b;
      continue;
    }
    delimTotal -= rLength;
    if (delimTotal > 0) {
      pos = b;
      continue;
    }
    const useLen = Math.min(rLength, rLength + delimTotal);
    const rawEnd = i + lLength + a + useLen;
    return { text: s.slice(i + lLength, rawEnd - lLength), end: rawEnd };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The inline scanner
// ---------------------------------------------------------------------------

// Does this node list hold a link anywhere (images do not count: their
// alt text may hold one, but that never blocks an enclosing link)?
// Deep check: does this node list hold a real link? Only links and images
// produced by the link rule set the "link emitted" flag; autolinks and bare
// URLs do not, and images are exempt from the bail anyway.
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.k === 3 && !nd.img && !nd.auto) return true;
    if (nd.k === 7 && containsLink(nd.kids)) return true;
  }
  return false;
}

// Plain-text rendering of a node list (image alt text): no tags, no
// escaping; hard breaks vanish.
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 0 || nd.k === 1 || nd.k === 2 || nd.k === 4) out += nd.s;
    else if (nd.k === 3 || nd.k === 7) out += plainText(nd.kids);
  }
  return out;
}

// Render a node list to HTML.
function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 0) {
      out += nd.raw ? nd.s : escText(nd.s);
    } else if (nd.k === 1) {
      out += escText(nd.s);
    } else if (nd.k === 2) {
      out += '<code>' + escFull(nd.s) + '</code>';
    } else if (nd.k === 3) {
      out += renderLink(nd);
    } else if (nd.k === 4) {
      out += nd.s;
    } else if (nd.k === 5) {
      out += '<br>';
    } else if (nd.k === 7) {
      out += '<' + nd.tag + '>' + renderNodes(nd.kids) + '</' + nd.tag + '>';
    }
  }
  return out;
}

function renderLink(nd) {
  if (nd.img) {
    const alt = plainText(nd.kids);
    const href = cleanUrl(nd.href);
    if (href === null) return escText(alt);
    let out = '<img src="' + escText(href) + '" alt="' + escText(alt) + '"';
    if (nd.title) out += ' title="' + escText(nd.title) + '"';
    return out + '>';
  }
  if (nd.auto) {
    const href = cleanUrl(nd.href);
    if (href === null) return escFull(nd.s);
    return '<a href="' + escFull(href) + '">' + escFull(nd.s) + '</a>';
  }
  const text = renderNodes(nd.kids);
  const href = cleanUrl(nd.href);
  if (href === null) return text;
  let out = '<a href="' + escText(href) + '"';
  if (nd.title) out += ' title="' + escText(nd.title) + '"';
  return out + '>' + text + '</a>';
}

// Try to form a link or image starting at s[i] ('[' or '![').
// Returns {end, node} or null. `st` is the shared inline state.
function tryLink(s, i, refs, st) {
  const isImage = s[i] === '!' && s[i + 1] === '[';
  const lb = isImage ? i + 1 : i;
  if (s[lb] !== '[') return null;
  const le = labelEnd(s, lb, 0);
  if (le === -1) return null;
  const label = s.slice(lb + 1, le - 1);
  if (labelEndInsideToken(s, label, lb + 1)) return null;
  let href = null;
  let title = '';
  let end = -1;
  if (s[le] === '(') {
    const dest = parseInlineDest(s, le);
    if (dest) {
      href = dest.href;
      title = dest.title;
      end = dest.end;
    }
  }
  if (href === null && s[le] === '[') {
    const re = blockLabelEnd(s, le);
    if (re !== -1) {
      const ref = refs[normalizeLabel(s.slice(le + 1, re - 1))];
      if (ref) {
        href = ref.href;
        title = ref.title || '';
        end = re;
      } else {
        // The full reflink parsed but the ref is undefined: marked returns
        // only the first char as text and never falls back to the shortcut.
        return null;
      }
    }
  }
  if (href === null) {
    // collapsed [label][] or shortcut [label]
    let ref = null;
    let span = le;
    if (s[le] === '[' && s[le + 1] === ']') {
      ref = refs[normalizeLabel(label)];
      span = le + 2;
    } else {
      ref = refs[normalizeLabel(label)];
    }
    if (ref) {
      href = ref.href;
      title = ref.title || '';
      end = span;
    }
  }
  if (href === null) return null;
  // the link text: unescape \[ and \], then parse inline with inLink set
  const text = label.replace(/\\([\[\]])/g, '$1');
  const outerInLink = st.inLink;
  const outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  const kids = scanInline(text, refs, st);
  if (!isImage && containsLink(kids)) {
    st.inLink = outerInLink;
    st.inRawBlock = outerInRawBlock;
    return null;
  }
  st.inLink = outerInLink;
  return { end, node: { k: 3, href, title, kids, img: isImage, auto: false } };
}

// Parse inline markdown to a node list. `st` is the shared inline state
// ({inLink, inRawBlock}); it is mutated as tags open and close.
function scanInline(s, refs, st) {
  const nodes = [];
  const n = s.length;
  const hasAt = s.includes('@');
  let masked = null;
  const getMasked = () => {
    if (masked === null) masked = buildMasked(s, refs);
    return masked;
  };
  let i = 0;
  let prevCh = '';
  // text buffer: accumulated decoded text, flushed as one node
  let buf = '';
  let bufRaw = false;
  const flushBuf = () => {
    if (buf !== '') {
      nodes.push({ k: 0, s: bufRaw ? buf : decodeNumRefs(buf), raw: bufRaw });
      buf = '';
    }
  };
  const addText = (str, raw) => {
    if (buf === '' || raw !== bufRaw) {
      flushBuf();
      bufRaw = raw;
    }
    buf += str;
  };
  // the lexer's prevChar: the last character of the previous text token,
  // kept across a text token ending in '_', '' after any other token
  const curPrevCh = () => {
    if (buf === '') return prevCh;
    for (let j = buf.length - 1; j >= 0; j--) {
      if (buf[j] !== '_') return buf[j];
    }
    return prevCh;
  };
  // position where the text loop broke at a www. via the email lookahead
  // walk (a www. with a bad previous character that marked's text rule
  // still reaches): the url dispatch must accept it there
  let walkWwwPos = -1;
  // true when the accumulated text ends in a run of two or more backticks
  // or tildes (a failed code-span run or a failed strikethrough run):
  // marked's text rule opens a token with such a run and swallows a
  // following mailto:/xmpp: into that token, so the protocol is literal
  const bufEndsWithRun = () => {
    const L = buf.length;
    if (L < 2) return false;
    const c = buf[L - 1];
    return (c === '~' || c === '`') && buf[L - 2] === c;
  };
  const noteNonText = () => {
    prevCh = '';
  };

  while (i < n) {
    const ch = s[i];
    // backslash escape (ASCII punctuation only) or hard break
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && ASCII_PUNCT[nx.charCodeAt(0)] === 1) {
        flushBuf();
        nodes.push({ k: 1, s: nx });
        noteNonText();
        i += 2;
        continue;
      }
      if (nx === '\n') {
        // hard break, unless the rest is only whitespace to the end
        let rest = i + 2;
        while (rest < n && /\s/.test(s[rest])) rest++;
        if (rest < n) {
          flushBuf();
          nodes.push({ k: 5 });
          noteNonText();
          i += 2;
          while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
          continue;
        }
      }
      addText('\\', st.inRawBlock);
      i++;
      continue;
    }
    // code span
    if (ch === '`') {
      const k = backtickRun(s, i);
      const close = codeSpanEnd(s, i, k);
      if (close !== -1) {
        let text = s.slice(i + k, close - k).replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') {
          text = text.slice(1, -1);
        }
        flushBuf();
        nodes.push({ k: 2, s: text });
        noteNonText();
        i = close;
        continue;
      }
      addText(s.slice(i, i + k), st.inRawBlock);
      i += k;
      continue;
    }
    // inline HTML tag or <...> autolink
    if (ch === '<') {
      const tag = matchTag(s, i);
      if (tag !== null) {
        flushBuf();
        nodes.push({ k: 4, s: tag });
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = false;
        if (!st.inLink && /^<a /i.test(tag)) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(tag)) st.inLink = false;
        noteNonText();
        i += tag.length;
        continue;
      }
      const auto = matchAutolink(s, i);
      if (auto) {
        flushBuf();
        nodes.push({ k: 3, href: auto.href, title: '', kids: null, img: false, auto: true, s: auto.text });
        noteNonText();
        i = auto.end;
        continue;
      }
      addText('<', st.inRawBlock);
      i++;
      continue;
    }
    // link or image
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const link = tryLink(s, i, refs, st);
      if (link) {
        flushBuf();
        nodes.push(link.node);
        noteNonText();
        i = link.end;
        continue;
      }
      if (ch === '!') {
        addText('!', st.inRawBlock);
        i++;
        continue;
      }
      addText('[', st.inRawBlock);
      i++;
      continue;
    }
    // emphasis / strong; a failed run falls through so that a '_' that
    // starts an email (its local part may begin with '_') is still tried
    // as an extended autolink by the url dispatch below, and a failed
    // '*' falls through to the text loop which consumes one character
    if (ch === '*' || ch === '_') {
      const hit = tryEmStrong(s, getMasked(), i, ch, curPrevCh());
      if (hit) {
        flushBuf();
        const kids = scanInline(hit.text, refs, st);
        nodes.push({ k: 7, tag: hit.kind, kids });
        noteNonText();
        i = hit.end;
        continue;
      }
    }
    // strikethrough (a failed ~ run is consumed whole: the text rule's
    // head matches ~+ as one token, so the rest of the run never retries)
    if (ch === '~') {
      const hit = tryDel(s, getMasked(), i, curPrevCh());
      if (hit) {
        flushBuf();
        const kids = scanInline(hit.text, refs, st);
        nodes.push({ k: 7, tag: 'del', kids });
        noteNonText();
        i = hit.end;
        continue;
      }
      let j = i;
      while (j < n && s[j] === '~') j++;
      addText(s.slice(i, j), st.inRawBlock);
      i = j;
      continue;
    }
    // hard break: two or more spaces before a newline
    if (ch === ' ') {
      let j = i;
      while (j < n && s[j] === ' ') j++;
      if (j - i >= 2 && s[j] === '\n') {
        let rest = j + 1;
        while (rest < n && /\s/.test(s[rest])) rest++;
        if (rest < n) {
          flushBuf();
          nodes.push({ k: 5 });
          noteNonText();
          i = j + 1;
          while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
          continue;
        }
      }
      addText(s.slice(i, j), st.inRawBlock);
      i = j;
      continue;
    }
    // extended autolink (GFM): www., http(s)://, ftp://, mailto:, xmpp:, email
    if (!st.inLink && (ch === 'w' || ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'm' || ch === 'M' || ch === 'x' || ch === 'X' || /[A-Za-z0-9._+\-]/.test(ch))) {
      // the www. previous-character rule is skipped at a fresh position
      // (no text accumulated since the last token: marked's url rule
      // has no lookbehind, so it matches there) or at the position the
      // text loop reached via the email lookahead walk
      const skipWwwCheck = buf === '' || i === walkWwwPos;
      const url = matchUrl(s, i, i > 0 ? s[i - 1] : '', skipWwwCheck);
      // a mailto:/xmpp: after a text run of two or more backticks or
      // tildes is literal text (see urlStartAt); only the email inside
      // it is linked, so fall through to the text loop instead
      const mailtoSuppressed = url !== null && !url.email && !url.www
        && /^(?:mailto|xmpp):/i.test(url.text) && bufEndsWithRun();
      if (url && !mailtoSuppressed) {
        let text = url.text;
        let href = url.href;
        if (url.backpedal) {
          text = backpedal(text);
          href = text.startsWith('www.') ? 'http://' + text : text;
          if (text === '') {
            addText(s[i], st.inRawBlock);
            i++;
            continue;
          }
        }
        flushBuf();
        nodes.push({ k: 3, href, title: '', kids: null, img: false, auto: true, s: text });
        noteNonText();
        i += text.length;
        continue;
      }
    }
    // ordinary text: consume until the next special character
    let j = i;
    while (j < n) {
      const c = s[j];
      if (c === '\\' || c === '`' || c === '<' || c === '[' || c === '!' || c === '*' || c === '_' || c === '~') break;
      if (c === ' ') {
        // stop before a hard-break run of spaces
        let k = j;
        while (k < n && s[k] === ' ') k++;
        if (k - j >= 2 && s[k] === '\n') {
          let rest = k + 1;
          while (rest < n && /\s/.test(s[rest])) rest++;
          if (rest < n) break;
        }
        j = k;
        continue;
      }
      // stop before an extended autolink (unless inside a link); only
      // positions that can start one are tested (a protocol/www/mailto
      // first letter, or an email-start character) so the regexes are
      // not run on every character
      if (!st.inLink) {
        const cc = s.charCodeAt(j);
        // the mailto:/xmpp: suppression only applies when the text run
        // being scanned is still empty: any characters already in the
        // run sit between the buffered run and the protocol, so the
        // protocol is a fresh start and is linked (e.g. ```/mailto:)
        const noMailto = j === i && bufEndsWithRun();
        if (cc === 119) {
          // a www. with a bad previous character is still reached when
          // marked's text rule walks to it via the email lookahead (an
          // '@' ahead reachable through email characters): the text
          // token then shrinks one character at a time until the url
          // rule fires, so break here and tell the url dispatch
          if (s[j + 1] === 'w' && s[j + 2] === 'w' && s[j + 3] === '.'
            && !(j === 0 || /[\s*_~(]/.test(s[j - 1]))) {
            // the walk only matters when an '@' is ahead at all
            if (hasAt) {
              EMAIL_AHEAD_RE.lastIndex = j;
              if (EMAIL_AHEAD_RE.test(s)) {
                walkWwwPos = j;
                break;
              }
            }
          }
        }
        if (cc === 119 || cc === 104 || cc === 72 || cc === 102 || cc === 70 || cc === 109 || cc === 120) {
          if (urlStartAt(s, j, noMailto, hasAt)) break;
        } else if (hasAt && ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 46 || cc === 95 || cc === 43 || cc === 45)) {
          // without an '@' in the string no email can start, so a plain
          // letter (not a protocol/www/mailto first letter) never starts
          // a url: skip the call entirely
          if (urlStartAt(s, j, noMailto, hasAt)) break;
        }
      }
      j++;
    }
    if (j > i) {
      addText(s.slice(i, j), st.inRawBlock);
      i = j;
    } else {
      // single character that is none of the above (should not happen)
      addText(ch, st.inRawBlock);
      i++;
    }
  }
  flushBuf();
  return nodes;
}

// Render an inline string to HTML.
// Render an inline string to HTML. `doc` carries the document-wide state:
// inLink persists across blocks (an unclosed <a> tag suppresses bare-URL
// autolinking for the rest of the document), while inRawBlock is reset for
// every block, as in marked.
function inlineToHtml(s, refs, doc) {
  const st = { inLink: doc ? doc.inLink : false, inRawBlock: false };
  const html = renderNodes(scanInline(s, refs, st));
  if (doc) doc.inLink = st.inLink;
  return html;
}

// ---------------------------------------------------------------------------
// Block grammar
// ---------------------------------------------------------------------------

const CARET_RE = /(^|[^\[])\^/g;
// Build a RegExp from a source string, replacing named placeholders with
// the given sources (leading ^ anchors are stripped, as in marked's edit).
function editRegex(source, replacements, flags) {
  let s = typeof source === 'string' ? source : source.source;
  for (const [name, val] of replacements) {
    let valSource = typeof val === 'string' ? val : val.source;
    valSource = valSource.replace(CARET_RE, '$1');
    s = s.replace(name, valSource);
  }
  return new RegExp(s, flags || '');
}

const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const COMMENT_SRC = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';
const HTML_BEGIN_SRC = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

const NEWLINE_RE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES_RE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const HR_RE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;

const HTML_RE = editRegex(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')',
  [
    ['comment', COMMENT_SRC],
    ['tag', TAG_LIST],
    ['attribute', ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?'],
  ],
  'i',
);

const BLOCK_LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\\\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)';
const DEF_RE = editRegex(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)',
  [['label', BLOCK_LABEL_SRC], ['title', DEF_TITLE_SRC]],
);

const GFM_TABLE_RE = editRegex(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
  [
    ['hr', HR_SRC],
    ['heading', HEADING_SRC],
    ['blockquote', BLOCKQUOTE_SRC],
    ['code', '(?: {4}| {0,3}\\t)[^\\n]'],
    ['fences', FENCES_SRC],
    ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
    ['html', HTML_BEGIN_SRC],
    ['tag', TAG_LIST],
  ],
);

const LHEADING_RE = editRegex(
  '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)',
  [
    [/bull/g, BULLET_SRC],
    ['blockCode', '(?: {4}| {0,3}\\t)'],
    [/fences/g, ' {0,3}(?:`{3,}|~{3,})'],
    [/blockquote/g, BLOCKQUOTE_SRC],
    [/heading/g, HEADING_SRC],
    ['hr', ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'],
    [/html/g, ' {0,3}<[^\\n>]+>\\n'],
    [/table/g, ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n'],
  ],
);

// True when a setext underline line occurs before the first blank line.
// A setext heading's text cannot span a blank line, so the underline must
// sit in the opening run of lines; scanning line starts (and stopping at
// the first blank line) avoids running the backtracking LHEADING_RE on
// ordinary paragraphs and avoids scanning the whole remaining source.
function hasSetextLine(src) {
  let i = 0;
  for (;;) {
    const nl = src.indexOf('\n', i);
    if (nl === -1) return false;
    const ls = nl + 1;
    let j = ls;
    let sp = 0;
    while (sp < 3 && src[j] === ' ') { j++; sp++; }
    const c = src[j];
    if (c === '=' || c === '-') {
      let k = j;
      while (src[k] === c) k++;
      while (src[k] === ' ' || src[k] === '\t') k++;
      if (src[k] === '\n' || k === src.length) return true;
    }
    // Blank line: only spaces/tabs before the newline or EOF. The text
    // group cannot span it, so no underline can follow.
    let m = ls;
    while (src[m] === ' ' || src[m] === '\t') m++;
    if (src[m] === '\n' || m === src.length) return false;
    i = ls;
  }
}

const PARAGRAPH_RE = editRegex(
  '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)',
  [
    ['hr', HR_SRC],
    ['heading', HEADING_SRC],
    ['|lheading', ''],
    ['table', GFM_TABLE_RE],
    ['blockquote', BLOCKQUOTE_SRC],
    ['fences', FENCES_SRC],
    ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]'],
    ['html', HTML_BEGIN_SRC],
    ['tag', TAG_LIST],
  ],
);

// Paragraph inside a blockquote: a bare list marker (any number) starts a
// sibling list, so it must not be lazily continued as paragraph text.
// Like marked's createParagraph it does NOT interrupt on a table line:
// the blockquote regex must consume table lines as lazy continuation
// (the table itself is then lexed when the continuation group is parsed).
const BLOCKQUOTE_PARA_RE = editRegex(
  '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)',
  [
    ['hr', HR_SRC],
    ['heading', HEADING_SRC],
    ['|lheading', ''],
    ['|table', ''],
    ['blockquote', BLOCKQUOTE_SRC],
    ['fences', FENCES_SRC],
    ['list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)'],
    ['html', HTML_BEGIN_SRC],
    ['tag', TAG_LIST],
  ],
);

const BLOCKQUOTE_RE = editRegex(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+',
  [['paragraph', BLOCKQUOTE_PARA_RE]],
);

const LIST_RE = editRegex(
  '^(bull)([ \\t][^\\n]*?)?(?:\\n|$)',
  [['bull', BULLET_SRC]],
);

const BLOCK_TEXT_RE = /^[^\n]+/;

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Remove up to the fence's own indentation from each line of fenced code.
function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(/^(\s+)(?:```)/);
  if (matchIndentToCode === null) return text;
  const indentToCode = matchIndentToCode[1];
  return text.split('\n').map((node) => {
    const m = node.match(/^\s+/);
    if (m === null) return node;
    return node.slice(Math.min(m[0].length, indentToCode.length));
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Block lexers (each returns a node or null)
// ---------------------------------------------------------------------------

function lexSpace(src) {
  const m = NEWLINE_RE.exec(src);
  if (m && m[0].length > 0) return { t: 'space', raw: m[0] };
  return null;
}

function lexCode(src) {
  const m = BLOCK_CODE_RE.exec(src);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { t: 'code', raw, text, lang: undefined };
}

function lexFences(src) {
  const m = FENCES_RE.exec(src);
  if (!m) return null;
  const text = indentCodeCompensation(m[0], m[3] || '');
  const lang = m[2] ? m[2].trim().replace(ANY_PUNCT_RE, '$1') : m[2];
  return { t: 'code', raw: m[0], text, lang };
}

function lexHeading(src) {
  const m = HEADING_RE.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (/#$/.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || /[ \t]$/.test(trimmed)) text = trimmed.trim();
  }
  return { t: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text };
}

function lexHr(src) {
  const m = HR_RE.exec(src);
  if (!m) return null;
  return { t: 'hr', raw: rtrim(m[0], '\n') };
}

function lexHtml(src) {
  const m = HTML_RE.exec(src);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  return { t: 'html', raw, text: raw };
}

function lexDef(src) {
  const m = DEF_RE.exec(src);
  if (!m) return null;
  if (!m[2].startsWith('<') && findClosingBracket(m[2], '()') !== -1) return null;
  const tag = normalizeLabel(m[1]);
  const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(ANY_PUNCT_RE, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT_RE, '$1') : m[3];
  return { t: 'def', raw: rtrim(m[0], '\n'), tag, href, title };
}

function lexTable(src) {
  const m = GFM_TABLE_RE.exec(src);
  if (!m) return null;
  if (!/[:|]/.test(m[2])) return null;
  const headers = splitCells(m[1]);
  const aligns = m[2].replace(/^\||\| *$/g, '').split('|');
  if (headers.length !== aligns.length) return null;
  const align = aligns.map((a) => {
    if (/^ *-+: *$/.test(a)) return 'right';
    if (/^ *:-+: *$/.test(a)) return 'center';
    if (/^ *:-+ *$/.test(a)) return 'left';
    return null;
  });
  const rows = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  const header = headers.map((h, i) => ({ text: h, align: align[i] }));
  const rowCells = rows.map((row) => splitCells(row, header.length).map((cell, i) => ({ text: cell, align: align[i] })));
  return { t: 'table', raw: rtrim(m[0], '\n'), header, rows: rowCells };
}

function lexLheading(src) {
  // Cheap pre-check: a setext underline must exist before the first
  // blank line, else the heading text cannot reach it.
  if (!hasSetextLine(src)) return null;
  const m = LHEADING_RE.exec(src);
  if (!m) return null;
  return { t: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() };
}

function lexParagraph(src) {
  const m = PARAGRAPH_RE.exec(src);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { t: 'para', raw: m[0], text };
}

function lexText(src) {
  const m = BLOCK_TEXT_RE.exec(src);
  if (!m) return null;
  return { t: 'text', raw: m[0], text: m[0] };
}

// ---------------------------------------------------------------------------
// Blockquote
// ---------------------------------------------------------------------------

function lexBlockquote(src, refs) {
  const m = BLOCKQUOTE_RE.exec(src);
  if (!m) return null;
  let lines = rtrim(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (/^ {0,3}>/.test(lines[i])) {
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
      .replace(/^( {0,3}>)([ \t]+)/gm, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;
    // a blockquote lexes its content as top-level blocks, then restores
    // the caller's top (marked saves/restores state.top around it)
    const savedTop = lexTop;
    lexBlocks(currentText, refs, true, tokens, true);
    lexTop = savedTop;
    if (lines.length === 0) break;
    const lastToken = tokens[tokens.length - 1];
    if (lastToken && (lastToken.t === 'code' || lastToken.t === 'heading' || lastToken.t === 'hr' || lastToken.t === 'html' || lastToken.t === 'table')) {
      break;
    } else if (lastToken && lastToken.t === 'blockquote') {
      const continuation = lines.join('\n');
      const newText = lastToken.raw + '\n' + continuation.replace(/^ {0,3}>[ \t]?/gm, '');
      const newToken = lexBlockquote(newText, refs);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - lastToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && /^ {0,3}>/.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.t === 'list') {
      const newText = lastToken.raw + '\n' + lines.join('\n');
      const newToken = lexList(newText, refs);
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > lastToken.raw.length
        ? newText.slice(lastToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { t: 'blockquote', raw, text, items: tokens };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

// The list-item continuation regexes depend only on the indent index
// (0-3); building them per item is pure overhead, so cache them.
const LIST_INDENT_RES = [];
function listIndentRes(idx) {
  let r = LIST_INDENT_RES[idx];
  if (!r) {
    r = {
      nextBullet: new RegExp(`^ {0,${idx}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`),
      hr: new RegExp(`^ {0,${idx}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
      fences: new RegExp(`^ {0,${idx}}(?:\\\`\\\`\\\`|~~~)`),
      heading: new RegExp(`^ {0,${idx}}#{1,6}(?:\\s|$)`),
      html: new RegExp(`^ {0,${idx}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
      blockquote: new RegExp(`^ {0,${idx}}>`),
      // One alternation for the six item-end patterns above: any match
      // breaks the item. The bullet alternative uses the lookahead the
      // original bullet regex implied (space, tab, newline or EOL after
      // the marker). The 'i' flag is only meaningful for the html tag
      // names; the other alternatives hold no letters.
      combined: new RegExp(`^ {0,${idx}}(?:(?:\`\`\`|~~~)|#{1,6}(?:\\s|$)|(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)|>|(?:[*+-]|\\d{1,9}[.)])(?=[ \\t\\n]|$)|(?:(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$))`, 'i'),
    };
    LIST_INDENT_RES[idx] = r;
  }
  return r;
}

function lexList(src, refs) {
  const cap0 = LIST_RE.exec(src);
  if (!cap0) return null;
  const listSrc = src;
  let pos = 0;
  let bull = cap0[1].trim();
  const isOrdered = bull.length > 1;
  const list = { t: 'list', raw: '', ordered: isOrdered, start: isOrdered ? +bull.slice(0, -1) : '', loose: false, items: [] };
  bull = isOrdered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
  let endsWithBlankLine = false;
  while (pos < listSrc.length) {
    let endEarly = false;
    let itemContents = '';
    const rest = listSrc.slice(pos);
    const cap = itemRegex.exec(rest);
    if (!cap) break;
    if (HR_RE.test(rest)) break;
    const itemStart = pos;
    pos += cap[0].length;
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(/^[ \t]+/, (ws) => expandTabs(ws, bulletIndent));
    const nl0 = listSrc.indexOf('\n', pos);
    const nextLine0 = nl0 === -1 ? listSrc.slice(pos) : listSrc.slice(pos, nl0);
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(/[^ ]/);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && /^[ \t]*$/.test(nextLine0)) {
      pos += nextLine0.length + 1;
      endEarly = true;
    }
    if (!endEarly) {
      const idx = Math.max(0, Math.min(3, indent - 1));
      const res = listIndentRes(idx);
      const hrRegex = res.hr;
      const fencesBeginRegex = res.fences;
      const headingBeginRegex = res.heading;
      const htmlBeginRegex = res.html;
      const itemEndRegex = res.combined;
      while (pos < listSrc.length) {
        const nl2 = listSrc.indexOf('\n', pos);
        const nextLine2 = nl2 === -1 ? listSrc.slice(pos) : listSrc.slice(pos, nl2);
        // Tabs in the leading whitespace expand to columns; a run of
        // plain spaces passes through untouched, so skip the replace.
        let nextLineWithoutTabs = nextLine2;
        if (nextLine2[0] === ' ' || nextLine2[0] === '\t') {
          let e = 0;
          let hasTab = false;
          while (nextLine2[e] === ' ' || nextLine2[e] === '\t') {
            if (nextLine2[e] === '\t') hasTab = true;
            e++;
          }
          if (hasTab) nextLineWithoutTabs = expandTabs(nextLine2.slice(0, e)) + nextLine2.slice(e);
        }
        if (itemEndRegex.test(nextLine2)) break;
        if (nextLineWithoutTabs.search(/[^ ]/) >= indent || !nextLine2.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(/\t/g, '    ').search(/[^ ]/) >= 4) break;
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine2)
            && LHEADING_RE.test(`${line}\n${nextLine2}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine2;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine2.trim();
        pos += nextLine2.length + 1;
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, pos);
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({ raw, task: /^\[[ xX]\][ \t]+\S/.test(itemContents), loose: false, text: itemContents, tokens: [] });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = listSrc.slice(0, pos).trimEnd();
  for (const item of list.items) {
    lexBlocks(item.text, refs, false, item.tokens, false);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.t === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => /\n.*\n/.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && itemToken && (itemToken.t === 'text' || itemToken.t === 'para')) {
      item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
      itemToken.raw = itemToken.raw.replace(/^\[[ xX]\][ \t]+/, '');
      itemToken.text = itemToken.text.replace(/^\[[ xX]\][ \t]+/, '');
      const taskRaw = /\[[ xX]\]/.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        const checkbox = { t: 'checkbox', raw: taskRaw[0] + ' ', checked };
        item.checked = checked;
        if (list.loose) {
          if (item.tokens[0] && (item.tokens[0].t === 'para' || item.tokens[0].t === 'text')) {
            item.tokens[0].lead = checkbox;
          } else {
            item.tokens.unshift({ t: 'para', raw: checkbox.raw, text: checkbox.raw, lead: checkbox });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.t === 'text') token.t = 'para';
      }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Main block loop
// ---------------------------------------------------------------------------

// The lexer's `top` state (marked's state.top): whether paragraphs are
// lexed as paragraph tokens (true) or as text tokens (false). It is
// MUTABLE shared state, not a per-call flag: every blockTokens call sets
// it to true when it finishes, a list sets it to false before each item,
// and a blockquote saves and restores it around its content. That is why
// text after a nested list inside an item lexes as a paragraph (the
// nested list's own blockTokens flipped it back to true).
let lexTop = true;

function lexBlocks(src, refs, top, out, lastParagraphClipped) {
  let clipped = !!lastParagraphClipped;
  lexTop = top;
  while (src) {
    let node = null;
    node = lexSpace(src);
    if (node) {
      src = src.substring(node.raw.length);
      const last = out[out.length - 1];
      if (node.raw.length === 1 && last !== undefined) {
        last.raw += '\n';
      } else {
        out.push(node);
      }
      continue;
    }
    node = lexCode(src);
    if (node) {
      src = src.substring(node.raw.length);
      const last = out[out.length - 1];
      if (last && (last.t === 'para' || last.t === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.text;
      } else {
        out.push(node);
      }
      continue;
    }
    node = lexFences(src);
    if (node) { src = src.substring(node.raw.length); out.push(node); continue; }
    node = lexHeading(src);
    if (node) { src = src.substring(node.raw.length); out.push(node); continue; }
    node = lexHr(src);
    if (node) { src = src.substring(node.raw.length); out.push(node); continue; }
    node = lexBlockquote(src, refs);
    if (node) { src = src.substring(node.raw.length); out.push(node); continue; }
    node = lexList(src, refs);
    if (node) { src = src.substring(node.raw.length); out.push(node); continue; }
    node = lexHtml(src);
    if (node) { src = src.substring(node.raw.length); out.push(node); continue; }
    node = lexDef(src);
    if (node) {
      src = src.substring(node.raw.length);
      const last = out[out.length - 1];
      if (last && (last.t === 'para' || last.t === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.raw;
      } else {
        if (refs[node.tag] === undefined) {
          refs[node.tag] = { href: node.href, title: node.title };
        }
        out.push(node);
      }
      continue;
    }
    node = lexTable(src);
    if (node) { src = src.substring(node.raw.length); out.push(node); continue; }
    node = lexLheading(src);
    if (node) { src = src.substring(node.raw.length); out.push(node); continue; }
    if (lexTop) {
      node = lexParagraph(src);
      if (node) {
        const last = out[out.length - 1];
        if (clipped && last && last.t === 'para') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
          last.text += '\n' + node.text;
        } else {
          out.push(node);
        }
        clipped = false;
        src = src.substring(node.raw.length);
        continue;
      }
    }
    node = lexText(src);
    if (node) {
      src = src.substring(node.raw.length);
      const last = out[out.length - 1];
      if (last && last.t === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.text;
      } else {
        out.push(node);
      }
      continue;
    }
    // No rule matched: consume one char as text so we never loop forever.
    const ch = src[0];
    const last = out[out.length - 1];
    if (last && last.t === 'text') {
      last.raw += ch;
      last.text += ch;
    } else {
      out.push({ t: 'text', raw: ch, text: ch });
    }
    src = src.substring(1);
  }
  // every blockTokens call leaves top true (marked's state.top = true)
  lexTop = true;
  return out;
}

// ---------------------------------------------------------------------------
// Block renderer
// ---------------------------------------------------------------------------

function renderCheckbox(node) {
  return '<input ' + (node.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderBlocks(nodes, refs, doc) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'space' || node.t === 'def') continue;
    if (node.t === 'code') {
      const langString = (node.lang || '').match(/^\S*/)?.[0];
      const code = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
      if (!langString) {
        out += '<pre><code>' + escFull(code) + '</code></pre>\n';
      } else {
        out += '<pre><code class="language-' + escText(langString) + '">' + escFull(code) + '</code></pre>\n';
      }
    } else if (node.t === 'heading') {
      out += '<h' + node.depth + '>' + inlineToHtml(node.text, refs, doc) + '</h' + node.depth + '>\n';
    } else if (node.t === 'hr') {
      out += '<hr>\n';
    } else if (node.t === 'html') {
      out += node.text;
    } else if (node.t === 'para' || node.t === 'text') {
      const lead = node.lead ? renderCheckbox(node.lead) : '';
      if (node.t === 'para') out += '<p>' + lead + inlineToHtml(node.text, refs, doc) + '</p>\n';
      else out += lead + inlineToHtml(node.text, refs, doc);
    } else if (node.t === 'blockquote') {
      out += '<blockquote>\n' + renderBlocks(node.items, refs, doc) + '</blockquote>\n';
    } else if (node.t === 'list') {
      let body = '';
      for (const item of node.items) body += '<li>' + renderBlocks(item.tokens, refs, doc) + '</li>\n';
      const type = node.ordered ? 'ol' : 'ul';
      const startAttr = (node.ordered && node.start !== 1) ? ' start="' + node.start + '"' : '';
      out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
    } else if (node.t === 'checkbox') {
      out += renderCheckbox(node);
    } else if (node.t === 'table') {
      let headerCells = '';
      for (const cell of node.header) {
        headerCells += '<th' + (cell.align ? ' align="' + cell.align + '"' : '') + '>' + inlineToHtml(cell.text, refs, doc) + '</th>\n';
      }
      let bodyRows = '';
      for (const row of node.rows) {
        let cells = '';
        for (const cell of row) {
          cells += '<td' + (cell.align ? ' align="' + cell.align + '"' : '') + '>' + inlineToHtml(cell.text, refs, doc) + '</td>\n';
        }
        bodyRows += '<tr>\n' + cells + '</tr>\n';
      }
      out += '<table>\n<thead>\n<tr>\n' + headerCells + '</tr>\n</thead>\n';
      if (bodyRows) out += '<tbody>' + bodyRows + '</tbody>';
      out += '</table>\n';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = Object.create(null);
  const tokens = [];
  lexBlocks(src, refs, true, tokens, false);
  const doc = { inLink: false };
  return renderBlocks(tokens, refs, doc);
}
