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
function transformHighlightQuotes(tree) {
  visit(tree, 'blockquote', (node) => {
    if (!node.children) return;
    const whole = nodePlainText(node);
    if (!whole.includes('📌')) return;

    const kindOf = (s) => {
      const t = s.trimStart();
      for (const m of HIGHLIGHT_MARKERS) if (t.startsWith(m)) return m;
      return null;
    };

    const blocks = [];
    let current = null;
    for (const raw of whole.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      const marker = kindOf(line);
      if (marker) {
        current = { kind: marker, text: [line.trimStart().slice(marker.length).trim()] };
        blocks.push(current);
      } else if (line.trim() && current) {
        current.text.push(line.trim());
      }
    }
    if (!blocks.length) return;

    const clsOf = (kind) =>
      kind === '⏱' || kind === '🕰'
        ? 'quote-meta'
        : kind === '💭'
          ? 'quote-thought'
          : 'quote-text';

    node.data = {
      ...(node.data ?? {}),
      hProperties: { className: ['quote-card', 'quote-card--quote'] },
    };
    node.children = blocks.map((block) => ({
      type: 'paragraph',
      data: { hProperties: { className: [clsOf(block.kind)] } },
      children: [{ type: 'text', value: block.text.join(' ') }],
    }));
  });
}

// 「章节点评与书评」下的独立读书笔记：md 里是 一段正文 + 一条 `> 记录于 …` 时间戳。
// 这里按章节归属把它们标成 .note-card 系列（首段 .note-card__head 带 📚 徽标，
// 时间戳段 .note-card__meta），CSS 把两段拼成一张与 📌/💭 都不同的「读书笔记卡」。
// 不删任何内容：无 `记录于` 尾随时间戳的段落原样保留。
function transformWereadNotes(tree) {
  let section = null;
  visit(tree, (node) => {
    if (node.type === 'heading' && node.depth === 2) {
      const text = nodePlainText(node);
      section = text.includes('高亮划线')
        ? 'highlights'
        : text.includes('章节点评与书评')
          ? 'reviews'
          : 'other';
      return;
    }
    if (section !== 'reviews') return;
    if (node.type !== 'paragraph' || !node.children) return;
    // 已处理过的段落跳过，避免重复挂徽标
    if (node.data?.hProperties?.className?.some((c) => c.startsWith('note-card'))) return;

    const siblings = tree.children;
    const idx = siblings.indexOf(node);
    if (idx === -1) return;

    // 向后收：连续段落 + 尾随 `记录于` 块引用
    let j = idx;
    const paras = [];
    while (j < siblings.length && siblings[j].type === 'paragraph') {
      paras.push(siblings[j]);
      j++;
    }
    let meta = null;
    if (j < siblings.length && siblings[j].type === 'blockquote') {
      const mt = nodePlainText(siblings[j]);
      if (mt.includes('记录于')) {
        meta = siblings[j];
        j++;
      }
    }
    if (!meta || paras.length === 0) return;

    paras.forEach((p, i) => {
      const cls = i === 0 ? ['note-card__body', 'note-card__head'] : ['note-card__body'];
      p.data = { ...(p.data ?? {}), hProperties: { className: cls } };
    });
    meta.data = {
      ...(meta.data ?? {}),
      hProperties: { className: ['note-card', 'note-card__meta'] },
    };
  });
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
