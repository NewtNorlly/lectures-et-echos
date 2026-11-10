# -*- coding: utf-8 -*-
"""把「我的书架」里仍是远程 URL 的封面本地化为 WebP（960 / 480 两档）。

背景：封面走微信读书 CDN 时，首屏常被单张 3–8s 的慢图拖住 LCP，且偶发抽风。
本脚本按 frontmatter bookId 生成：

    微信读书/文本附件/cover-<bookId>-960.webp
    微信读书/文本附件/cover-<bookId>-480.webp

并把 md 的 cover 块与「元数据」callout 图片行改成对应的本地路径。
已有 cover-<bookId>-960.webp 的书会跳过（幂等）；新书同步后若封面仍是远程，再跑一次即可。

用法：
    py -3 -X utf8 site\\scripts\\localize-book-covers.py [--only=关键词] [--workers=6]

约定：
- 逐行改 frontmatter，不跨字段正则；写后自校验；LF；
- 不放大：源图小于目标高度时保留原尺寸；
- 下载失败的书保留远程封面，并在末尾列出，需重跑。
"""
import argparse
import io
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
LIB = os.path.join(ROOT, '微信读书')
ATT = os.path.join(LIB, '文本附件')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/143.0 Safari/537.36')
os.makedirs(ATT, exist_ok=True)


def split_fm(text):
    m = re.match(r'^---\n(.*?)\n---\n?(.*)$', text, re.S)
    return (m.group(1), m.group(2)) if m else (None, None)


def get_books(only):
    rows = []
    for fn in sorted(os.listdir(LIB)):
        if not fn.endswith('.md') or fn == '微信读书Gallery.md':
            continue
        path = os.path.join(LIB, fn)
        text = open(path, encoding='utf-8').read()
        fm, body = split_fm(text)
        if fm is None or 'weread-highlights-reviews' not in fm:
            continue
        bid = re.search(r'^bookId:\s*"?(.*?)"?\s*$', fm, re.M).group(1)
        title = re.search(r'^title:\s*"?(.*?)"?\s*$', fm, re.M).group(1)
        if only and only not in fn and only not in bid:
            continue
        cm = re.search(r'^cover:\s*(.*)$', fm, re.M)
        if not cm:
            continue
        rest = cm.group(1).strip()
        url = ''
        if rest:
            val = rest.strip('"\'')
            if not val.startswith('http'):
                continue  # 已是本地封面
            url = val
        else:
            im = re.search(r'^[ \t]+image:\s*[\'"](.*?)[\'"]', fm, re.M)
            if not im:
                continue
            url = im.group(1)
            if not url.startswith('http'):
                continue
        if os.path.isfile(os.path.join(ATT, 'cover-%s-960.webp' % bid)):
            continue
        rows.append({'file': fn, 'path': path, 'bookId': bid, 'title': title, 'url': url})
    return rows


def fetch(url):
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': 'https://weread.qq.com/'})
            with urllib.request.urlopen(req, timeout=35) as r:
                data = r.read()
            if data:
                return data
        except Exception as exc:
            last = exc
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(str(last))


def build_images(data, bid):
    im = Image.open(io.BytesIO(data))
    im.load()
    im = im.convert('RGBA') if im.mode in ('RGBA', 'LA', 'P') else im.convert('RGB')
    w, h = im.size
    out = {}
    for target_h, quality in ((960, 72), (480, 68)):
        nh = min(target_h, h)
        nw = max(1, round(w * nh / h))
        resized = im.resize((nw, nh), Image.LANCZOS)
        path = os.path.join(ATT, 'cover-%s-%d.webp' % (bid, target_h))
        resized.save(path, 'WEBP', quality=quality, method=6)
        out[target_h] = (path, resized.size)
    return out


def cover_block(bid, sizes):
    w960, h960 = sizes[960][1]
    ratio = w960 / h960
    actual = '2:3' if ratio <= 0.7 else ('3:4' if ratio <= 0.78 else '4:5')
    return [
        'cover:',
        "  image: '文本附件/cover-%s-960.webp'" % bid,
        "  actualRatio: '%s'" % actual,
        '  pixelWidth: %d' % w960,
        '  pixelHeight: %d' % h960,
        '  displayWidth: 100',
        '  displayHeight: 320',
        '  positionX: 50',
        '  positionY: 50',
    ]


def rewrite_md(row, sizes):
    text = open(row['path'], encoding='utf-8').read()
    fm, body = split_fm(text)
    lines = fm.split('\n')
    start = next((i for i, line in enumerate(lines) if re.match(r'^cover:\s*', line)), None)
    if start is None:
        raise RuntimeError('cover key not found')
    end = start + 1
    while end < len(lines) and re.match(r'^[ \t]+', lines[end]):
        end += 1
    new_fm = lines[:start] + cover_block(row['bookId'], sizes) + lines[end:]

    body_lines = body.split('\n')
    local_img = '文本附件/cover-%s-960.webp' % row['bookId']
    replaced = False
    for i, line in enumerate(body_lines):
        if re.match(r'^> - !\[.*?\]\(.*?\)\s*$', line):
            body_lines[i] = '> - ![%s|200](%s)' % (row['title'], local_img)
            replaced = True
            break
    if not replaced:
        for i, line in enumerate(body_lines):
            if line.startswith('> [!abstract]'):
                body_lines.insert(i + 2, '> - ![%s|200](%s)' % (row['title'], local_img))
                replaced = True
                break
    if not replaced:
        raise RuntimeError('cover image line not found')

    new_text = '---\n' + '\n'.join(new_fm) + '\n---\n' + '\n'.join(body_lines)
    if not new_text.endswith('\n'):
        new_text += '\n'
    open(row['path'], 'w', encoding='utf-8', newline='\n').write(new_text)

    fm2, body2 = split_fm(open(row['path'], encoding='utf-8').read())
    assert ("image: '文本附件/cover-%s-960.webp'" % row['bookId']) in fm2, 'frontmatter cover missing'
    assert local_img in body2, 'callout cover missing'
    assert os.path.isfile(os.path.join(ATT, 'cover-%s-960.webp' % row['bookId']))
    assert os.path.isfile(os.path.join(ATT, 'cover-%s-480.webp' % row['bookId']))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='', help='只处理文件名或 bookId 含该关键词的书')
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()
    rows = get_books(args.only)
    print('待本地化远程封面：%d 本' % len(rows))
    if not rows:
        return
    results, failures = {}, []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(fetch, row['url']): row for row in rows}
        for fut in as_completed(futures):
            row = futures[fut]
            try:
                results[row['bookId']] = (row, build_images(fut.result(), row['bookId']))
            except Exception as exc:
                failures.append((row['file'], row['url'], 'download: ' + str(exc)[:100]))
    print('下载成功 %d / 失败 %d' % (len(results), len(failures)))
    done = 0
    for bid, (row, sizes) in results.items():
        try:
            rewrite_md(row, sizes)
            done += 1
        except Exception as exc:
            failures.append((row['file'], row['url'], 'rewrite: ' + str(exc)[:100]))
            for p, _ in sizes.values():
                try:
                    os.remove(p)
                except OSError:
                    pass
    print('md 改写完成：%d 本；失败合计 %d' % (done, len(failures)))
    for f in failures:
        print('  FAIL', f)
    if failures:
        sys.exit(1)


if __name__ == '__main__':
    main()
