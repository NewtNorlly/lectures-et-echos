import { readdir, readFile, stat, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDirectory = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(siteDirectory, '..');
const libraryDirectory = path.join(repositoryRoot, '微信读书');
// 微信读书统计归档到网络博主栏目下的微信读书统计合集（2026-09-22 变更）
const statsDirectory = path.join(repositoryRoot, '微信读书统计');
const exportDirectory = path.resolve(process.argv[2] || '');

if (!process.argv[2]) throw new Error('用法：pnpm import:weread -- <微信读书导出目录>');
await stat(exportDirectory);

const manifest = JSON.parse(await readFile(path.join(exportDirectory, 'export-manifest.json'), 'utf8'));
if (manifest.failureCount !== 0) throw new Error(`导出清单仍有 ${manifest.failureCount} 个失败项，请先补抓后再导入。`);

const yamlString = (value) => JSON.stringify(String(value ?? ''));
const cleanText = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim();
const safeFileName = (value) => cleanText(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 120) || '未命名书籍';

function formatDate(timestamp) {
  if (!timestamp || Number(timestamp) <= 0) return undefined;
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

function formatDateTime(timestamp) {
  if (!timestamp || Number(timestamp) <= 0) return undefined;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(Number(timestamp) * 1000));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours && minutes) return `${hours}小时${minutes}分钟`;
  if (hours) return `${hours}小时`;
  return `${minutes}分钟`;
}

const quoteLines = (value, prefix = '> ') => cleanText(value).split('\n').map((line) => `${prefix}${line}`).join('\n');
const reviewValue = (item) => item?.review?.review ?? item?.review ?? item ?? {};
const existingBookId = (raw) => raw.match(/^bookId:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
const readingTimestamp = (data) => data.notebook?.sort ?? data.shelf?.readUpdateTime ?? data.progress?.book?.updateTime;

function renderBook(data) {
  const info = data.info ?? data.notebook?.book ?? data.shelf ?? {};
  const notebook = data.notebook ?? {};
  const progress = data.progress?.book ?? {};
  const title = cleanText(info.title || notebook.book?.title || data.bookId);
  const author = cleanText(info.author || notebook.book?.author);
  const translator = cleanText(info.translator || notebook.book?.translator);
  const category = cleanText(info.category || notebook.book?.categories?.[0]?.title);
  const bookmarkCount = Number(notebook.bookmarkCount ?? 0);
  const lastReadDate = formatDate(readingTimestamp(data));
  const readingDate = formatDate(progress.startReadingTime);
  const finishedDate = formatDate(progress.finishTime);
  const sourceUrl = cleanText(info.deepLink || notebook.book?.deepLink);
  const rating = Number(info.newRating) > 0 ? `${Math.round(Number(info.newRating) / 10)}%` : '';

  /* ---------- 先建章节 / 划线 / 想法模型（含孤儿锚点归位） ---------- */
  const chapterMap = new Map();
  for (const chapter of data.chapters?.chapters ?? []) chapterMap.set(Number(chapter.chapterUid), chapter);
  for (const chapter of data.highlights?.chapters ?? []) {
    const current = chapterMap.get(Number(chapter.chapterUid)) ?? {};
    chapterMap.set(Number(chapter.chapterUid), { ...current, ...chapter });
  }
  const chapterTitleOf = (uid, fallbackName) => {
    const c = chapterMap.get(Number(uid));
    return cleanText(c?.title || fallbackName || `章节 ${uid}`);
  };

  const reviews = (data.reviews?.reviews ?? []).map(reviewValue);
  // range 只在章节内唯一、跨章可能撞号，想法归属优先用「章节uid:range」；
  // 章节信息缺失（如公众号文章）时，退化为全书唯一 range 匹配。
  const reviewsByKey = new Map();
  const reviewsByRange = new Map();
  const standaloneReviews = [];
  const pushInto = (map, key, review) => {
    const list = map.get(key) ?? [];
    list.push(review);
    map.set(key, list);
  };
  for (const review of reviews) {
    if (review.range) {
      pushInto(reviewsByKey, `${Number(review.chapterUid ?? 0)}:${String(review.range)}`, review);
      pushInto(reviewsByRange, String(review.range), review);
    } else standaloneReviews.push(review);
  }
  const highlightsByChapter = new Map();
  const rangeFrequency = new Map();
  for (const highlight of data.highlights?.updated ?? []) {
    const uid = Number(highlight.chapterUid ?? 0);
    const list = highlightsByChapter.get(uid) ?? [];
    list.push(highlight);
    highlightsByChapter.set(uid, list);
    const rangeKey = String(highlight.range);
    rangeFrequency.set(rangeKey, (rangeFrequency.get(rangeKey) ?? 0) + 1);
  }
  const reviewsForHighlight = (uid, range) => {
    const rangeKey = String(range);
    const exact = reviewsByKey.get(`${uid}:${rangeKey}`);
    if (exact?.length) return exact;
    if ((rangeFrequency.get(rangeKey) ?? 0) === 1) return reviewsByRange.get(rangeKey) ?? [];
    return [];
  };

  // 哪些想法挂到了真实书签上
  const attachedReviews = new Set();
  for (const [uid, highlights] of highlightsByChapter) {
    for (const highlight of highlights) {
      for (const review of reviewsForHighlight(uid, highlight.range)) attachedReviews.add(review);
    }
  }

  // 孤儿锚点归位（2026-09-22 修复，用户零容忍）：
  // 有些划线在 bookmarklist.updated 里已不存在（前置章「献词」等、或被阅读器重排后丢失），
  // 但其想法（review）仍带着 abstract（原划线文本）/ range / chapterUid / chapterName。
  // 旧逻辑把这些想法当「detached」塞进「章节点评与书评」，只输出 blockquote 摘要 + 想法时间（记录于），
  // 丢掉了它本来就是一条划线这一身份、也没有 ⏱ 划线时间。
  // 新逻辑：按 (chapterUid, range) 把同锚点的想法聚成一条「隐式划线」——
  //   📌 = abstract 锚文；⏱ = 该锚点最早想法时间（划线时刻的唯一可得近似）；
  //   每条想法 = 💭 + 🕰（其自身 createTime）。按 chapterUid/章节名归位进 # 高亮划线。
  const orphanGroups = new Map();
  for (const review of reviews) {
    if (!review.range || attachedReviews.has(review)) continue;
    const key = `${Number(review.chapterUid ?? 0)}:${String(review.range)}`;
    let g = orphanGroups.get(key);
    if (!g) {
      g = {
        uid: Number(review.chapterUid ?? 0),
        range: String(review.range),
        chapterName: cleanText(review.chapterName || review.chapterTitle || ''),
        text: '',
        anchorTime: null,
        reviews: [],
      };
      orphanGroups.set(key, g);
    }
    const anchorText = cleanText(review.abstract || review.content || '');
    if (!g.text && anchorText) g.text = anchorText;
    g.reviews.push(review);
    const t = Number(review.createTime ?? 0);
    if (g.anchorTime === null || t < g.anchorTime) g.anchorTime = t;
  }
  for (const g of orphanGroups.values()) {
    if (!g.text) continue; // 连锚文都没有，无法成划线，留作独立想法
    const pseudo = {
      chapterUid: g.uid,
      range: g.range,
      markText: g.text,
      createTime: g.anchorTime,
      __orphan: true,
      __orphanReviews: g.reviews,
    };
    const list = highlightsByChapter.get(g.uid) ?? [];
    list.push(pseudo);
    highlightsByChapter.set(g.uid, list);
  }
  // 真正无 range 的独立想法 / 书评（保留进「章节点评与书评」）
  const allStandaloneReviews = standaloneReviews.slice().sort((a, b) => Number(a.createTime ?? 0) - Number(b.createTime ?? 0));

  /* ---------- 派生计数（保证 noteCount==📌、reviewCount==💭+独立 h2 恒等式） ---------- */
  const noteCount = [...highlightsByChapter.values()].reduce((n, list) => n + list.length, 0);
  const orphanReviewCount = [...orphanGroups.values()].reduce((n, g) => n + g.reviews.length, 0);
  const inlineThoughtCount = attachedReviews.size + orphanReviewCount;
  const reviewCount = inlineThoughtCount + allStandaloneReviews.length;

  const frontmatter = [
    '---', 'doc_type: weread-highlights-reviews', `title: ${yamlString(title)}`,
    `bookId: ${yamlString(data.bookId)}`, `reviewCount: ${reviewCount}`, `noteCount: ${noteCount}`,
    `bookmarkCount: ${bookmarkCount}`, `author: ${yamlString(author)}`,
    translator ? `translator: ${yamlString(translator)}` : undefined,
    info.cover ? `cover: ${yamlString(info.cover)}` : undefined,
    `progress: ${yamlString(`${Number(progress.progress ?? notebook.readingProgress ?? 0)}%`)}`,
    `readingTime: ${yamlString(formatDuration(progress.readingTime))}`,
    readingDate ? `readingDate: ${readingDate}` : undefined,
    finishedDate ? `finishedDate: ${finishedDate}` : undefined,
    lastReadDate ? `lastReadDate: ${lastReadDate}` : undefined,
    info.isbn ? `isbn: ${yamlString(info.isbn)}` : undefined,
    category ? `category: ${yamlString(category)}` : undefined,
    info.publisher ? `publisher: ${yamlString(info.publisher)}` : undefined,
    info.publishTime ? `publishTime: ${yamlString(info.publishTime)}` : undefined,
    rating ? `rating: ${yamlString(rating)}` : undefined,
    sourceUrl ? `sourceUrl: ${yamlString(sourceUrl)}` : undefined,
    '---', '',
  ].filter((line) => line !== undefined);

  const lines = [...frontmatter, '# 元数据', '', `> [!abstract] ${title}`];
  if (info.cover) lines.push(`> - ![${title}|200](${info.cover})`);
  lines.push(`> - 书名：${title}`);
  if (author) lines.push(`> - 作者：${author}`);
  if (translator) lines.push(`> - 译者：${translator}`);
  if (info.intro) lines.push(`> - 简介：${cleanText(info.intro).replace(/\n/g, '\n>   ')}`);
  if (info.publishTime) lines.push(`> - 出版时间：${info.publishTime}`);
  if (info.isbn) lines.push(`> - ISBN：${info.isbn}`);
  if (category) lines.push(`> - 分类：${category}`);
  if (info.publisher) lines.push(`> - 出版社：${info.publisher}`);
  if (rating) lines.push(`> - 微信读书评分：${rating}`);
  lines.push(`> - 阅读进度：${Number(progress.progress ?? notebook.readingProgress ?? 0)}%`);
  lines.push(`> - 阅读时长：${formatDuration(progress.readingTime)}`);
  if (lastReadDate) lines.push(`> - 最后阅读：${lastReadDate}`);
  if (sourceUrl) lines.push(`> - 微信读书：${sourceUrl}`);
  lines.push('');

  lines.push('# 高亮划线', '');
  if (!highlightsByChapter.size) lines.push('> 这本书目前没有个人划线。', '');
  const chapterEntries = [...highlightsByChapter.entries()].sort((left, right) => Number(chapterMap.get(left[0])?.chapterIdx ?? left[0]) - Number(chapterMap.get(right[0])?.chapterIdx ?? right[0]));
  for (const [uid, highlights] of chapterEntries) {
    lines.push(`## ${chapterTitleOf(uid)}`, '');
    highlights.sort((a, b) => Number(String(a.range ?? '0').split('-')[0]) - Number(String(b.range ?? '0').split('-')[0]));
    for (const highlight of highlights) {
      lines.push(quoteLines(`📌 ${highlight.markText}`));
      const timestamp = formatDateTime(highlight.createTime);
      if (timestamp) lines.push(`> ⏱ ${timestamp}`);
      const attached = highlight.__orphan ? (highlight.__orphanReviews ?? []) : reviewsForHighlight(uid, highlight.range);
      for (const review of attached) {
        lines.push(`> 💭 ${cleanText(review.content).replace(/\n/g, '\n>    ')}`);
        const reviewTime = formatDateTime(review.createTime);
        if (reviewTime) lines.push(`> 🕰 ${reviewTime}`);
      }
      lines.push('');
    }
  }
  if (allStandaloneReviews.length) {
    lines.push('# 章节点评与书评', '');
    for (const review of allStandaloneReviews) {
      const heading = cleanText(review.chapterName || review.chapterTitle || (review.type === 6 ? '本书评论' : '读书笔记'));
      lines.push(`## ${heading}`, '');
      lines.push(cleanText(review.content), '');
      const timestamp = formatDateTime(review.createTime);
      if (timestamp) lines.push(`> 记录于 ${timestamp}`, '');
    }
  }
  return { title, markdown: `${lines.join('\n').replace(/[ \t]+$/gm, '').trim()}\n` };
}

function renderStats(overall, monthlyRecords) {
  const lines = [
    '---', 'doc_type: weread-reading-stats', 'title: "微信读书阅读统计"',
    'description: "微信读书累计阅读时长、阅读天数与逐月记录。"', '---', '',
    '# 微信读书阅读统计', '',
    `> 数据更新于 ${new Date(manifest.finishedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    '', '## 总览', '', '| 指标 | 数值 |', '| --- | ---: |',
    `| 累计阅读时长 | ${formatDuration(overall.totalReadTime)} |`,
    `| 累计阅读天数 | ${Number(overall.readDays ?? 0)} 天 |`,
    `| 日均阅读时长 | ${formatDuration(overall.dayAverageReadTime)} |`,
    `| 注册时间 | ${formatDate(overall.registTime) ?? '—'} |`,
  ];
  for (const item of overall.readStat ?? []) lines.push(`| ${item.stat} | ${item.counts} |`);
  if (overall.readTimes && Object.keys(overall.readTimes).length) {
    lines.push('', '## 历年阅读', '', '| 年份 | 阅读时长 |', '| --- | ---: |');
    for (const [timestamp, seconds] of Object.entries(overall.readTimes)) lines.push(`| ${new Date(Number(timestamp) * 1000).getUTCFullYear()} | ${formatDuration(seconds)} |`);
  }
  if (overall.readLongest?.length) {
    lines.push('', '## 阅读时长最多', '', '| 书名 | 作者 | 时长 |', '| --- | --- | ---: |');
    for (const item of overall.readLongest) {
      const book = item.book ?? item.albumInfo ?? {};
      lines.push(`| ${cleanText(book.title || book.name)} | ${cleanText(book.author || book.authorName)} | ${formatDuration(item.readTime)} |`);
    }
  }
  if (overall.preferCategory?.length) {
    lines.push('', '## 阅读偏好', '', '| 分类 | 阅读本数 | 阅读时长 |', '| --- | ---: | ---: |');
    for (const item of overall.preferCategory) lines.push(`| ${item.categoryTitle} | ${item.readingCount} | ${formatDuration(item.readingTime)} |`);
  }
  lines.push('', '## 逐月记录', '');
  for (const { name, data } of monthlyRecords.sort((a, b) => b.name.localeCompare(a.name))) {
    lines.push(`### ${name}`, '', '| 指标 | 数值 |', '| --- | ---: |',
      `| 阅读时长 | ${formatDuration(data.totalReadTime)} |`,
      `| 阅读天数 | ${Number(data.readDays ?? 0)} 天 |`,
      `| 日均时长 | ${formatDuration(data.dayAverageReadTime)} |`);
    for (const item of data.readStat ?? []) lines.push(`| ${item.stat} | ${item.counts} |`);
    if (data.readTimes && Object.keys(data.readTimes).length) {
      lines.push('', '<details>', '<summary>每日阅读时长</summary>', '', '| 日期 | 时长 |', '| --- | ---: |');
      for (const [timestamp, seconds] of Object.entries(data.readTimes)) lines.push(`| ${formatDate(timestamp)} | ${formatDuration(seconds)} |`);
      lines.push('', '</details>', '');
    } else lines.push('');
  }
  return `${lines.join('\n').replace(/[ \t]+$/gm, '').trim()}\n`;
}

const existingFiles = (await readdir(libraryDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== '微信读书Gallery.md');
const existingByBookId = new Map();
const occupiedPaths = new Set(existingFiles.map((entry) => path.join(libraryDirectory, entry.name).toLowerCase()));
for (const entry of existingFiles) {
  const filePath = path.join(libraryDirectory, entry.name);
  const id = existingBookId(await readFile(filePath, 'utf8'));
  if (id) existingByBookId.set(id, filePath);
}

const bookDirectories = (await readdir(path.join(exportDirectory, 'books'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
let updated = 0;
let created = 0;
for (const entry of bookDirectories) {
  const data = JSON.parse(await readFile(path.join(exportDirectory, 'books', entry.name, 'data.json'), 'utf8'));
  const rendered = renderBook(data);
  let destination = existingByBookId.get(String(data.bookId));
  if (!destination) {
    const base = safeFileName(rendered.title);
    destination = path.join(libraryDirectory, `${base}.md`);
    if (occupiedPaths.has(destination.toLowerCase())) destination = path.join(libraryDirectory, `${base}-${data.bookId}.md`);
    occupiedPaths.add(destination.toLowerCase());
    created += 1;
  } else updated += 1;
  await writeFile(destination, rendered.markdown, 'utf8');
}

const overall = JSON.parse(await readFile(path.join(exportDirectory, 'reading-stats', 'overall.json'), 'utf8'));
const monthlyDirectory = path.join(exportDirectory, 'reading-stats', 'monthly');
const monthlyRecords = [];
for (const entry of await readdir(monthlyDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
  monthlyRecords.push({ name: entry.name.slice(0, -5), data: JSON.parse(await readFile(path.join(monthlyDirectory, entry.name), 'utf8')) });
}
await mkdir(statsDirectory, { recursive: true });
const statsPath = path.join(statsDirectory, '微信读书阅读统计.md');
await writeFile(statsPath, renderStats(overall, monthlyRecords), 'utf8');
// 清理旧位置（2026-09-22 起统计归档到微信读书统计合集）
try { await unlink(path.join(libraryDirectory, '微信读书阅读统计.md')); } catch { /* 旧文件已不存在 */ }
console.log(`微信读书导入完成：更新 ${updated} 本，新增 ${created} 本，阅读统计 ${monthlyRecords.length} 个月。`);
