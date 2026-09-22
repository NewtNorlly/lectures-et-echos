// 140 字怀疑线：共享分段器（JS 版，与仓库迁移脚本 seg140.py 同一规则）。
// 只在自然边界拆，join 守恒，HTML 标签安全：切点落在未闭合行内标签内时，
// 自动在切点闭合、下一段原样重开（视觉高亮连续），可见文本逐字守恒。
// 规则出处：《智能体操作手册》§7.1 第 10 条、§11.1 验收勾项。

const HAN_RE = () => /[㐀-䶿一-鿿豈-﫿]/g;
export function hanLen(s) {
  return (String(s ?? '').match(HAN_RE()) || []).length;
}

const FINAL = '。！？!?';
const CLOSERS = '”’」』）)】》';
const PAUSE = '，；、';
const CONNECTORS = '并且|但是|因为|所以|如果|虽然|然后|另外|此外|同时|首先|其次|最后|也就是说|换句话说|其实|实际上|当然|不过|于是|因此|然而';
const INLINE_TAGS = new Set(['span', 'b', 'strong', 'em', 'i', 'u', 'mark', 'a', 'sub', 'sup', 'font', 'label', 'code']);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const TAGCLOSE_RE = /^(?:<\/[a-zA-Z][^>]*>)*/;

export function openStack(t) {
  const stack = [];
  for (const m of t.matchAll(TAG_RE)) {
    const tag = m[2].toLowerCase();
    if (!INLINE_TAGS.has(tag)) continue;
    if (m[1] === '/') {
      if (stack.length && stack[stack.length - 1][0] === tag) stack.pop();
    } else if (!m[3].trimEnd().endsWith('/')) {
      stack.push([tag, m[0]]);
    }
  }
  const half = /<[^>]*$/.test(t);
  return [stack, half];
}

function finalParts(para) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < para.length; i++) {
    const ch = para[i];
    buf += ch;
    if (FINAL.includes(ch)) {
      let j = i + 1;
      while (j < para.length && CLOSERS.includes(para[j])) { buf += para[j]; j++; }
      const rest = para.slice(j);
      const cm = rest.match(TAGCLOSE_RE);
      if (cm && cm[0]) { buf += cm[0]; j += cm[0].length; }
      parts.push(buf); buf = '';
      i = j - 1;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

function latinContext(text, idx) {
  return /[A-Za-z]/.test(text.slice(Math.max(0, idx - 1), idx)) &&
         /[A-Za-z]/.test(text.slice(idx + 1, idx + 2));
}

function tagSafeToCut(buf) {
  return !openStack(buf)[1];
}

function splitCapture(text, re) {
  return text.split(re).filter((s) => s !== undefined);
}

function splitBy(part, chars, latinSafe, limit) {
  const toks = splitCapture(part, new RegExp(`([${chars.replace(/[-\\^$]/g, '\\$&')}])`, 'g'));
  const pieces = [];
  let buf = '';
  for (let i = 0; i < toks.length; i++) {
    let piece;
    if (i + 1 < toks.length && chars.includes(toks[i + 1])) { piece = toks[i] + toks[i + 1]; i++; }
    else piece = toks[i];
    let cut = !!buf && hanLen(buf + piece) > limit && tagSafeToCut(buf);
    if (cut && latinSafe && (piece.trim() === ',' || piece.trim() === ';')) {
      cut = latinContext(buf + piece, (buf + piece).replace(/\s+$/, '').length - 1);
    }
    if (cut) { pieces.push(buf); buf = piece; }
    else buf += piece;
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function splitConnectors(part, limit) {
  const toks = splitCapture(part, new RegExp(`(${CONNECTORS})`, 'g'));
  const pieces = [];
  let buf = '';
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    const nxt = toks[k + 1] ?? '';
    if (buf && tok && new RegExp(`^(?:${CONNECTORS})$`).test(tok) && tagSafeToCut(buf)
        && hanLen(buf) > limit * 0.55
        && hanLen(buf) + hanLen(tok) + hanLen(nxt) > limit) {
      pieces.push(buf); buf = tok;
    } else buf += tok;
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function cut(buf) {
  const [stack, half] = openStack(buf);
  if (half || !stack.length) return [buf, ''];
  const closes = [...stack].reverse().map(([t]) => `</${t}>`).join('');
  const opens = stack.map(([, full]) => full).join('');
  return [buf + closes, opens];
}

function pack(parts, limit) {
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    if (buf && hanLen(buf) + hanLen(p) > limit) {
      const [tail, reopen] = cut(buf);
      if (reopen === '' && !openStack(buf)[1]) { chunks.push(tail); buf = ''; }
      else if (reopen) { chunks.push(tail); buf = reopen; }
    }
    buf += p;
    if (hanLen(buf) > limit) {
      const [tail, reopen] = cut(buf);
      if (tail !== buf || reopen) { chunks.push(tail); buf = reopen; }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function splitLong(para, limit = 140) {
  if (hanLen(para) <= limit) return [para];
  const parts = [];
  for (const sent of finalParts(para)) {
    if (hanLen(sent) <= limit) { parts.push(sent); continue; }
    const subs = splitBy(sent, PAUSE + ',;', true, limit);
    for (const s of subs) {
      if (hanLen(s) <= limit) parts.push(s);
      else parts.push(...splitConnectors(s, limit));
    }
  }
  const merged = pack(parts, limit);
  const norm = (x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  if (norm(merged.join('')) !== norm(para)) {
    throw new Error('splitLong conservation broken');
  }
  return merged;
}

// 手机端原始分段习惯：单换行、3 个以上连续空格都是段落边界。
export function sourceParagraphs(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').trim()
    .split(/\s{3,}|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 💭 想法：同一条目内多段 blockquote（💭/🕰 各只出现一次）。
// 返回 markdown 行数组（不含时间戳行）。
export function thoughtLines(content) {
  const paras = sourceParagraphs(content).flatMap((p) => splitLong(p));
  if (!paras.length) return [];
  const lines = [`> 💭 ${paras[0]}`];
  for (const p of paras.slice(1)) lines.push('>', `> ${p}`);
  return lines;
}

// 独立读书笔记/书评正文：段落之间空行分隔，长段再拆。返回 markdown 文本。
export function noteBody(content) {
  const paras = sourceParagraphs(content).flatMap((p) => splitLong(p));
  return paras.join('\n\n');
}
