// 读 parsecover-src/jobs.json，把每本封面转两档本地 WebP（按 frontmatter bookId 命名）。
// 输出 dims.json：{ bid: {w,h,ratio} }，供 md 更新脚本使用。
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';

const TMP = 'C:/Users/NewtN/下载/lectures-et-echos-main/site/.cover-test/parsecover-src';
const OUT = 'C:/Users/NewtN/下载/lectures-et-echos-main/微信读书/文本附件';
const jobs = JSON.parse(fs.readFileSync(path.join(TMP, 'jobs.json'), 'utf8'));

const ratioLabel = (w, h) => {
  const r = w / h;
  const cands = [['2:3', 2 / 3], ['3:4', 3 / 4], ['4:5', 4 / 5], ['1:1', 1], ['3:5', 3 / 5]];
  let best = cands[0];
  for (const c of cands) if (Math.abs(c[1] - r) < Math.abs(best[1] - r)) best = c;
  return best[0];
};

const dims = {};
for (const j of jobs) {
  if (!j.downloaded) continue;
  try {
    const meta = await sharp(j.src).metadata();
    if (!meta.width || !meta.height) throw new Error('invalid image');
    for (const h of [960, 480]) {
      const buf = await sharp(j.src)
        .resize({ height: h, width: null, withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
      fs.writeFileSync(path.join(OUT, `cover-${j.bid}-${h}.webp`), buf);
    }
    const m960 = await sharp(path.join(OUT, `cover-${j.bid}-960.webp`)).metadata();
    dims[j.bid] = { w: m960.width, h: m960.height, ratio: ratioLabel(meta.width, meta.height), srcW: meta.width, srcH: meta.height };
    console.log(`${j.file} -> ${m960.width}x${m960.height} ${dims[j.bid].ratio}`);
  } catch (e) {
    console.log(`!! ${j.file} 转换失败: ${e.message}`);
  }
}
fs.writeFileSync(path.join(TMP, 'dims.json'), JSON.stringify(dims, null, 1));
console.log('converted:', Object.keys(dims).length);
