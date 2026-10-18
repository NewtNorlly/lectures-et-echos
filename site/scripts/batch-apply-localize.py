# -*- coding: utf-8 -*-
"""按 dims.json 把 parsecover 书的 md frontmatter/callout 封面换成本地 WebP（逐行安全版）。"""
import os, re, json

ROOT = r'C:\Users\NewtN\下载\lectures-et-echos-main\微信读书'
TMP = r'C:\Users\NewtN\下载\lectures-et-echos-main\site\.cover-test\parsecover-src'
jobs = json.load(open(os.path.join(TMP, 'jobs.json'), encoding='utf-8'))
dims = json.load(open(os.path.join(TMP, 'dims.json'), encoding='utf-8'))

changed = 0
for j in jobs:
    bid = j['bid']
    if bid not in dims:
        continue
    p = os.path.join(ROOT, j['file'])
    raw = open(p, 'rb').read()
    nl = '\r\n' if b'\r\n' in raw else '\n'
    text = raw.decode('utf-8')
    lines = text.split(nl)
    end = next(i for i in range(1, len(lines)) if lines[i].strip() == '---')
    ci = next(i for i in range(1, end) if lines[i].startswith('cover:'))
    after = lines[ci][len('cover:'):].strip()
    d = dims[bid]
    block = [
        'cover:',
        f"  image: '文本附件/cover-{bid}-960.webp'",
        f"  actualRatio: '{d['ratio']}'",
        f"  pixelWidth: {d['w']}",
        f"  pixelHeight: {d['h']}",
        '  displayWidth: 100',
        '  displayHeight: 320',
        '  positionX: 50',
        '  positionY: 50',
    ]
    if after:
        new_lines = lines[:ci] + block + lines[ci + 1:]
    else:
        k = ci + 1
        while k < end and (lines[k].startswith('  ') or lines[k].strip() == ''):
            k += 1
        new_lines = lines[:ci] + block + lines[k:]
    new_end = next(i for i in range(1, len(new_lines)) if new_lines[i].strip() == '---')
    done = False
    for i in range(new_end + 1, len(new_lines)):
        if new_lines[i].startswith('> - !['):
            new_lines[i] = re.sub(
                r'(\]\()[^)]*(\))',
                lambda mm: mm.group(1) + f'文本附件/cover-{bid}-960.webp' + mm.group(2),
                new_lines[i], count=1)
            done = True
            break
    assert done, f'callout 未找到: {j["file"]}'
    open(p, 'wb').write(nl.join(new_lines).encode('utf-8'))
    print('OK', j['file'], f"{d['w']}x{d['h']} {d['ratio']}")
    changed += 1
print('changed:', changed)
