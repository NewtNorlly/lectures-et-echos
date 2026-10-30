import { readdir, readFile, stat, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { thoughtLines, noteBody } from './seg140.mjs';

const siteDirectory = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(siteDirectory, '..');
const libraryDirectory = path.join(repositoryRoot, '微信读书');
// 微信读书统计归档到网络博主栏目下的微信读书统计合集（2026-09-22 变更）
const statsDirectory = path.join(repositoryRoot, '微信读书统计');
const exportDirectory = path.resolve(process.argv[2] || '');

// ★本地封面保护（2026-10-30，手册 §8.4/§23/§27.7）：
// 微信读书对 CB_ 导入书给的是 res.weread.qq.com/..._parsecover 热链（浏览器间歇性坏图）
// 或 book_cover_default_imported 占位剪影（非原封面，零容忍）。此前已把这些下载转成本地
// 竖版 WebP 放在 微信读书/文本附件/cover-<bookId>-960/-480.webp。
// 但导入器整本重写 frontmatter 时只用云端 info.cover，会把本地化成果冲回热链/占位图——
// §24（2026-10-25）全量重导就已造成该回归。故这里在建卡前先扫出「已有本地封面」的 bookId，
// 渲染时优先用本地封面块，云端 URL 只在没有本地封面时才用。
const attachmentDirectory = path.join(libraryDirectory, '文本附件');
const localCoverIds = new Set();
try {
  for (const entry of await readdir(attachmentDirectory)) {
    const m = entry.match(/^cover-(.+)-960\.webp$/);
    if (m) localCoverIds.add(m[1]);
  }
} catch { /* 文本附件目录不存在则无本地封面 */ }

// 读一张本地封面的真实像素尺寸，算出竖版比例档位（与 §8.4 的 sharp 两档一致）
async function localCoverBlock(bookId, title) {
  const rel960 = `文本附件/cover-${bookId}-960.webp`;
  const rel480 = `文本附件/cover-${bookId}-480.webp`;
  const abs960 = path.join(attachmentDirectory, `cover-${bookId}-960.webp`);
  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(abs960).metadata();
    width = Number(meta.width) || 0;
    height = Number(meta.height) || 0;
  } catch { return null; }
  if (!width || !height) return null;
  // 竖版比例档位：按 宽/高 归到 2:3 / 3:4 / 4:5（§8.4）
  const ratio = width / height;
  const actualRatio = ratio <= 0.7 ? '2:3' : ratio <= 0.78 ? '3:4' : '4:5';
  const lines = [
    'cover:',
    `  image: '${rel960}'`,
    `  actualRatio: '${actualRatio}'`,
    `  pixelWidth: ${width}`,
    `  pixelHeight: ${height}`,
    '  displayWidth: 100',
    '  displayHeight: 320',
    '  positionX: 50',
    '  positionY: 50',
  ];
  return { lines, calloutImage: `> - ![${title}|200](${rel960})`, rel480 };
}

if (!process.argv[2]) throw new Error('用法：pnpm import:weread -- <微信读书导出目录>');
await stat(exportDirectory);

const manifest = JSON.parse(await readFile(path.join(exportDirectory, 'export-manifest.json'), 'utf8'));
if (manifest.failureCount !== 0) throw new Error(`导出清单仍有 ${manifest.failureCount} 个失败项，请先补抓后再导入。`);

const yamlString = (value) => JSON.stringify(String(value ?? ''));
const cleanText = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim();
const safeFileName = (value) => cleanText(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 120) || '未命名书籍';

// 日期一律按北京时区（Asia/Shanghai）渲染：微信读书的日/年键是本地零点，
// 用 UTC（toISOString）会把凌晨/年首的标签打到前一天、前一年。
function formatDate(timestamp) {
  if (!timestamp || Number(timestamp) <= 0) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(Number(timestamp) * 1000));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
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

function formatFinishedAt(value) {
  // finishedAt 可能是 ISO 字符串，也可能是 Unix 秒（纯数字）；后者直接 new Date() 会得到 1970 年
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && /^\d{8,11}$/.test(String(value))
    ? new Date(numeric * 1000)
    : new Date(value);
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
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

// ★用户点名改过的书标题（2026-10-30 新增，手册 §27.3）：一律用用户定的标题，不被云端 info.title 冲回去。
// 该能力原先只存在于 repair-weread-notes.mjs 的 MERGE_GROUPS.titleOverride 字段里；合并已全面作废
// （§5.4），所以必须独立到导入器，否则每次全量同步都会把用户的改名冲掉。
// 只改「标题」这一项展示字段，书的内容（划线/想法/元数据）仍 100% 来自微信读书，不违反 §2.0。
// key = frontmatter bookId，value = 用户定的标题。新增改名书时在此追加。
const titleOverrides = new Map([
  // 云端是「巨婴国 (武志红) (Z-Library)」，2026-10-25 用户点名改为「巨婴国」（§24.3）
  ['CB_CJ462w60NAIe6yC6wwGxj1Pw', '巨婴国'],
  // 云端是「西行漫记（伟大的长征实录，革命的星火燎原）」，用户点名简称「西行漫记」
  ['3300168271', '西行漫记'],
]);

async function renderBook(data) {
  const info = data.info ?? data.notebook?.book ?? data.shelf ?? {};
  const notebook = data.notebook ?? {};
  const progress = data.progress?.book ?? {};
  const title = cleanText(titleOverrides.get(String(data.bookId)) || info.title || notebook.book?.title || data.bookId);
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

  // ★本地封面优先（2026-10-30，§8.4/§23/§27.7）：磁盘上已有该 bookId 的本地 WebP 就用它，
  // 不被云端 parsecover 热链 / default_imported 占位图冲回。读尺寸失败则回退云端 URL。
  const localCover = localCoverIds.has(String(data.bookId))
    ? await localCoverBlock(String(data.bookId), title)
    : null;

  const frontmatter = [
    '---', 'doc_type: weread-highlights-reviews', `title: ${yamlString(title)}`,
    `bookId: ${yamlString(data.bookId)}`, `reviewCount: ${reviewCount}`, `noteCount: ${noteCount}`,
    `bookmarkCount: ${bookmarkCount}`, `author: ${yamlString(author)}`,
    translator ? `translator: ${yamlString(translator)}` : undefined,
    // ★本地封面优先（2026-10-30）：磁盘上已有 文本附件/cover-<bookId>-960.webp 就用本地块，
    // 不被云端 parsecover 热链 / default_imported 占位图冲回（§8.4/§23/§27.7）。
    ...(localCover ? localCover.lines : (info.cover ? [`cover: ${yamlString(info.cover)}`] : [])),
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
  if (localCover) lines.push(localCover.calloutImage);
  else if (info.cover) lines.push(`> - ![${title}|200](${info.cover})`);
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
        // 💭 想法按 140 怀疑线多段输出（同一条目内 blockquote 续接，💭/🕰 各只出现一次）
        lines.push(...thoughtLines(review.content));
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
      lines.push(noteBody(review.content), '');
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
    `> 数据更新于 ${formatFinishedAt(manifest.finishedAt)}`,
    '', '## 总览', '', '| 指标 | 数值 |', '| --- | ---: |',
    `| 累计阅读时长 | ${formatDuration(overall.totalReadTime)} |`,
    `| 累计阅读天数 | ${Number(overall.readDays ?? 0)} 天 |`,
    // dayAverageReadTime 总览字段缺失/为 0，按「累计时长 / 阅读天数」现算（与月度同口径）
    `| 日均阅读时长 | ${formatDuration(Number(overall.readDays) > 0 ? Number(overall.totalReadTime) / Number(overall.readDays) : 0)} |`,
    `| 注册时间 | ${formatDate(overall.registTime) ?? '—'} |`,
  ];
  for (const item of overall.readStat ?? []) lines.push(`| ${item.stat} | ${item.counts} |`);
  if (overall.readTimes && Object.keys(overall.readTimes).length) {
    lines.push('', '## 历年阅读', '', '| 年份 | 阅读时长 |', '| --- | ---: |');
    // 年键是北京 1 月 1 日 0 点（= UTC 上年 12-31 16:00），按 UTC+8 偏移后再取年
    for (const [timestamp, seconds] of Object.entries(overall.readTimes)) {
      const year = new Date(Number(timestamp) * 1000 + 8 * 3600 * 1000).getUTCFullYear();
      lines.push(`| ${year} | ${formatDuration(seconds)} |`);
    }
  }
  if (overall.readLongest?.length) {
    lines.push('', '## 阅读时长最多', '', '| 书名 | 作者 | 时长 |', '| --- | --- | ---: |');
    for (const item of overall.readLongest) {
      const book = item.book ?? item.albumInfo ?? {};
      // 用户明确删除的书不再出现在阅读榜：云端 readdata 仍会返回它的时长，
      // 但书架里已没有这本书，统计页也不该再提它（2026-10-29）。
      if (excludedBookIds.has(String(book.bookId))) continue;
      lines.push(`| ${cleanText(book.title || book.name)} | ${cleanText(book.author || book.authorName)} | ${formatDuration(item.readTime)} |`);
    }
  }
  if (overall.preferCategory?.length) {
    lines.push('', '## 阅读偏好', '', '| 分类 | 阅读本数 | 阅读时长 |', '| --- | ---: | ---: |');
    for (const item of overall.preferCategory) lines.push(`| ${item.categoryTitle} | ${item.readingCount} | ${formatDuration(item.readingTime)} |`);
  }
  lines.push('', '## 逐月记录', '');
  for (const { name, data } of monthlyRecords.sort((a, b) => b.name.localeCompare(a.name))) {
    const readDays = Number(data.readDays ?? 0);
    lines.push(`### ${name}`, '', '| 指标 | 数值 |', '| --- | ---: |',
      `| 阅读时长 | ${formatDuration(data.totalReadTime)} |`,
      `| 阅读天数 | ${readDays} 天 |`,
      // 月日均同样按「月时长 / 阅读天数」现算，API 字段口径偏小
      `| 日均时长 | ${formatDuration(readDays > 0 ? Number(data.totalReadTime) / readDays : 0)} |`);
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

// 用户明确不再收录的书：云端书架仍可能返回，导入时一律忽略，
// 避免全量同步把已删除的书重新建回来。注意：这只影响「微信读书」书库，
// 与根目录同名的「网络博主」创作者合集无关，后者绝不受此影响。
// 2026-10-18：大猿取经公众号（MP_WXS_3939255758）。
// 2026-10-25：法学教书匠的日常、账号已迁移两个公众号；中县干部；
// 除巨婴国外全部 Z-Library 导入书（中国社会中的宗教/曼昆/突厥历法/语言学的邀请）；
// 两本 Learn to Read Greek；两本「茶馆」相关 CB_ 论文/导入书。
// 2026-10-26：理论好用吗（用户明确要求从我的书架删除）。
// 2026-10-29：哈佛经济学家推理系列（套装共4册）（边际谋杀+致命的均衡+夺命曲线+看不见的手）
//   ——用户明确要求从我的书架与阅读统计里彻底删除；同名的短标题「哈佛经济学家推理系列」
//   （bookId CB_3g93LV3LbF2V77975A0w00ck）是另一本书，必须保留，勿混。
const excludedBookIds = new Set([
  'MP_WXS_3939255758',
  'MP_WXS_3927666464',
  'MP_WXS_3878812206',
  'CB_Bq3AExAFY9ZR6yP6ww3HkFQK',
  'CB_FYdA1vA319ZR6yP6ww8VK6e1',
  'CB_2U7B4lB6pAMn6yD6ww2q71GS',
  'CB_9O6ABeABR9ZR6yP6ww9rZ4xU',
  'CB_ABS0j80hLGAO6ya6ww818FDU',
  'CB_5Kw60E60NAIe6yC6ww9De0o9',
  'CB_B2h9NT9O5GdT6yl6ww4WvDPL',
  'CB_68YBb8BdzGdT6yl6ww9c84uh',
  'CB_6jL1XH1YYGlh6yj6ww53IASi',
  'CB_25h1l31l9Glh6yj6wwCKd2HJ',
  'CB_7n95at5bN1oD6s16sbCJEBhW',
  'CB_8v5Az5AyXAEZ76V75AEJv735',
]);

const bookDirectories = (await readdir(path.join(exportDirectory, 'books'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
let updated = 0;
let created = 0;
let excluded = 0;
let shrunk = 0;   // 以微信读书为准覆盖后内容变少的书（用户已在微信读书删除部分划线/想法）
for (const entry of bookDirectories) {
  const data = JSON.parse(await readFile(path.join(exportDirectory, 'books', entry.name, 'data.json'), 'utf8'));
  if (excludedBookIds.has(String(data.bookId))) {
    excluded += 1;
    console.log(`⊘ 跳过用户已排除的书：${data.bookId}（${data.info?.title ?? data.notebook?.book?.title ?? '未知书名'}）`);
    continue;
  }
  const rendered = await renderBook(data);
  let destination = existingByBookId.get(String(data.bookId));
  if (!destination) {
    const base = safeFileName(rendered.title);
    destination = path.join(libraryDirectory, `${base}.md`);
    if (occupiedPaths.has(destination.toLowerCase())) destination = path.join(libraryDirectory, `${base}-${data.bookId}.md`);
    occupiedPaths.add(destination.toLowerCase());
    created += 1;
  } else {
    // ★fail-closed（2026-10-30 按手册 §2.0 / §4.5 重新定义，取代 2026-09-22 旧版）：
    // 旧规则「新版本 📌/💭 比旧文件少就跳过、保留旧文件」已作废——它会让用户在微信读书里
    // 真删掉的划线永远赖在网站上，正是用户反感的「网站有、微信读书没有」。
    // 新规则：只要本书 5 个接口都抓全（data._complete === true），一律以微信读书为准整本覆盖，
    //        变少也照写（用户在微信读书删了划线，网站就该跟着少）。
    // 唯一保护是「接口残缺不覆盖」：没有 _complete 标记（旧格式导出目录，无法证明数据完整）时，
    //        才退回计数保护，避免拿残缺数据清空既有内容。判定依据是接口是否成功，不是计数是否变少。
    if (data._complete === true) {
      const oldText = await readFile(destination, 'utf8');
      const oldHl = (oldText.match(/📌/g) || []).length;
      const newHl = (rendered.markdown.match(/📌/g) || []).length;
      const oldTh = (oldText.match(/💭/g) || []).length;
      const newTh = (rendered.markdown.match(/💭/g) || []).length;
      if (newHl < oldHl || newTh < oldTh) {
        console.log(`↓ 以微信读书为准覆盖 ${rendered.title}：📌 ${oldHl}→${newHl} 💭 ${oldTh}→${newTh}（用户在微信读书已删除部分内容）`);
        shrunk += 1;
      }
      updated += 1;
    } else {
      const oldText = await readFile(destination, 'utf8');
      const oldHl = (oldText.match(/📌/g) || []).length;
      const oldTh = (oldText.match(/💭/g) || []).length;
      const newHl = (rendered.markdown.match(/📌/g) || []).length;
      const newTh = (rendered.markdown.match(/💭/g) || []).length;
      if (newHl < oldHl || newTh < oldTh) {
        console.warn(`⚠ 数据未标记完整（缺 _complete），跳过 ${rendered.title}：📌 ${oldHl}→${newHl} 💭 ${oldTh}→${newTh}（保留旧文件，请补抓后重导）`);
        continue;
      }
      updated += 1;
    }
  }
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
console.log(`微信读书导入完成：更新 ${updated} 本，新增 ${created} 本，排除 ${excluded} 本，其中以微信读书为准内容变少 ${shrunk} 本，阅读统计 ${monthlyRecords.length} 个月。`);
