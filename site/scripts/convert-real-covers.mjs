// 一次性脚本：把 7 本书的真封面源图转为两档 WebP，写入 微信读书/文本附件/。
// 规格遵循手册 §8.4：竖版书封高 960 / 高 480，q72，保留比例。
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';

const CAND = path.resolve('C:/Users/NewtN/下载/lectures-et-echos-main/site/.cover-test/candidates');
const OUT = path.resolve('C:/Users/NewtN/下载/lectures-et-echos-main/微信读书/文本附件');

const BOOKS = [
  { bid: 'CB_8v5Az5AyXAEZ76V75AEJv735', src: '哈佛经济学家推理系列-parsecover.jpg', name: '哈佛经济学家推理系列' },
  { bid: 'CB_9M0GsaGtdH2c6mk6ke7E6DPS', src: '江村经济-parsecover.jpg', name: '江村经济' },
  { bid: 'CB_DIVDd9Dcl92t6yt6x6Bgv9Jx', src: '强社会与弱国家-source.jpg', name: '强社会与弱国家' },
  { bid: 'CB_CRHARPAPU2le6d86ca', src: '国家为什么会失败-parsecover.jpg', name: '国家为什么会失败' },
  { bid: 'CB_5P58rn8v29N46yQ6wwB3GELY', src: '社会学第5版吉登斯-source.jpg', name: '社会学第5版吉登斯' },
  { bid: 'CB_11t8UL8SYAlD76775A69PDoQ', src: '胭脂与焉支-source.jpg', name: '胭脂与焉支' },
  { bid: 'CB_6jL8CB8C62bJ6vh6ww9u996L', src: '党政机关公文格式-source.jpg', name: '党政机关公文格式' },
];

const ratioLabel = (w, h) => {
  const r = w / h;
  const candidates = [
    ['2:3', 2 / 3], ['3:4', 3 / 4], ['4:5', 4 / 5], ['1:1', 1],
    ['3:5', 3 / 5], ['1:2', 1 / 2],
  ];
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c[1] - r) < Math.abs(best[1] - r)) best = c;
  }
  return best[0];
};

for (const b of BOOKS) {
  const srcPath = path.join(CAND, b.src);
  const meta = await sharp(srcPath).metadata();
  for (const h of [960, 480]) {
    const out = path.join(OUT, `cover-${b.bid}-${h}.webp`);
    const buf = await sharp(srcPath)
      .resize({ height: h, width: null, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    fs.writeFileSync(out, buf);
    const m = await sharp(out).metadata();
    if (h === 960) {
      b.w960 = m.width;
      b.h960 = m.height;
      b.ratio = ratioLabel(meta.width, meta.height);
      b.srcW = meta.width;
      b.srcH = meta.height;
    }
    console.log(`${b.name} -> ${path.basename(out)} ${m.width}x${m.height} ${(buf.length / 1024).toFixed(1)}KB`);
  }
}
console.log(JSON.stringify(BOOKS.map(({ name, bid, w960, h960, ratio, srcW, srcH }) =>
  ({ name, bid, w960, h960, ratio, srcW, srcH })), null, 1));
