# -*- coding: utf-8 -*-
"""生成站点用的「思源宋体 CN」子集字体（WOFF2）。

背景：原始 SourceHanSerifCN-Regular.otf 有 12.8MB，线上无压缩传输约 9.4MB，
是首页最大的加载负担。本站实际用字有限，子集化后体积可降到约 1/7，字形不变。

字符集 = 全站 md 正文 ∪ site/src 源文件 ∪ GB2312 全量 ∪ Latin-1 ∪ 常用标点/符号。
- 包含 GB2312，保证日后新增的常见中文内容不会缺字；
- 仍未覆盖的生僻字会回退系统衬线字体，不影响页面可用。

用法（内容大改后重跑，然后提交生成的 woff2）：
    py -3 -X utf8 site\\scripts\\build-font-subset.py

源字体：site/assets/fonts/SourceHanSerifCN-Regular.otf
输出：  site/public/fonts/SourceHanSerifCN-subset.woff2
"""
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
ROOT = os.path.dirname(SITE)
SOURCE_FONT = os.path.join(SITE, 'assets', 'fonts', 'SourceHanSerifCN-Regular.otf')
OUTPUT_FONT = os.path.join(SITE, 'public', 'fonts', 'SourceHanSerifCN-subset.woff2')
EXCLUDE_DIRS = {'site', 'AI 指令', '.git', '.github', '.obsidian', '.makemd', '.space', '.trash',
                'node_modules', '__pycache__', 'footer-artwork', '微信读书'}
SKIP_FILES = {'README.md', '智能体操作手册.md'}


def collect_chars():
    chars = set(chr(c) for c in range(32, 127))           # ASCII
    chars.update(chr(c) for c in range(0xA0, 0x100))      # Latin-1（É/é 等）
    for a, b in [(0x2000, 0x206F), (0x2190, 0x21FF), (0x2460, 0x24FF),
                 (0x25A0, 0x25FF), (0x3000, 0x303F), (0xFF00, 0xFFEF)]:
        chars.update(chr(c) for c in range(a, b + 1))
    for lead in range(0xA1, 0xF8):                        # GB2312 全量
        for trail in range(0xA1, 0xFF):
            try:
                chars.add(bytes([lead, trail]).decode('gb2312'))
            except Exception:
                pass

    for name in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, name)
        if os.path.isdir(p):
            if name in EXCLUDE_DIRS or name.startswith('.'):
                continue
            for dirpath, dirnames, filenames in os.walk(p):
                dirnames[:] = [d for d in dirnames
                               if d not in ('node_modules', '__pycache__', '.git') and not d.startswith('.')]
                if os.path.basename(dirpath) == '文本附件':
                    continue
                for fn in filenames:
                    if fn.endswith('.md'):
                        chars.update(open(os.path.join(dirpath, fn), encoding='utf-8', errors='ignore').read())
        elif name.endswith('.md') and name not in SKIP_FILES:
            chars.update(open(p, encoding='utf-8', errors='ignore').read())
    for dirpath, dirnames, filenames in os.walk(os.path.join(SITE, 'src')):
        for fn in filenames:
            if fn.endswith(('.astro', '.ts', '.css', '.mjs')):
                chars.update(open(os.path.join(dirpath, fn), encoding='utf-8', errors='ignore').read())
    return chars


def main():
    if not os.path.isfile(SOURCE_FONT):
        print('源字体不存在：%s' % SOURCE_FONT)
        sys.exit(2)
    chars = collect_chars()
    text_file = os.path.join(ROOT, '.font-subset-chars.txt')
    with open(text_file, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(''.join(sorted(chars)))

    options = subset.Options()
    options.flavor = 'woff2'
    options.desubroutinize = False
    options.hinting = False
    options.layout_features = ['kern', 'liga']
    options.drop_tables += ['DSIG']
    font = subset.load_font(SOURCE_FONT, options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=''.join(sorted(chars)))
    subsetter.subset(font)
    os.makedirs(os.path.dirname(OUTPUT_FONT), exist_ok=True)
    subset.save_font(font, OUTPUT_FONT, options)

    # 核对字符覆盖
    out = TTFont(OUTPUT_FONT)
    cmap = out.getBestCmap() or {}
    missing = [c for c in chars if ord(c) not in cmap and not c.isspace()]
    print('字符集 %d 个（汉字 %d）' % (len(chars), sum(1 for c in chars if '\u4e00' <= c <= '\u9fff')))
    print('源字体 %.2fMB → 子集 %.2fMB（%.0f%%）'
          % (os.path.getsize(SOURCE_FONT) / 1048576, os.path.getsize(OUTPUT_FONT) / 1048576,
             os.path.getsize(OUTPUT_FONT) * 100.0 / os.path.getsize(SOURCE_FONT)))
    if missing:
        print('字体本身不含的字符 %d 个（浏览器会回退系统字体）：%s'
              % (len(missing), ''.join(missing[:40])))
    else:
        print('字符覆盖：全部命中')
    os.remove(text_file)


if __name__ == '__main__':
    main()
