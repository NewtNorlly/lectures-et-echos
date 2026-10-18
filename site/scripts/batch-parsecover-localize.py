# -*- coding: utf-8 -*-
"""把剩余所有 parsecover 远程封面下载并转本地 WebP，更新 frontmatter 与 callout。
- 文件名用 frontmatter 真实 bookId（parsecover URL 里的 ID 可能不同）
- 下载带 UA + 多次重试；sharp 校验是有效图片
"""
import os, re, json, time, hashlib, urllib.request, subprocess, sys

ROOT = r'C:\Users\NewtN\下载\lectures-et-echos-main\微信读书'
AD = os.path.join(ROOT, '文本附件')
TMP = r'C:\Users\NewtN\下载\lectures-et-echos-main\site\.cover-test\parsecover-src'
os.makedirs(TMP, exist_ok=True)
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

# 1) 收集所有 parsecover 书
jobs = []
for fn in sorted(os.listdir(ROOT)):
    if not fn.endswith('.md'):
        continue
    p = os.path.join(ROOT, fn)
    txt = open(p, encoding='utf-8').read()
    if not txt.startswith('---'):
        continue
    fm = txt.split('---', 2)[1]
    if 'parsecover' not in fm:
        continue
    m = re.search(r'^bookId:\s*["\']?([^"\'\r\n]+)', fm, re.M)
    bid = m.group(1).strip().strip('"').strip("'") if m else None
    cm = re.search(r'^cover:\s*["\']([^"\']*parsecover[^"\']*)["\']', fm, re.M)
    url = cm.group(1) if cm else None
    if bid and url:
        jobs.append({'file': fn, 'bid': bid, 'url': url})
print('parsecover 待处理:', len(jobs))

# 2) 下载
def download(url, dest, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': 'https://weread.qq.com/'})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if len(data) < 2000:
                raise RuntimeError(f'文件过小 {len(data)}B')
            open(dest, 'wb').write(data)
            return len(data)
        except Exception as e:
            print('   retry', i + 1, repr(e)[:100])
            time.sleep(2 + i * 2)
    return None

results = []
for j in jobs:
    dest = os.path.join(TMP, j['bid'] + '.jpg')
    if os.path.exists(dest) and os.path.getsize(dest) > 2000:
        size = os.path.getsize(dest)
        print('cache', j['bid'], size)
    else:
        size = download(j['url'], dest)
    j['src'] = dest
    j['downloaded'] = size
    results.append(j)

json.dump(results, open(os.path.join(TMP, 'jobs.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('下载完成:', sum(1 for r in results if r['downloaded']), '/', len(results))
for r in results:
    if not r['downloaded']:
        print('  !! 下载失败:', r['file'], r['url'])
