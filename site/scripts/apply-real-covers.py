# -*- coding: utf-8 -*-
"""把 7 本书的 frontmatter cover 与元数据 callout 图改为本地真封面 WebP（逐行版，安全）。"""
import os, re

ROOT = r'C:\Users\NewtN\下载\lectures-et-echos-main\微信读书'

# 真实 frontmatter bookId -> (w960, h960, ratio)
BOOKS = {
    'CB_8v5Az5AyXAEZ76V75AEJv735': (306, 396, '3:4'),
    'CB_2YC7c07ap2Ow6zq71574HCbY': (500, 709, '2:3'),
    'CB_H177IH7GS2Ow6zq71526A9Qp': (368, 500, '3:4'),
    'CB_3HTB0K1eS7sG5BF6xPDEY9gW': (686, 960, '3:4'),
    'CB_5P58rn8v29N46yQ6wwB3GELY': (666, 960, '2:3'),
    'CB_11t8UL8SYAlD76775A69PDoQ': (680, 960, '3:4'),
    'CB_6jL8CB8C62bJ6vh6ww9u996L': (800, 800, '1:1'),
}

def process(path, bid, w, h, ratio):
    raw = open(path, 'rb').read()
    nl = '\r\n' if b'\r\n' in raw else '\n'
    text = raw.decode('utf-8')
    assert text.startswith('---'), 'frontmatter 起始标记缺失'
    lines = text.split(nl)
    # 找第二个 ---（frontmatter 结束）
    end = next(i for i in range(1, len(lines)) if lines[i].strip() == '---')
    # 1) 定位 cover 行
    ci = next(i for i in range(1, end) if lines[i].startswith('cover:'))
    # 校验：对象块或字符串单行
    after = lines[ci][len('cover:'):].strip()
    block = [
        'cover:',
        f"  image: '文本附件/cover-{bid}-960.webp'",
        f"  actualRatio: '{ratio}'",
        f'  pixelWidth: {w}',
        f'  pixelHeight: {h}',
        '  displayWidth: 100',
        '  displayHeight: 320',
        '  positionX: 50',
        '  positionY: 50',
    ]
    if after:
        # 字符串形式：只替换第 ci 行
        new_lines = lines[:ci] + block + lines[ci + 1:]
    else:
        # 对象形式：吃掉后续缩进行（到首个非缩进行）
        j = ci + 1
        while j < end and (lines[j].startswith('  ') or lines[j].strip() == ''):
            j += 1
        new_lines = lines[:ci] + block + lines[j:]
    # 重新定位 frontmatter 结束（block 长度变化）
    new_end = next(i for i in range(1, len(new_lines)) if new_lines[i].strip() == '---')
    # 2) 正文第一处 > - ![...](...) 的 callout 封面行，仅替换链接
    callout_done = False
    for i in range(new_end + 1, len(new_lines)):
        if new_lines[i].startswith('> - !['):
            new_lines[i] = re.sub(
                r'(\]\()[^)]*(\))',
                lambda mm: mm.group(1) + f'文本附件/cover-{bid}-960.webp' + mm.group(2),
                new_lines[i], count=1)
            callout_done = True
            break
    assert callout_done, 'callout 封面行未找到'
    out = nl.join(new_lines)
    open(path, 'wb').write(out.encode('utf-8'))
    return nl

changed = 0
for fn in sorted(os.listdir(ROOT)):
    if not fn.endswith('.md'):
        continue
    path = os.path.join(ROOT, fn)
    text = open(path, encoding='utf-8').read()
    if not text.startswith('---'):
        continue
    m = re.search(r'^bookId:\s*["\']?([^"\'\r\n]+)', text.split('---', 2)[1], re.M)
    if not m:
        continue
    bid = m.group(1).strip().strip('"').strip("'")
    if bid not in BOOKS:
        continue
    w, h, ratio = BOOKS[bid]
    nl = process(path, bid, w, h, ratio)
    print(f'OK [{nl!r}] {fn}')
    changed += 1
print('changed:', changed)
