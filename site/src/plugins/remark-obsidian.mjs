import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { visit } from 'unist-util-visit';

const siteRoot = path.resolve(process.cwd());
const repositoryRoot = path.resolve(siteRoot, '..');
const imageExtensions = new Set(['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const ignoredDirectories = new Set([
  '.git',
  '.github',
  '.makemd',
  '.obsidian',
  '.space',
  '.trash',
  'AI 指令',
  'node_modules',
  'site',
]);
const calloutLabels = {
  abstract: '摘要',
  attention: '注意',
  bug: '问题',
  caution: '注意',
  danger: '危险',
  example: '示例',
  failure: '失败',
  faq: '问题',
  info: '信息',
  note: '笔记',
  question: '问题',
  quote: '引用',
  success: '完成',
  summary: '摘要',
  tip: '提示',
  todo: '待办',
  warning: '警告',
};

let assetIndex;
let markdownIndex;

function normalizeRepoPath(value) {
  const normalized = path.posix.normalize(String(value).replace(/\\/g, '/').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..') return undefined;
  if (normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return undefined;
  return normalized.normalize('NFC');
}

function absoluteToRepoPath(absolutePath) {
  const relativePath = path.relative(repositoryRoot, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;
  return normalizeRepoPath(relativePath);
}

function sourceFilePath(file) {
  const candidates = [file?.path, ...(file?.history ?? [])].filter(Boolean);

  for (const candidate of candidates) {
    const absoluteCandidates = path.isAbsolute(candidate)
      ? [path.resolve(candidate)]
      : [path.resolve(siteRoot, candidate), path.resolve(repositoryRoot, candidate)];

    for (const absolutePath of absoluteCandidates) {
      const repoPath = absoluteToRepoPath(absolutePath);
      if (repoPath?.toLowerCase().endsWith('.md')) return repoPath;
    }
  }

  return undefined;
}

function addToIndex(index, key, repoPath) {
  const normalizedKey = key.normalize('NFC').toLocaleLowerCase('zh-CN');
  const matches = index.get(normalizedKey) ?? [];
  matches.push(repoPath);
  index.set(normalizedKey, matches);
}

function buildIndexes() {
  if (assetIndex && markdownIndex) return;

  assetIndex = new Map();
  markdownIndex = new Map();

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || ignoredDirectories.has(entry.name)) continue;
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      const repoPath = absoluteToRepoPath(absolutePath);
      if (!repoPath) continue;
      const extension = path.extname(entry.name).toLowerCase();

      if (imageExtensions.has(extension)) {
        addToIndex(assetIndex, entry.name, repoPath);
      } else if (extension === '.md') {
        addToIndex(markdownIndex, entry.name, repoPath);
        addToIndex(markdownIndex, path.basename(entry.name, extension), repoPath);
      }
    }
  }

  walk(repositoryRoot);
}

function existingCandidate(candidate) {
  const repoPath = normalizeRepoPath(candidate);
  if (!repoPath) return undefined;
  const absolutePath = path.resolve(repositoryRoot, ...repoPath.split('/'));
  return existsSync(absolutePath) ? repoPath : undefined;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveAsset(target, sourcePath) {
  const cleanTarget = decodePath(target.trim()).replace(/^\/+/, '');
  const sourceDirectory = sourcePath ? path.posix.dirname(sourcePath) : undefined;
  const candidates = [
    sourceDirectory ? path.posix.join(sourceDirectory, cleanTarget) : undefined,
    sourceDirectory ? path.posix.join(sourceDirectory, '文本附件', cleanTarget) : undefined,
    cleanTarget,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const existing = existingCandidate(candidate);
    if (existing && imageExtensions.has(path.posix.extname(existing).toLowerCase())) return existing;
  }

  buildIndexes();
  const basename = path.posix.basename(cleanTarget).normalize('NFC').toLocaleLowerCase('zh-CN');
  const globalMatches = assetIndex.get(basename) ?? [];
  return globalMatches.length === 1 ? globalMatches[0] : undefined;
}

function resolveMarkdown(target, sourcePath) {
  const withoutAnchor = decodePath(target.trim()).split('#', 1)[0].replace(/^\/+/, '');
  const markdownTarget = withoutAnchor.toLowerCase().endsWith('.md')
    ? withoutAnchor
    : `${withoutAnchor}.md`;
  const sourceDirectory = sourcePath ? path.posix.dirname(sourcePath) : undefined;
  const candidates = [
    sourceDirectory ? path.posix.join(sourceDirectory, markdownTarget) : undefined,
    markdownTarget,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const existing = existingCandidate(candidate);
    if (existing?.toLowerCase().endsWith('.md')) return existing;
  }

  buildIndexes();
  const directKey = path.posix.basename(markdownTarget).normalize('NFC').toLocaleLowerCase('zh-CN');
  const stemKey = path.posix.basename(markdownTarget, '.md').normalize('NFC').toLocaleLowerCase('zh-CN');
  const globalMatches = markdownIndex.get(directKey) ?? markdownIndex.get(stemKey) ?? [];
  return globalMatches.length === 1 ? globalMatches[0] : undefined;
}

function encodeRepoPath(value) {
  return value.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function baseUrl(base, pathname) {
  const normalizedBase = `/${base || ''}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return `${normalizedBase}/${pathname.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
}

function normalizeLabel(value) {
  const normalized = value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return Array.from(normalized || 'item').slice(0, 64).join('');
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const character of value.normalize('NFC')) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function noteId(sourcePath) {
  const title = path.posix.basename(sourcePath, path.posix.extname(sourcePath));
  return `${normalizeLabel(title)}--${fnv1a(sourcePath)}`;
}

function markdownImage(repoPath, alt, base) {
  return {
    type: 'image',
    url: baseUrl(base, `media/${encodeRepoPath(repoPath)}`),
    alt,
    data: {
      hProperties: {
        className: ['markdown-image'],
        loading: 'lazy',
        decoding: 'async',
      },
    },
  };
}

function splitWikiTarget(rawValue) {
  const separator = rawValue.indexOf('|');
  if (separator === -1) return { target: rawValue.trim(), label: undefined };
  return {
    target: rawValue.slice(0, separator).trim(),
    label: rawValue.slice(separator + 1).trim() || undefined,
  };
}

function transformWikiText(value, sourcePath, base) {
  const withoutBlockId = value.replace(/\s+\^[A-Za-z0-9-]+\s*$/u, '');
  const matcher = /(!?)\[\[([^\]]+)\]\]/gu;
  const result = [];
  let lastIndex = 0;
  let match;

  while ((match = matcher.exec(withoutBlockId))) {
    if (match.index > lastIndex) {
      result.push({ type: 'text', value: withoutBlockId.slice(lastIndex, match.index) });
    }

    const isImage = match[1] === '!';
    const { target, label } = splitWikiTarget(match[2]);

    if (isImage) {
      const assetPath = resolveAsset(target, sourcePath);
      result.push(
        assetPath
          ? markdownImage(assetPath, label ?? path.posix.basename(target), base)
          : { type: 'text', value: `[图片未收录：${label ?? path.posix.basename(target)}]` },
      );
    } else {
      const [targetPath, anchor] = target.split('#', 2);
      const markdownPath = resolveMarkdown(targetPath, sourcePath);
      const linkLabel = label ?? path.posix.basename(targetPath, path.posix.extname(targetPath));

      if (markdownPath) {
        const anchorSuffix = anchor ? `#${encodeURIComponent(anchor)}` : '';
        result.push({
          type: 'link',
          url: `${baseUrl(base, `notes/${encodeURIComponent(noteId(markdownPath))}/`)}${anchorSuffix}`,
          children: [{ type: 'text', value: linkLabel }],
        });
      } else {
        result.push({ type: 'text', value: linkLabel });
      }
    }

    lastIndex = matcher.lastIndex;
  }

  if (lastIndex < withoutBlockId.length) {
    result.push({ type: 'text', value: withoutBlockId.slice(lastIndex) });
  }

  return result.length === 1 && result[0].type === 'text' && result[0].value === value
    ? undefined
    : result;
}

function transformCallouts(tree) {
  visit(tree, 'blockquote', (node) => {
    const firstParagraph = node.children?.[0];
    const firstText = firstParagraph?.type === 'paragraph' ? firstParagraph.children?.[0] : undefined;
    if (firstText?.type !== 'text') return;

    const match = firstText.value.match(/^\[!([a-z\d_-]+)\]([+-])?\s*(.*)$/iu);
    if (!match) return;

    const type = match[1].toLocaleLowerCase('en-US');
    const title = match[3].trim() || calloutLabels[type] || type;
    firstParagraph.children.splice(0, 1, {
      type: 'strong',
      children: [{ type: 'text', value: title }],
      data: { hProperties: { className: ['callout-title'] } },
    });
    node.data = {
      ...(node.data ?? {}),
      hName: 'aside',
      hProperties: {
        className: ['callout', `callout-${type}`],
        'data-callout': type,
      },
    };
  });
}

function transformSeparators(tree) {
  visit(tree, (node, index, parent) => {
    if (index === undefined || !parent?.children) return;

    if (node.type === 'html' && /^<center>\s*=+\s*<\/center>\s*$/iu.test(node.value)) {
      parent.children[index] = { type: 'thematicBreak' };
      return;
    }

    if (node.type !== 'paragraph') return;
    const rawValue = node.children
      ?.map((child) => (child.type === 'text' || child.type === 'html' ? child.value : ''))
      .join('');
    if (/^<center>\s*=+\s*<\/center>\s*$/iu.test(rawValue ?? '')) {
      parent.children[index] = { type: 'thematicBreak' };
    }
  });
}

function normalizeHeadingLevels(tree) {
  visit(tree, 'heading', (node) => {
    // 文章模板自带页面级 H1；正文标题整体下沉一级，
    // 恢复「大节(h2) / 章(h3) / 小节(h4)」的层级节奏（原来是把 h1 压成 h2，
    // 导致 md 的 # 与 ## 同处一层、视觉层级全平）。
    node.depth = Math.min((node.depth ?? 1) + 1, 6);
  });
}

// 取一个节点下全部文本（用于按 📌/⏱/💭/🕰 标记重组高亮引文）
function nodePlainText(node) {
  let out = '';
  visit(node, (child) => {
    if (child.type === 'text') out += child.value;
  });
  return out;
}

// 微信读书高亮引文：原来是一个 <blockquote> 里把「📌原文 / ⏱时间 /
// 💭想法 / 🕰想法时间」全塞进同一段、靠空格换行。这里按标记拆成
// 「引文(.quote-text) / 时间戳(.quote-meta) / 我的想法(.quote-thought)」
// 三个有序块，交给 CSS 排成出版级引文卡。仅处理含 📌 的块引用，其余原样。
// 卡片带 --quote 修饰类：📌 原文引用卡；💭 想法是卡内「我的评论」内联块，
// 两者用不同色条 / 底色一眼区分（Emoji 徽标由 CSS ::before 呈现，内容零丢失）。
const HIGHLIGHT_MARKERS = ['📌', '💭', '🕰', '⏱'];
const META_MARKERS = new Set(['⏱', '🕰']);

function classOfKind(kind) {
  if (META_MARKERS.has(kind)) return 'quote-meta';
  if (kind === '💭') return 'quote-thought';
  return 'quote-text';
}

// 把段落内联子节点按「行首 📌/⏱/💭/🕰 标记」切成若干段。
// 关键：💭 想法段保留软换行（转成 break → <br>）与内联结构；
// 📌 原文段 / 时间段不保留软换行（维持自然段落），但文字一个不丢。
function splitParagraphByMarkers(paragraph, initialKind = '📌') {
  const segments = [];
  let cur = null;
  const open = (kind) => {
    cur = { kind, children: [] };
    segments.push(cur);
    return cur;
  };

  for (const child of paragraph.children ?? []) {
    if (child.type === 'break') {
      cur?.children.push({ type: 'break' });
      continue;
    }
    if (child.type !== 'text') {
      (cur ?? open(initialKind)).children.push(child);
      continue;
    }
    const lines = child.value.split('\n');
    lines.forEach((line, i) => {
      if (i > 0) cur?.children.push({ type: 'break' });
      const trimmed = line.trimStart();
      let marker = null;
      for (const m of HIGHLIGHT_MARKERS) {
        if (trimmed.startsWith(m)) {
          marker = m;
          break;
        }
      }
      if (marker) {
        cur = open(marker);
        const rest = trimmed.slice(marker.length).replace(/^\s+/, '');
        if (rest) cur.children.push({ type: 'text', value: rest });
      } else {
        // 无标记的续行段归入「当前标记」（💭 想法的后续段落仍是想法，不是 📌 原文）
        if (!cur) cur = open(initialKind);
        if (line) cur.children.push({ type: 'text', value: line });
      }
    });
  }
  return segments;
}

// 列表最后一项常因 markdown 懒续行吞入后续的 🕰 时间戳、甚至整条新的 💭 想法。
// 按标记把最后一项段落切开：第一段留在列表项，其后的想法/时间戳作为有序
// 「溢出块」返回，由调用方还原到列表之后，保证顺序与原文一致。
function drainListOverflow(list) {
  const overflow = [];
  const lastItem = list.children?.[list.children.length - 1];
  if (!lastItem?.children) return overflow;
  const paras = lastItem.children.filter((c) => c.type === 'paragraph');
  const lastPara = paras[paras.length - 1];
  if (!lastPara) return overflow;

  const segs = splitParagraphByMarkers(lastPara, '💭');
  if (segs.length <= 1) return overflow;

  // 第一段留在列表项，清理首尾残留软换行
  const head = segs[0].children;
  while (head.length && head[0].type === 'break') head.shift();
  while (head.length && head[head.length - 1].type === 'break') head.pop();
  lastPara.children = head;

  // 其余段（时间戳 / 新想法）按原文顺序溢出到列表之后
  for (const seg of segs.slice(1)) {
    let kids = seg.children;
    if (seg.kind !== '💭') kids = kids.filter((c) => c.type !== 'break');
    if (!segmentHasContent({ children: kids })) continue;
    overflow.push({ kind: seg.kind, children: kids });
  }
  return overflow;
}

// 段落内软换行（text 里的 \n）转成硬换行 break（渲染为 <br>），
// 用于「我的想法」「读书笔记」这类用户手写评论，保留其分行呼吸感。
function hardenSoftBreaks(paragraph) {
  const out = [];
  for (const child of paragraph.children ?? []) {
    if (child.type === 'break') {
      out.push(child);
    } else if (child.type === 'text' && child.value.includes('\n')) {
      const parts = child.value.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) out.push({ type: 'break' });
        if (part) out.push({ type: 'text', value: part });
      });
    } else {
      out.push(child);
    }
  }
  paragraph.children = out;
}

function segmentHasContent(seg) {
  return seg.children.some((c) => c.type !== 'break' && (c.type !== 'text' || c.value.trim() !== ''));
}

function transformHighlightQuotes(tree) {
  visit(tree, 'blockquote', (node) => {
    if (!node.children) return;
    if (!nodePlainText(node).includes('📌')) return;

    // 第一步：把顶层块按标记流式归类为有序 items（保留 list 等结构）
    const items = [];
    let currentKind = '📌';
    for (const child of node.children) {
      if (child.type === 'paragraph') {
        // 无标记的续行段归入「当前标记」，避免把 💭 后续段落误判成 📌 原文
        const segments = splitParagraphByMarkers(child, currentKind);
        for (const seg of segments) {
          currentKind = seg.kind;
          let kids = seg.children;
          if (seg.kind !== '💭') {
            // 📌 原文 / 时间戳：软换行不转 <br>，丢弃纯换行节点
            kids = kids.filter((c) => c.type !== 'break');
          }
          if (!segmentHasContent({ children: kids })) continue;
          items.push({ kind: seg.kind, block: 'paragraph', children: kids });
        }
      } else if (child.type === 'list') {
        // 列表只可能属于「我的想法」内容；列表项段落里的软换行也转 <br>
        visit(child, 'paragraph', (p) => hardenSoftBreaks(p));
        items.push({ kind: '💭', block: 'list', node: child });
        currentKind = '💭';
        // 被懒续行吞进最后一个列表项的后续想法 / 时间戳，按序还原到列表之后
        for (const seg of drainListOverflow(child)) {
          items.push({ kind: seg.kind, block: 'paragraph', children: seg.children });
          currentKind = seg.kind;
        }
      } else if (child.type === 'blockquote') {
        // 想法中用嵌套引用（> >）摘录的金句：内部软换行转 <br>，挂想法内引文样式
        visit(child, 'paragraph', (p) => hardenSoftBreaks(p));
        child.data = child.data ?? {};
        child.data.hProperties = {
          ...(child.data.hProperties ?? {}),
          className: ['quote-thought-quote'],
        };
        items.push({ kind: '💭', block: 'blockquote', node: child });
        currentKind = '💭';
      } else if (child.type) {
        items.push({ kind: currentKind, block: child.type, node: child });
      }
    }
    if (!items.length) return;

    // 第二步：为连续的 💭 项（段落 + 列表）标记 is-first / is-last，CSS 据此拼成一块
    items.forEach((it) => {
      it.thought = it.kind === '💭';
    });
    let runStart = -1;
    const flushRun = (end) => {
      if (runStart === -1) return;
      for (let k = runStart; k <= end; k += 1) {
        if (k === runStart) items[k].first = true;
        if (k === end) items[k].last = true;
      }
      runStart = -1;
    };
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].thought) {
        if (runStart === -1) runStart = i;
      } else {
        flushRun(i - 1);
      }
    }
    flushRun(items.length - 1);

    // 第三步：重建 blockquote 子节点（段落挂 class，列表保留原节点挂 class）
    const rebuilt = items.map((it) => {
      if (it.block === 'list') {
        const cls = ['quote-thought-list'];
        if (it.first) cls.push('is-first');
        if (it.last) cls.push('is-last');
        it.node.data = {
          ...(it.node.data ?? {}),
          hProperties: { ...(it.node.data?.hProperties ?? {}), className: cls },
        };
        return it.node;
      }
      if (it.block !== 'paragraph') return it.node;
      const cls = [classOfKind(it.kind)];
      if (it.thought) {
        if (it.first) cls.push('is-first');
        if (it.last) cls.push('is-last');
      }
      return {
        type: 'paragraph',
        data: { hProperties: { className: cls } },
        children: it.children,
      };
    });

    node.data = {
      ...(node.data ?? {}),
      hProperties: { className: ['quote-card', 'quote-card--quote'] },
    };
    node.children = rebuilt;
  });
}

// 「章节点评与书评」下的独立读书笔记：md 里是「## 读书笔记 / ## 本书评论」标题 +
// 正文（可含多个段落、列表，偶有 --- 分隔线）+ 一条 `> 记录于 …` 时间戳。
// 这里按标题把整组标成 .note-card 系列：正文块（段落 / 列表）挂 .note-card__body，
// 首块带 .note-card__head（📚 徽标），时间戳块挂 .note-card__meta；连续块用
// is-first / is-last 拼出同一张圆角色块（列表也包在色块内），--- 分隔线前后的
// 色块各自收口。不删任何内容：组尾没有「记录于」块引用、或出现未支持块类型时，
// 整组原样保留（fail-safe）。
function transformWereadNotes(tree) {
  let section = 'other';
  const groups = [];
  let current = null;

  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 2) {
      const text = nodePlainText(node);
      section = text.includes('高亮划线')
        ? 'highlights'
        : text.includes('章节点评与书评')
          ? 'reviews'
          : 'other';
      current = null;
      continue;
    }
    if (section !== 'reviews') continue;
    if (node.type === 'heading' && node.depth === 3) {
      current = { blocks: [] };
      groups.push(current);
      continue;
    }
    // h3 标题之前的游离块不属于任何笔记，原样保留
    if (current) current.blocks.push(node);
  }

  for (const group of groups) {
    // 组尾必须是含「记录于」的块引用，作为时间戳块；否则整组不动
    const meta = group.blocks[group.blocks.length - 1];
    if (!meta || meta.type !== 'blockquote' || !nodePlainText(meta).includes('记录于')) continue;
    const bodyBlocks = group.blocks.slice(0, -1);
    if (bodyBlocks.length === 0) continue;
    // 只支持段落 / 列表 / 分隔线，出现别的块类型时为保内容安全整组放弃
    if (
      bodyBlocks.some(
        (b) => b.type !== 'paragraph' && b.type !== 'list' && b.type !== 'thematicBreak',
      )
    ) {
      continue;
    }

    // 读书笔记是用户手写评论：段落（含列表项内段落）保留单换行（转 <br>）
    for (const b of bodyBlocks) {
      if (b.type === 'paragraph') hardenSoftBreaks(b);
      if (b.type === 'list') visit(b, 'paragraph', (p) => hardenSoftBreaks(p));
    }

    // 按 --- 分隔线把正文切成视觉段（相邻分隔线产生的空段忽略）；
    // 组尾若不是分隔线，最后一段与 meta 紧邻，下角由 meta 收
    const segments = [[]];
    for (const b of bodyBlocks) {
      if (b.type === 'thematicBreak') {
        segments.push([]);
        continue;
      }
      segments[segments.length - 1].push(b);
    }
    const filled = segments.filter((seg) => seg.length > 0);
    if (filled.length === 0) continue;
    const metaAdjoins = bodyBlocks[bodyBlocks.length - 1].type !== 'thematicBreak';

    filled.forEach((seg, segIndex) => {
      const isLastSeg = segIndex === filled.length - 1;
      seg.forEach((b, blockIndex) => {
        const cls = ['note-card__body'];
        if (b.type === 'list') cls.push('note-card__body--list');
        if (blockIndex === 0) cls.push('is-first');
        // 最后一段与 meta 紧邻时，下角交给 meta 收，本段不留底圆角
        if (blockIndex === seg.length - 1 && !(isLastSeg && metaAdjoins)) cls.push('is-last');
        if (segIndex === 0 && blockIndex === 0) cls.push('note-card__head');
        b.data = {
          ...(b.data ?? {}),
          hProperties: { ...(b.data?.hProperties ?? {}), className: cls },
        };
      });
    });

    const metaCls = ['note-card', 'note-card__meta', 'is-last'];
    if (!metaAdjoins) metaCls.push('is-first');
    meta.data = {
      ...(meta.data ?? {}),
      hProperties: { ...(meta.data?.hProperties ?? {}), className: metaCls },
    };
  }
}

// 展示层剥离微信读书外链：元数据 callout 里的「微信读书：https://weread.qq.com/…」
// 清单项与正文里指向 weread.qq.com/book-detail 的链接一律不渲染（源 md 不动）。
// 边遍历边删会跳节点，故先收集再逆序删除。
function stripWereadSourceLinks(tree) {
  const removals = [];
  visit(tree, 'listItem', (node, index, parent) => {
    if (!parent?.children || index === undefined) return;
    const text = nodePlainText(node);
    if (text.includes('weread.qq.com/book-detail')) {
      removals.push({ parent, index });
    }
  });
  visit(tree, 'link', (node, index, parent) => {
    if (!parent?.children || index === undefined) return;
    if (/weread\.qq\.com\/book-detail/u.test(node.url)) {
      removals.push({ parent, index });
    }
  });
  removals
    .sort((a, b) => b.index - a.index)
    .forEach(({ parent, index }) => parent.children.splice(index, 1));
}

function transformTextNodes(tree, sourcePath, base) {
  const targets = [];
  visit(tree, 'text', (node, index, parent) => {
    if (index === undefined || !parent?.children || parent.type === 'link') return;
    targets.push({ node, index, parent });
  });

  for (const { node, index, parent } of targets.reverse()) {
    const replacement = transformWikiText(node.value, sourcePath, base);
    if (replacement) parent.children.splice(index, 1, ...replacement);
  }
}

function transformImages(tree, sourcePath, base) {
  visit(tree, 'image', (node) => {
    const widthMatch = node.alt?.match(/^(.*?)\|(\d{2,4})$/u);
    if (widthMatch) node.alt = widthMatch[1].trim();

    const properties = {
      ...(node.data?.hProperties ?? {}),
      className: ['markdown-image'],
      loading: 'lazy',
      decoding: 'async',
    };
    if (widthMatch) properties.width = Math.min(1200, Math.max(40, Number(widthMatch[2])));

    node.data = { ...(node.data ?? {}), hProperties: properties };
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(node.url)) return;

    const assetPath = resolveAsset(node.url, sourcePath);
    if (assetPath) node.url = baseUrl(base, `media/${encodeRepoPath(assetPath)}`);
  });
}

function transformMarkdownLinks(tree, sourcePath, base) {
  visit(tree, 'link', (node) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(node.url)) return;
    const [targetPath, anchor] = node.url.split('#', 2);
    if (!targetPath.toLowerCase().endsWith('.md')) return;

    const markdownPath = resolveMarkdown(targetPath, sourcePath);
    if (!markdownPath) return;
    node.url = `${baseUrl(base, `notes/${encodeURIComponent(noteId(markdownPath))}/`)}${
      anchor ? `#${encodeURIComponent(anchor)}` : ''
    }`;
  });
}

export function remarkObsidian(options = {}) {
  const base = options.base ?? '';

  return (tree, file) => {
    const sourcePath = sourceFilePath(file);
    normalizeHeadingLevels(tree);
    transformSeparators(tree);
    transformCallouts(tree);
    transformHighlightQuotes(tree);
    transformWereadNotes(tree);
    stripWereadSourceLinks(tree);
    transformTextNodes(tree, sourcePath, base);
    transformImages(tree, sourcePath, base);
    transformMarkdownLinks(tree, sourcePath, base);
  };
}

export default remarkObsidian;
