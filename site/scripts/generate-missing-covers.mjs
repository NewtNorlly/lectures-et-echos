import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const siteDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(siteDirectory, "..");
const manifestPath = path.join(siteDirectory, "assets", "cover-system", "generated-cover-manifest.json");

const width = 960;
const height = 640;
const smallWidth = 480;
const smallHeight = 320;
const concurrency = 4;
const args = process.argv.slice(2);
const previewMode = args.includes("--preview");
const regenerateAll = args.includes("--regenerate-all");
const checkMode = args.includes("--check");
const previewDirectory = path.join(siteDirectory, "assets", "cover-system", "previews");

const skippedDirectories = new Set([
  ".git",
  ".github",
  ".makemd",
  ".obsidian",
  ".space",
  ".trash",
  "AI 指令",
  "node_modules",
  "site",
  "文本附件",
]);

// 图书馆风格：暖白纸底、细双线框、衬线标题、极淡线性母题。8 个分类仅作极淡冷暖区分，整体统一沉稳。
const palettes = {
  technology: {
    label: "科技 · 计算",
    paper: "#eceee7",
    ink: "#2b3336",
    line: "#9aa4a0",
    accent: "#5f7c84",
  },
  language: {
    label: "语言 · 文字",
    paper: "#f2ebd9",
    ink: "#332d22",
    line: "#b3a788",
    accent: "#9a7b4f",
  },
  mind: {
    label: "心理 · 生活",
    paper: "#f1e6e2",
    ink: "#33272c",
    line: "#b8a2a4",
    accent: "#9c6b72",
  },
  culture: {
    label: "文学 · 影像",
    paper: "#f0ead9",
    ink: "#2c2a24",
    line: "#b6ad96",
    accent: "#8a6d4b",
  },
  nature: {
    label: "自然 · 行旅",
    paper: "#eaeeda",
    ink: "#2a332c",
    line: "#a3ad97",
    accent: "#6f8570",
  },
  history: {
    label: "历史 · 地缘",
    paper: "#f0e6d0",
    ink: "#2e271c",
    line: "#b6a684",
    accent: "#96683a",
  },
  society: {
    label: "社会 · 观察",
    paper: "#efe7db",
    ink: "#2b2620",
    line: "#b3a894",
    accent: "#8a6f52",
  },
  general: {
    label: "公共文本档案",
    paper: "#f2ecdf",
    ink: "#2a2620",
    line: "#b3aa97",
    accent: "#7d6a52",
  },
};

const categoryRules = [
  ["technology", /\b(?:AI|Agent|API|Claude|Code|DeepSeek|MiniMax|OpenClaw|OpenHanako|Python|Skill|LV6)\b|人工智能|算法|芯片|代码|编程|计算机|互联网|科技|硬盘|储存/i],
  ["language", /语言|汉字|汉语|口音|英语|法语|外语|词汇|阅读速度|演讲|发言|千字文|教育|考试|题库/],
  ["mind", /心理|焦虑|迷茫|睡眠|熬夜|疲劳|爱情|真爱|共情|性压抑|性幻想|成长|人生|生活|幸福|友谊|认知|意识|努力|记性|脑科学|主角/],
  ["culture", /电影|影后|奥斯卡|宫崎骏|动漫|文学|小说|名著|诗|词|鲁迅|哈利|赫敏|罗恩|川端|伊豆|雪国|红与黑|孩子王|审美|摇滚|电音|流行乐|文艺|艺术|作品|追星/],
  ["nature", /雪山|湖|秦岭|地理|行旅|旅行|沙漠|海鲜|太空|宇宙|鱼进化|近视|草原|悬崖|自然|核禁区/],
  ["history", /历史|王朝|商周|春秋|战国|东汉|秦国|魏国|五代十国|清朝|元清|罗马|日本|伊朗|俄罗斯|非洲|欧洲|大洋洲|琉球|尼泊尔|斯拉夫|王室|女王|首相|政变|战争|国军|共产党|毛泽东|井冈山|蒙古|犹太|塔利班|波斯|光绪|维新|将军|官僚|民族|帝国|王洪文|扬州十日|加里波第|撒切尔/],
  ["society", /社会|中国|美国|中美|韩国|台湾|年轻人|女性|男性|华人|留学生|媒体|价值观|贫困|生育|剥削|国家|政治|文化|知识分子|城市|教育|家庭|父亲|女儿|大学生|网红/],
];

function toPosix(value) {
  return value.replace(/\\/g, "/").normalize("NFC");
}

function hashHex(value) {
  return createHash("sha256").update(value.normalize("NFC")).digest("hex");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function yamlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseFrontmatter(raw) {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? raw.slice(1) : raw;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  return { bom, text, newline, match, frontmatter: match?.[1] ?? "" };
}

function isDraft(frontmatter) {
  return /^draft:[ \t]*(?:true|'true'|"true")[ \t]*$/im.test(frontmatter);
}

function getYamlScalar(frontmatter, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatter.match(new RegExp(`^${escapedKey}:[ \\t]*(.+?)[ \\t]*$`, "im"));
  if (!match) return undefined;
  return match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, double, single) => double ?? single);
}

function coverImagePath(frontmatter) {
  const lines = frontmatter.split(/\r?\n/);
  const coverIndex = lines.findIndex((line) => /^cover:[ \t]*/i.test(line));
  if (coverIndex < 0) return undefined;
  const inlineValue = lines[coverIndex].replace(/^cover:[ \t]*/i, "").trim();
  if (inlineValue && inlineValue !== "null" && inlineValue !== "~") return inlineValue;
  for (let index = coverIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !/^[ \t]/.test(line)) break;
    const m = line.match(/^[ \t]+image:[ \t]*(\S.*?)[ \t]*$/i);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function hasCover(frontmatter) {
  const v = coverImagePath(frontmatter);
  return Boolean(v);
}

// 封面引用是否可解析：远程 URL 视为可解析；本地路径必须真实存在（相对 md 目录或仓库根）。
// 返回 true 表示「有封面且文件真实存在 / 远程」，false 表示「本地引用失效，需要重新生成」。
function coverResolvable(markdownPath, imagePath) {
  if (!imagePath) return false;
  const value = String(imagePath).trim().replace(/^["']|["']$/g, "");
  if (/^https?:\/\//i.test(value)) return true;
  const mdDir = path.dirname(markdownPath);
  for (const candidate of [path.resolve(mdDir, value), path.resolve(repositoryRoot, value)]) {
    try {
      if (statSync(candidate).isFile()) return true;
    } catch {
      // 不存在，继续尝试下一个候选路径
    }
  }
  return false;
}

function replaceOrInsertCover(raw, coverBlock) {
  const parsed = parseFrontmatter(raw);
  const { bom, text, newline, match } = parsed;
  if (!match) {
    return `${bom}---${newline}${coverBlock.join(newline)}${newline}---${newline}${newline}${text}`;
  }
  const lines = parsed.frontmatter.split(/\r?\n/);
  // 兼容两种 key 形态：标准 `cover:` 块，以及历史 bug 写出的裸 `cover` 块（无冒号），都要原地替换。
  const coverIndex = lines.findIndex((line) => /^cover[ \t]*:?[ \t]*$/i.test(line));
  if (coverIndex >= 0) {
    let endIndex = coverIndex + 1;
    while (endIndex < lines.length && (!lines[endIndex].trim() || /^[ \t]/.test(lines[endIndex]))) {
      endIndex += 1;
    }
    lines.splice(coverIndex, endIndex - coverIndex, ...coverBlock);
  } else {
    lines.unshift(...coverBlock);
  }
  const rebuiltFrontmatter = lines.join(newline);
  const rebuiltText = `${text.slice(0, match.index)}---${newline}${rebuiltFrontmatter}${newline}---${text.slice(match.index + match[0].length)}`;
  return `${bom}${rebuiltText}`;
}

function classify(title, collection) {
  const searchable = `${title} ${collection}`;
  return categoryRules.find(([, expression]) => expression.test(searchable))?.[0] ?? "general";
}

function cleanTitle(title, collection) {
  let result = title
    .replace(/^\s*[【\[].*?[】\]]\s*/, "")
    .replace(/\s*[【\[].*?[】\]]\s*$/, "")
    .replace(/[（(]\s*附(?:录)?[\s\S]*?[）)]\s*$/, "")
    .replace(/[＿_]{2,}/g, "：")
    .replace(/\s+/g, " ")
    .trim();
  const collectionPrefix = `${collection}：`;
  if (result.startsWith(collectionPrefix)) result = result.slice(collectionPrefix.length).trim();
  return result || title;
}

function characterWidth(character) {
  if (/\s/.test(character)) return 0.35;
  if (/^[\u0000-\u00ff]$/.test(character)) return 0.56;
  return 1;
}

function wrapTitle(title, maxUnits = 10.5, maxLines = 2) {
  const originalCharacters = Array.from(title);
  const capacity = maxUnits * maxLines;
  const characters = [];
  let totalUnits = 0;
  for (const character of originalCharacters) {
    const units = characterWidth(character);
    if (totalUnits + units > capacity - 1.1) break;
    characters.push(character);
    totalUnits += units;
  }
  if (characters.length < originalCharacters.length) {
    characters.push("…");
    totalUnits += 1;
  }
  const lineCount = Math.min(maxLines, Math.max(1, Math.ceil(totalUnits / maxUnits)));
  const lines = [];
  let start = 0;
  let remainingUnits = totalUnits;
  for (let lineIndex = 0; lineIndex < lineCount - 1; lineIndex += 1) {
    const remainingLines = lineCount - lineIndex;
    const targetUnits = remainingUnits / remainingLines;
    let end = start;
    let lineUnits = 0;
    while (end < characters.length - (remainingLines - 1)) {
      const nextUnits = characterWidth(characters[end]);
      if (lineUnits > 0 && lineUnits + nextUnits > targetUnits && lineUnits >= targetUnits * 0.88) break;
      lineUnits += nextUnits;
      end += 1;
    }
    while (end < characters.length && /^[，。！？、：；）》】”’…,.!?;:)]$/.test(characters[end])) {
      lineUnits += characterWidth(characters[end]);
      end += 1;
    }
    if (end - start > 1 && /^[（《【“‘([]$/.test(characters[end - 1])) {
      lineUnits -= characterWidth(characters[end - 1]);
      end -= 1;
    }
    lines.push(characters.slice(start, end).join("").trim());
    start = end;
    remainingUnits -= lineUnits;
  }
  lines.push(characters.slice(start).join("").trim());
  return lines.filter(Boolean);
}

function shortLabel(value, limit) {
  const characters = Array.from(String(value).trim());
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : String(value).trim();
}

// 单一、线性、极淡的图书馆母题：书脊 / 藏书票钢印 / 拱窗 / 编号牌。统一居中、低透明度，绝不拼贴照片或高饱和色块。
function motifSvg(category, accent) {
  const op = 0.16;
  const cx = width / 2;
  if (category === "language" || category === "history") {
    // 一排书脊
    const spines = [];
    const startX = cx - 150;
    const widths = [34, 26, 42, 30, 38, 24, 36];
    let x = startX;
    for (let i = 0; i < widths.length; i += 1) {
      const w = widths[i];
      const h = 150 - (i % 3) * 18;
      spines.push(`<rect x="${x}" y="${320 - h}" width="${w}" height="${h}" fill="none" stroke="${accent}" stroke-width="1.4" opacity="${op}"/>`);
      x += w + 10;
    }
    return spines.join("");
  }
  if (category === "mind" || category === "society") {
    // 藏书票钢印（双层圆 + 小字）
    return `<g opacity="${op}" stroke="${accent}" fill="none">
      <circle cx="${cx}" cy="250" r="78" stroke-width="1.6"/>
      <circle cx="${cx}" cy="250" r="66" stroke-width="0.9"/>
      <text x="${cx}" y="246" text-anchor="middle" font-family="'Noto Serif SC','Songti SC',serif" font-size="22" letter-spacing="6" fill="${accent}" stroke="none">藏 书 票</text>
      <text x="${cx}" y="272" text-anchor="middle" font-family="Georgia,serif" font-size="13" letter-spacing="3" fill="${accent}" stroke="none">EX LIBRIS</text>
    </g>`;
  }
  if (category === "nature" || category === "culture") {
    // 拱窗
    return `<g opacity="${op}" stroke="${accent}" fill="none">
      <path d="M${cx - 110} 400 L${cx - 110} 250 A110 110 0 0 1 ${cx + 110} 250 L${cx + 110} 400" stroke-width="1.8"/>
      <line x1="${cx}" y1="140" x2="${cx}" y2="400" stroke-width="0.9"/>
      <path d="M${cx - 110} 320 L${cx + 110} 320" stroke-width="0.9"/>
    </g>`;
  }
  // technology / general：编号牌
  return `<g opacity="${op}" stroke="${accent}" fill="none">
    <rect x="${cx - 120}" y="180" width="240" height="120" stroke-width="1.6"/>
    <line x1="${cx - 100}" y1="215" x2="${cx + 100}" y2="215" stroke-width="0.9"/>
    <line x1="${cx - 100}" y1="245" x2="${cx + 40}" y2="245" stroke-width="0.9"/>
    <line x1="${cx - 100}" y1="275" x2="${cx + 70}" y2="275" stroke-width="0.9"/>
  </g>`;
}

function coverSvg({ title, collection, category, seed }) {
  const palette = palettes[category];
  const displayTitle = cleanTitle(title, collection);
  const titleLines = wrapTitle(displayTitle);
  const titleSize = 54;
  const lineHeight = 76;
  const blockTop = 300;
  const archiveNumber = String(seed % 1000).padStart(3, "0");
  const escapedCollection = escapeXml(shortLabel(collection, 22).toUpperCase());
  const escapedCategory = escapeXml(palette.label);
  const ruleY = blockTop + (titleLines.length - 1) * lineHeight + 26;

  const lineText = titleLines
    .map((line, index) => `<text x="${width / 2}" y="${blockTop + index * lineHeight}" text-anchor="middle" class="title">${escapeXml(line)}</text>`)
    .join("");

  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <style>
        .sans { font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif; }
        .title { font-family: "Noto Serif SC", "Songti SC", "SimSun", serif; font-size: ${titleSize}px; font-weight: 700; fill: ${palette.ink}; letter-spacing: 2px; }
      </style>
      <rect width="${width}" height="${height}" fill="${palette.paper}"/>
      ${motifSvg(category, palette.accent)}
      <rect x="40" y="40" width="880" height="560" fill="none" stroke="${palette.line}" stroke-width="1.2" opacity="0.7"/>
      <rect x="54" y="54" width="852" height="532" fill="none" stroke="${palette.line}" stroke-width="0.7" opacity="0.45"/>
      <text x="${width / 2}" y="118" text-anchor="middle" class="sans" font-size="19" font-weight="700" fill="${palette.accent}" letter-spacing="5">${escapedCollection}</text>
      <line x1="${width / 2 - 40}" y1="138" x2="${width / 2 + 40}" y2="138" stroke="${palette.line}" stroke-width="1" opacity="0.6"/>
      ${lineText}
      <line x1="${width / 2 - 120}" y1="${ruleY}" x2="${width / 2 + 120}" y2="${ruleY}" stroke="${palette.ink}" stroke-width="1" opacity="0.55"/>
      <text x="${width / 2}" y="${ruleY + 34}" text-anchor="middle" class="sans" font-size="17" fill="${palette.line}" letter-spacing="3">${escapedCategory}</text>
      <text x="${width / 2}" y="566" text-anchor="middle" class="sans" font-size="16" fill="${palette.line}" letter-spacing="4">索 书 号 · Nº ${archiveNumber}</text>
    </svg>
  `);
}

async function walkMarkdown(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue;
      files.push(...await walkMarkdown(fullPath));
      continue;
    }
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") files.push(fullPath);
  }
  return files;
}

async function createCover(note) {
  const output960 = previewMode
    ? path.join(previewDirectory, `${note.category}-${note.seedHex.slice(0, 12)}.webp`)
    : note.output960;
  const output480 = note.output480;
  await mkdir(path.dirname(output960), { recursive: true });

  const svgBuffer = coverSvg(note);
  const outputInfo = await sharp(svgBuffer).webp({ quality: 72, effort: 6, smartSubsample: true }).toFile(output960);

  if (previewMode) {
    return {
      markdown: note.relativePath, title: note.title, collection: note.collection,
      category: note.category, seed: note.seedHex.slice(0, 12),
      cover960: toPosix(path.relative(repositoryRoot, output960)), bytes960: outputInfo.size, bytes480: 0,
    };
  }

  const smallInfo = await sharp(svgBuffer).resize(smallWidth, smallHeight, { fit: "cover" })
    .webp({ quality: 68, effort: 6, smartSubsample: true }).toFile(output480);

  // regenerate-all：文件名哈希不变，md 的 cover 路径已指向同名文件，无需改写 frontmatter。
  if (!note.rewriteFrontmatter) {
    return {
      markdown: note.relativePath, title: note.title, collection: note.collection,
      category: note.category, seed: note.seedHex.slice(0, 12),
      cover960: toPosix(path.relative(repositoryRoot, output960)),
      cover480: toPosix(path.relative(repositoryRoot, output480)),
      bytes960: outputInfo.size, bytes480: smallInfo.size,
    };
  }

  const coverBlock = [
    "cover:",
    `  image: ${yamlString(`文本附件/${path.basename(note.output960)}`)}`,
    "  actualRatio: '3:2'",
    `  pixelWidth: ${width}`,
    `  pixelHeight: ${height}`,
    "  displayWidth: 100",
    "  displayHeight: 320",
    "  positionX: 50",
    "  positionY: 50",
  ];
  const updatedMarkdown = replaceOrInsertCover(note.raw, coverBlock);
  await writeFile(note.markdownPath, updatedMarkdown, "utf8");
  return {
    markdown: note.relativePath, title: note.title, collection: note.collection,
    category: note.category, seed: note.seedHex.slice(0, 12),
    cover960: toPosix(path.relative(repositoryRoot, output960)),
    cover480: toPosix(path.relative(repositoryRoot, output480)),
    bytes960: outputInfo.size, bytes480: smallInfo.size,
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function main() {
  const markdownFiles = await walkMarkdown(repositoryRoot);
  const notes = [];

  for (const markdownPath of markdownFiles) {
    const relativePath = toPosix(path.relative(repositoryRoot, markdownPath));
    if (relativePath === "README.md" || relativePath === "智能体操作手册.md" || relativePath === "微信读书/微信读书Gallery.md") continue;

    const raw = await readFile(markdownPath, "utf8");
    const parsed = parseFrontmatter(raw);
    if (isDraft(parsed.frontmatter)) continue;

    const imagePath = coverImagePath(parsed.frontmatter);
    const usesGenerated = Boolean(imagePath && /(^|\/)generated-cover-/.test(imagePath));
    const hasCoverFlag = hasCover(parsed.frontmatter);

    if (regenerateAll) {
      // 只重生成当前引用 generated-cover 的已发布 md；无封面 md 走默认模式。
      if (!usesGenerated) continue;
    } else if (previewMode) {
      // preview：取若干代表 md（不依赖是否已有封面）。
    } else {
      // 有封面且（远程 URL / 本地文件真实存在）→ 跳过；本地引用失效视为缺封面，重新生成。
      if (hasCoverFlag && coverResolvable(markdownPath, imagePath)) continue;
    }

    const pathParts = relativePath.split("/");
    const collection = pathParts[0] || "未分类";
    const title = getYamlScalar(parsed.frontmatter, "title")
      ?? path.basename(markdownPath, path.extname(markdownPath)).trim();
    const seedHex = hashHex(relativePath);
    const seed = Number.parseInt(seedHex.slice(0, 8), 16) >>> 0;
    const baseName = `generated-cover-${seedHex.slice(0, 12)}`;
    const attachmentDirectory = path.join(path.dirname(markdownPath), "文本附件");

    notes.push({
      markdownPath, relativePath, raw, title, collection,
      category: classify(title, collection), seed, seedHex,
      attachmentDirectory,
      output960: path.join(attachmentDirectory, `${baseName}-960.webp`),
      output480: path.join(attachmentDirectory, `${baseName}-480.webp`),
      rewriteFrontmatter: !regenerateAll && !previewMode,
      missingReason: hasCoverFlag ? "cover-file-missing" : "no-cover",
      coverRef: imagePath,
    });
  }

  notes.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"));

  if (checkMode) {
    const missing = notes.filter((note) => note.missingReason === "no-cover");
    const broken = notes.filter((note) => note.missingReason === "cover-file-missing");
    console.log("=== 封面完整性检查（只报告，不写入）===");
    for (const note of missing) console.log(`[缺封面] ${note.relativePath}`);
    for (const note of broken) console.log(`[封面引用失效] ${note.relativePath} -> ${note.coverRef}`);
    if (notes.length) {
      console.log(`需处理 ${notes.length} 篇（缺封面 ${missing.length}，封面引用失效 ${broken.length}）；请运行本脚本（不带 --check）补全。`);
      process.exitCode = 1;
    } else {
      console.log("全部已发布 Markdown 封面完整（无缺封面、无失效引用）。");
    }
    return;
  }

  if (!notes.length) {
    console.log(regenerateAll ? "没有发现引用 generated-cover 的 Markdown。" : "没有发现缺封面的已发布 Markdown。");
    return;
  }

  const previewCategories = Object.keys(palettes);
  const workNotes = previewMode
    ? previewCategories.map((category) => notes.find((note) => note.category === category)).filter(Boolean)
    : notes;

  console.log(previewMode
    ? `开始生成 ${workNotes.length} 张风格预览（不修改 Markdown）……`
    : regenerateAll
      ? `开始全量重生成 ${workNotes.length} 篇图书馆风格封面（960 + 480 WebP）……`
      : `开始生成 ${workNotes.length} 篇缺失封面（960 + 480 WebP）……`);

  const records = await mapLimit(workNotes, concurrency, async (note, index) => {
    const record = await createCover(note);
    if ((index + 1) % 25 === 0 || index + 1 === workNotes.length) {
      console.log(`已完成 ${index + 1}/${workNotes.length}`);
    }
    return record;
  });

  if (previewMode) {
    console.log(`预览完成：${records.length} 张，目录 site/assets/cover-system/previews。`);
    return;
  }

  // 重写清单（regenerate-all 覆盖旧记录；默认模式按 markdown 合并）。
  const allRecords = records;
  const totalBytes = allRecords.reduce((sum, record) => sum + (record.bytes960 || 0) + (record.bytes480 || 0), 0);
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      generator: "site/scripts/generate-missing-covers.mjs",
      style: "library",
      strategy: "Pure SVG (warm paper, double frame, serif title, single faint linear library motif) -> sharp -> WebP.",
      count: allRecords.length,
      dimensions: { full: `${width}x${height}`, small: `${smallWidth}x${smallHeight}` },
      totalBytes,
      records: allRecords,
    }, null, 2)}\n`,
    "utf8",
  );

  console.log(`完成：${records.length} 篇，图片合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MiB。`);
  console.log(`清单：site/assets/cover-system/generated-cover-manifest.json`);
}

await main();
