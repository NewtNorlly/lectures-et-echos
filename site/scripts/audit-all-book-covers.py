# -*- coding: utf-8 -*-
"""全库审计微信读书每本书的封面类型，找出一切非真封面：
模板封面 / parsecover 热链 / 默认占位图 / 无封面 / 本地文件缺失。"""
import os, re, json, sys

ROOT = r'C:\Users\NewtN\下载\lectures-et-echos-main\微信读书'

def parse_frontmatter(txt):
    if txt.startswith('---'):
        parts = txt.split('---', 2)
        if len(parts) >= 3:
            return parts[1]
    return ''

def parse_cover(fm):
    # 字符串形式
    m = re.search(r'^cover:\s*["\']([^"\']+)["\']\s*$', fm, re.M)
    if m:
        return ('string', m.group(1))
    # 对象块
    m = re.search(r'^cover:\s*\n((?:[ \t]+.*\n?)*)', fm, re.M)
    if m:
        img = re.search(r'image:\s*["\']([^"\']+)["\']', m.group(1))
        return ('object', img.group(1) if img else None)
    return (None, None)

buckets = {'parsecover': [], 'default_imported': [], 'local': [], 'remote_cdn': [], 'no_cover': [], 'local_missing': [], 'template': [], 'other_remote': []}
total = 0
for fn in sorted(os.listdir(ROOT)):
    if not fn.endswith('.md'):
        continue
    p = os.path.join(ROOT, fn)
    txt = open(p, encoding='utf-8').read()
    fm = parse_frontmatter(txt)
    if 'weread-highlights-reviews' not in fm:
        continue  # 只统计书架书
    total += 1
    bid = re.search(r'^bookId:\s*["\']?([^"\'\n]+)', fm, re.M)
    bid = bid.group(1).strip() if bid else '?'
    kind, val = parse_cover(fm)
    rec = f'{fn}  [{bid}]'
    if kind is None:
        buckets['no_cover'].append(rec)
    elif 'generated-cover' in (val or ''):
        buckets['template'].append(rec + ' -> ' + val)
    elif val and val.startswith('http'):
        if 'parsecover' in val:
            buckets['parsecover'].append(rec + ' -> ' + val)
        elif 'book_cover_default_imported' in val:
            buckets['default_imported'].append(rec + ' -> ' + val)
        elif 'weread' in val or 'myqcloud' in val:
            buckets['remote_cdn'].append(rec)
        else:
            buckets['other_remote'].append(rec + ' -> ' + val)
    elif val:
        # 本地相对路径
        local = os.path.join(os.path.dirname(p), val.replace('/', os.sep))
        if not os.path.exists(local):
            alt = os.path.join(r'C:\Users\NewtN\下载\lectures-et-echos-main', val.replace('/', os.sep))
            if os.path.exists(alt):
                buckets['local'].append(rec)
            else:
                buckets['local_missing'].append(rec + ' -> ' + val)
        else:
            buckets['local'].append(rec)
    else:
        buckets['no_cover'].append(rec + ' (cover 块无 image)')

print('书架书总数:', total)
for k in ['template', 'parsecover', 'default_imported', 'no_cover', 'local_missing', 'other_remote', 'local', 'remote_cdn']:
    print(f'--- {k}: {len(buckets[k])}')
    for r in buckets[k]:
        print('   ', r)
