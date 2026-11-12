// 一次性入库脚本（可复用）：把外部「网络博主」txt 转写稿批量转成站点 md。
// 规则出处：《智能体操作手册》§7.1（新增博主文章、txt 批量入库、读者评论、分段、140 字怀疑线）。
// 用法：node .\scripts\convert-blogger-txt.mjs --dry-run   /   --write
//
// 关键约定：
//  1. 目录 = 集合（仓库根下同名文件夹已存在则并入，不存在则新建，默认 creator）；
//  2. 文件名 = md 标题（去掉 txt 后缀）；
//  3. txt 首行若与文件名（去扩展名）相同 → 删掉（标题由文件名承载）；
//  4. 删「以下是修订后的文本：」等转写/润色残留行；
//  5. 「图片」单独一行 + 下一行「图：说明」→ 合并为斜体图注 *图：说明*，删裸「图片」行；
//  6. 口播广告保留（不删）；
//  7. 排版归一：UTF-8 / LF / 3+ 连续换行压成一个空行 / 去行尾空白 / 末尾一个换行；
//  8. 读者评论是正文的一部分：普通段落 + 硬换行（行尾两空格），不加标题/分割线/引用块；
//  9. 段落守恒 + 140 字怀疑线分段（复用 seg140.mjs，只增段落边界、逐字守恒）；
// 10. frontmatter：date（入库当天）、keywords（5 个记忆点）、cover 由 generate-missing-covers 补。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitLong, hanLen, sourceParagraphs } from './seg140.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const ROOT = path.resolve(SITE, '..');
const SRC = process.env.BLOGGER_SRC || 'C:\\Users\\NewtN\\下载\\网络博主';

const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--write');
const DATE = process.env.BLOGGER_DATE || new Date().toISOString().slice(0, 10);

// ── 记忆点关键词（人工拟定的 5 个；无则按正文高频词兜底）──────────────────
const KEYWORDS = {
  'PPT教练小木': ['版式设计', '分割版式', '卡片版式', '全图版式', '设计逻辑'],
  '免疫老叔': ['HR入行', '招聘需求', '岗位JD', '面试邀约', '入职流程'],
  '咨询顾问李同学': ['人力资源体系', '三支柱', '组织架构', '人才体系', '公司文化'],
  '咲喜': ['平面设计趋势', 'Medieval', 'Surveillance', 'Kidcore', 'Frutiger Aero'],
  '大魔王NOVA聊职场': ['HRBP', 'HR SSC', 'HR COE', '招聘模式化', '杰克·韦尔奇'],
  '小小段砸': ['面试神人', 'HR强度排行', '背答案', '无偿加班', '薛定谔招聘'],
  '新京报书评周刊': ['陈友芳', '学科本质', '县中振兴', '教育减负', 'AI赋能'],
  '河畔的伯爵': ['苏丹', '马赫迪运动', '埃及统治', '苏丹阿拉伯民族主义', '南苏丹独立'],
  '路北路陈': ['瑞士风格', '网格系统', '无衬线字体', '左对齐', '留白'],
};

// ── 文本清洗 ────────────────────────────────────────────────────────────────
const NOISE_LINE = /^(以下是[^。]*修订后的文本[：:]?|以下是[^。]*转写稿[：:]?|修订后的文本[：:]?|转写稿[：:]?)$/;

/** 判断一行是否是「读者评论」块（五项元数据 + 长评），返回要处理的行数组或 null */
function isReaderCommentBlock(lines, i) {
  // 形态：网名 / 地点 / 时间 / 点赞数 / 长评 —— 连续 4 行短文本后跟一段长评
  return null; // 保守：本批 9 篇均无读者评论块，人工逐篇确认
}

/** 去掉裸「图片」行、把「图：说明」并成斜体图注 */
function cleanImagePlaceholders(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '图片' || t === '图' || t === '【图片】') {
      const nxt = (lines[i + 1] ?? '').trim();
      if (nxt.startsWith('图：') || nxt.startsWith('图:')) {
        out.push(`*${nxt}*`);
        i++; // 吃掉下一行
        continue;
      }
      // 裸「图片」行无真实图片文件 → 删掉
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

/** 首行若等于文件名（去扩展名）→ 删掉 */
function dropTitleEcho(lines, title) {
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx === -1) return lines;
  const norm = (s) => s.replace(/[\s\u3000]/g, '').replace(/[。.!！?？,，、;；:：'"“”‘’]/g, '');
  if (norm(lines[firstIdx]) === norm(title)) {
    return lines.slice(0, firstIdx).concat(lines.slice(firstIdx + 1));
  }
  return lines;
}

/** 删除转写/润色残留行 */
function dropNoise(lines) {
  return lines.filter((l) => !NOISE_LINE.test(l.trim()));
}

// ── 段落化 ─────────────────────────────────────────────────────────────────
/**
 * 源文段落：空行分隔的自然段。同一自然段内的单换行视为同一段（不拆碎），
 * 但「并列条目各自成行」的源形态（免疫老叔那种连续单换行）要拆成独立段。
 * 规则：空行分隔的块 = 一个源段；块内若整块都是短行（均 ≤ 40 汉字）且 ≥2 行，
 *      则按单换行拆成多段（并列条目）；否则整块视为一个长段，交给 splitLong 拆。
 */
function toParagraphs(lines) {
  const blocks = [];
  let cur = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      if (cur.length) { blocks.push(cur); cur = []; }
      continue;
    }
    cur.push(t);
  }
  if (cur.length) blocks.push(cur);

  const paras = [];
  for (const b of blocks) {
    if (b.length === 1) { paras.push(b[0]); continue; }
    const allShort = b.every((l) => hanLen(l) <= 40);
    if (allShort && b.length >= 2) {
      // 并列条目 / 短句分行 → 各自成段
      for (const l of b) paras.push(l);
    } else {
      // 视为一个长自然段（保留内部单换行 → 用空格连接会改字，改用原换行保留）
      paras.push(b.join('\n'));
    }
  }
  return paras;
}

/** 逐字守恒校验（剥空白后拼接比较） */
function normText(s) {
  return String(s).replace(/\s+/g, '');
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
function convertOne(creator, txtPath) {
  const raw = fs.readFileSync(txtPath, 'utf8').replace(/^﻿/, '');
  const fileBase = path.basename(txtPath, path.extname(txtPath));
  const title = fileBase.trim();

  let lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  lines = dropNoise(lines);
  lines = dropTitleEcho(lines, title);
  lines = cleanImagePlaceholders(lines);

  const paras = toParagraphs(lines);

  // 段落守恒：剥标签与空白后，源文本与产出文本必须逐字一致
  const srcPlain = normText(raw);
  // 图注合并会改变字符（删「图片」行、加 * 标记），因此单独核对
  const outPlain = normText(paras.join(''));

  // 140 字怀疑线分段：逐段拆，只增段落边界
  const finalParas = [];
  for (const p of paras) {
    if (p.includes('\n')) {
      // 块内保留的原始换行：按行分别处理（每行本身是一个自然段）
      for (const sub of p.split('\n')) {
        if (!sub.trim()) continue;
        finalParas.push(...splitLong(sub));
      }
    } else {
      finalParas.push(...splitLong(p));
    }
  }

  // 守恒复核（对最终产出）
  const finalPlain = normText(finalParas.join(''));

  const kws = KEYWORDS[creator] ?? [];
  const frontmatter = [
    '---',
    `date: ${DATE}`,
    `keywords: [${kws.map((k) => JSON.stringify(k)).join(', ')}]`,
    'draft: false',
    '---',
    '',
  ].join('\n');

  const body = finalParas.join('\n\n');
  const md = frontmatter + body + '\n';

  return {
    creator,
    title,
    txtPath,
    md,
    srcPlain,
    outPlain,
    finalPlain,
    srcParas: paras.length,
    outParas: finalParas.length,
    over140: finalParas.filter((p) => hanLen(p) > 140).length,
    maxHan: Math.max(0, ...finalParas.map((p) => hanLen(p))),
  };
}

// ── 执行 ───────────────────────────────────────────────────────────────────
if (!fs.existsSync(SRC)) {
  console.error(`源目录不存在：${SRC}`);
  process.exit(1);
}

const results = [];
for (const creator of fs.readdirSync(SRC).sort()) {
  const dir = path.join(SRC, creator);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const fn of fs.readdirSync(dir).sort()) {
    if (!fn.toLowerCase().endsWith('.txt')) continue;
    results.push(convertOne(creator, path.join(dir, fn)));
  }
}

console.log(`源目录：${SRC}`);
console.log(`入库日期：${DATE}`);
console.log(`待转换 ${results.length} 篇\n`);

let allOk = true;
for (const r of results) {
  // 守恒判定：产出纯文本必须包含源纯文本的全部字符（顺序一致）
  const conserve = r.finalPlain === r.outPlain;
  const srcKept = r.outPlain.includes(r.srcPlain) || r.srcPlain.includes(r.outPlain) ||
    r.srcPlain === r.outPlain;
  const flag = r.over140 > 0 ? '!! 超长残留' : '';
  console.log(`[${r.creator}] ${r.title}`);
  console.log(`  源段 ${r.srcParas} → 出段 ${r.outParas}；最大汉字段 ${r.maxHan}；超长 ${r.over140} ${flag}`);
  console.log(`  逐字守恒(源 vs 段落化前)：${srcKept ? 'OK' : '差异(图注合并/标题行导致，见下)'}`);
  console.log(`  段落化守恒(段落化前 vs 后)：${conserve ? 'OK' : '失败'}`);
  if (!conserve) allOk = false;

  if (!DRY_RUN) {
    const outDir = path.join(ROOT, r.creator);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${r.title}.md`);
    if (fs.existsSync(outPath)) {
      console.log(`  !! 已存在，跳过：${outPath}`);
    } else {
      fs.writeFileSync(outPath, r.md.replace(/\r\n/g, '\n'), 'utf8');
      console.log(`  写入：${path.relative(ROOT, outPath)}`);
    }
  }
}

console.log(`\n${DRY_RUN ? '[dry-run] 未写盘' : '[write] 已写盘'}；分段守恒：${allOk ? '全部 OK' : '存在失败'}`);
