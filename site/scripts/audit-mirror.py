# -*- coding: utf-8 -*-
"""镜像对齐审计（手册 §27）——网站内容 vs 微信读书，只按「时间戳」判定

    py -3 -X utf8 site\\scripts\\audit-mirror.py <导出目录> [--write-report <路径>]

只读审计：不修改、不删除任何文件，只输出报告。删除动作由调用方在用户确认后执行。

判定规则（手册 §2.0）：
  · 时间戳是每条内容的唯一身份凭证。网站上的 ⏱（划线）与 🕰 / 记录于（想法）都是
    Asia/Shanghai 的 `YYYY-MM-DD HH:mm:ss`，按同一时区还原成 Unix 秒后与微信读书
    的 createTime 对齐。**不按文本相似度、不按书名、不按数量差额判定。**
  · 网站有、微信读书没有 → ORPHAN（应删）
  · 微信读书有、网站没有 → MISSING（应补）
  · 整本书在微信读书（书架 ∪ 笔记本）里查无此 bookId → ORPHAN_BOOK（应删）
  · 用户点名排除的书（excludedBookIds）→ 单列，不参与判定（用户主动意愿优先于镜像）
"""
import argparse
import datetime
import json
import os
import re
import sys
from collections import defaultdict

SHANGHAI = datetime.timezone(datetime.timedelta(hours=8))

HIGHLIGHT_TIME = re.compile(r'^>\s*⏱\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')
THOUGHT_TIME = re.compile(r'^>\s*🕰\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')
RECORDED_AT = re.compile(r'^>\s*记录于\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')
HIGHLIGHT_MARK = re.compile(r'^>\s*📌')
THOUGHT_MARK = re.compile(r'^>\s*💭')
FRONT_BOOKID = re.compile(r'^bookId:\s*["\']?([^"\'\n]+?)["\']?\s*$', re.MULTILINE)
FRONT_TITLE = re.compile(r'^title:\s*["\']?(.*?)["\']?\s*$', re.MULTILINE)
FRONT_NOTE = re.compile(r'^noteCount:\s*(\d+)', re.MULTILINE)
FRONT_REVIEW = re.compile(r'^reviewCount:\s*(\d+)', re.MULTILINE)


def to_unix(text):
    """'YYYY-MM-DD HH:mm:ss'（Asia/Shanghai）→ Unix 秒。"""
    try:
        dt = datetime.datetime.strptime(text, '%Y-%m-%d %H:%M:%S').replace(tzinfo=SHANGHAI)
        return int(dt.timestamp())
    except Exception:
        return None


def read_text(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return fh.read()


# --------------------------------------------------------------------------
# 微信读书侧：从导出目录构建 bookId → {划线时间戳集合, 想法时间戳集合}
# --------------------------------------------------------------------------

def load_weread(export_dir):
    books_dir = os.path.join(export_dir, 'books')
    weread = {}
    for name in sorted(os.listdir(books_dir)):
        book_dir = os.path.join(books_dir, name)
        data_path = os.path.join(book_dir, 'data.json')
        if not os.path.isfile(data_path):
            continue
        with open(data_path, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        bid = str(data.get('bookId') or name)

        # ★必须用 list 保留重复计数，不能用 set：微信读书里同一秒可以有多条划线 / 想法
        # （批量划线、同一时刻连发想法）。若用 set 去重，云端计数会偏小，把网站里本来
        # 有来源的条目误报成「网站多、应删」——2026-10-30 首轮审计就因此误报 10 条。
        highlight_times = []
        for hl in ((data.get('highlights') or {}).get('updated') or []):
            ct = hl.get('createTime')
            if ct:
                highlight_times.append(int(ct))

        thought_times = []
        review_items = ((data.get('reviews') or {}).get('reviews') or [])
        for item in review_items:
            inner = item.get('review') if isinstance(item, dict) else None
            if not isinstance(inner, dict):
                inner = item if isinstance(item, dict) else {}
            ct = inner.get('createTime')
            if ct:
                thought_times.append(int(ct))

        info = data.get('info') or {}
        nb = data.get('notebook') or {}
        title = info.get('title') or (nb.get('book') or {}).get('title') or \
                (data.get('shelf') or {}).get('title') or ''
        weread[bid] = {
            'title': title,
            'highlightTimes': highlight_times,
            'thoughtTimes': thought_times,
            'complete': bool(data.get('_complete')),
            'isMp': bool(data.get('_isMp')) or bid.startswith('MP_'),
            'onShelf': bool(data.get('shelf')),
            'inNotebook': bool(nb),
            'notebookNoteCount': nb.get('noteCount'),
            'notebookReviewCount': nb.get('reviewCount'),
            'counts': data.get('_counts') or {},
        }
    return weread


# --------------------------------------------------------------------------
# 网站侧：解析 微信读书\*.md
# --------------------------------------------------------------------------

def parse_site_md(text):
    """返回该 md 的 bookId、title、划线时间戳集合、想法时间戳集合、计数。"""
    fm_match = re.search(r'^---\n(.*?)\n---', text, re.DOTALL)
    fm = fm_match.group(1) if fm_match else ''
    bid_m = FRONT_BOOKID.search(fm)
    title_m = FRONT_TITLE.search(fm)
    note_m = FRONT_NOTE.search(fm)
    review_m = FRONT_REVIEW.search(fm)

    highlight_times = []
    thought_times = []
    hl_marks = 0
    th_marks = 0
    for line in text.split('\n'):
        if HIGHLIGHT_MARK.match(line):
            hl_marks += 1
        elif THOUGHT_MARK.match(line):
            th_marks += 1
        m = HIGHLIGHT_TIME.match(line)
        if m:
            ts = to_unix(m.group(1))
            if ts is not None:
                highlight_times.append(ts)
            continue
        m = THOUGHT_TIME.match(line) or RECORDED_AT.match(line)
        if m:
            ts = to_unix(m.group(1))
            if ts is not None:
                thought_times.append(ts)

    return {
        'bookId': bid_m.group(1).strip() if bid_m else None,
        'title': title_m.group(1).strip() if title_m else '',
        'noteCount': int(note_m.group(1)) if note_m else None,
        'reviewCount': int(review_m.group(1)) if review_m else None,
        'highlightMarks': hl_marks,
        'thoughtMarks': th_marks,
        'highlightTimes': highlight_times,
        'thoughtTimes': thought_times,
    }


# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('export_dir')
    parser.add_argument('--library', default=None, help='书库目录，缺省 <ROOT>\\微信读书')
    parser.add_argument('--excluded', default=None, help='用户点名排除的 bookId 清单 JSON 文件')
    parser.add_argument('--write-report', default=None)
    args = parser.parse_args()

    export_dir = os.path.abspath(args.export_dir)
    here = os.path.dirname(os.path.abspath(__file__))
    repository_root = os.path.dirname(os.path.dirname(here))
    library = os.path.abspath(args.library) if args.library else os.path.join(repository_root, '微信读书')

    excluded = set()
    if args.excluded and os.path.isfile(args.excluded):
        with open(args.excluded, 'r', encoding='utf-8') as fh:
            excluded = {str(x) for x in (json.load(fh) or [])}

    manifest_path = os.path.join(export_dir, 'export-manifest.json')
    manifest = {}
    if os.path.isfile(manifest_path):
        with open(manifest_path, 'r', encoding='utf-8') as fh:
            manifest = json.load(fh)

    print('=== 镜像对齐审计（手册 §27）===')
    print('导出目录: %s' % export_dir)
    print('书库目录: %s' % library)
    print('manifest.failureCount=%s  exportedBooks=%s' %
          (manifest.get('failureCount'), manifest.get('exportedBooks')))
    if manifest.get('failureCount'):
        print('!! failureCount != 0：数据不完整，本次结果不得作为删除依据（手册 §2.0 第 7 条）')

    weread = load_weread(export_dir)
    print('微信读书侧: %d 本（书架∪笔记本并集）' % len(weread))

    site_files = []
    for name in sorted(os.listdir(library)):
        if not name.endswith('.md'):
            continue
        if name == '微信读书Gallery.md':
            continue
        site_files.append(os.path.join(library, name))
    print('网站侧: %d 个书摘 md' % len(site_files))

    orphan_books = []        # 网站有、微信读书整本查无
    excluded_books = []      # 用户点名排除
    per_book = []
    total_orphan_hl = total_orphan_th = 0
    total_implicit_hl = 0   # 隐式划线（§16.1）：时间戳来自 review，微信读书里确有来源，不算孤儿
    total_missing_hl = total_missing_th = 0

    seen_ids = set()
    for path_ in site_files:
        text = read_text(path_)
        site = parse_site_md(text)
        bid = site['bookId']
        fname = os.path.basename(path_)
        if not bid:
            orphan_books.append({'file': fname, 'reason': 'frontmatter 无 bookId，无法追溯到微信读书',
                                 'title': site['title'],
                                 'highlights': site['highlightMarks'], 'thoughts': site['thoughtMarks']})
            continue
        seen_ids.add(bid)
        if bid in excluded:
            excluded_books.append({'file': fname, 'bookId': bid, 'title': site['title']})
            continue
        wr = weread.get(bid)
        if wr is None:
            orphan_books.append({'file': fname, 'bookId': bid, 'title': site['title'],
                                 'reason': '微信读书（书架∪笔记本）查无此 bookId',
                                 'highlights': site['highlightMarks'], 'thoughts': site['thoughtMarks']})
            continue
        if not wr['complete']:
            print('!! 警告：%s 导出数据未标记完整，跳过判定（不得据此删除）' % bid)
            continue

        wr_hl = wr['highlightTimes']
        wr_th = wr['thoughtTimes']
        site_hl_counts = defaultdict(int)
        for ts in site['highlightTimes']:
            site_hl_counts[ts] += 1
        site_th_counts = defaultdict(int)
        for ts in site['thoughtTimes']:
            site_th_counts[ts] += 1

        wr_hl_counts = defaultdict(int)
        for ts in wr_hl:
            wr_hl_counts[ts] += 1
        wr_th_counts = defaultdict(int)
        for ts in wr_th:
            wr_th_counts[ts] += 1

        orphan_hl = 0
        implicit_hl = 0
        for ts, c in site_hl_counts.items():
            surplus = c - wr_hl_counts.get(ts, 0)
            if surplus <= 0:
                continue
            # ★隐式划线（手册 §16.1）：有 range 但挂不上真书签的想法，会被聚成一条 📌，
            # 其 ⏱ 取的是「该锚点最早想法时间」= 某条 review 的 createTime，不是 bookmark 的
            # createTime。这类 📌 在微信读书里**确有来源**（来源是那条 review），不得判为孤儿。
            if ts in wr_th_counts:
                implicit_hl += surplus
            else:
                orphan_hl += surplus
        orphan_th = sum(max(0, c - wr_th_counts.get(ts, 0)) for ts, c in site_th_counts.items())
        missing_hl = sum(max(0, c - site_hl_counts.get(ts, 0)) for ts, c in wr_hl_counts.items())
        missing_th = sum(max(0, c - site_th_counts.get(ts, 0)) for ts, c in wr_th_counts.items())

        total_orphan_hl += orphan_hl
        total_orphan_th += orphan_th
        total_implicit_hl += implicit_hl
        total_missing_hl += missing_hl
        total_missing_th += missing_th

        if orphan_hl or orphan_th or missing_hl or missing_th:
            per_book.append({
                'file': fname, 'bookId': bid, 'title': wr['title'] or site['title'],
                'orphanHighlights': orphan_hl, 'orphanThoughts': orphan_th,
                'missingHighlights': missing_hl, 'missingThoughts': missing_th,
                'implicitHighlights': implicit_hl,
                'siteHl': site['highlightMarks'], 'siteTh': site['thoughtMarks'],
                'wereadHl': len(wr['highlightTimes']), 'wereadTh': len(wr['thoughtTimes']),
            })

    # 微信读书有、网站整本没有（且未被用户排除）
    absent_books = []
    for bid, wr in weread.items():
        if bid in seen_ids or bid in excluded:
            continue
        absent_books.append({
            'bookId': bid, 'title': wr['title'],
            'highlights': len(wr['highlightTimes']), 'thoughts': len(wr['thoughtTimes']),
            'onShelf': wr['onShelf'], 'inNotebook': wr['inNotebook'],
        })

    print('')
    print('--- 结果汇总 ---')
    print('① 网站有、微信读书查无的整本书（ORPHAN_BOOK，应删）: %d' % len(orphan_books))
    for x in orphan_books[:40]:
        print('   · %s | bookId=%s | 📌%d 💭%d | %s' %
              (x['file'], x.get('bookId', '—'), x['highlights'], x['thoughts'], x['reason']))
    if len(orphan_books) > 40:
        print('   …另有 %d 本' % (len(orphan_books) - 40))

    print('② 用户点名排除、仍在网站上的书（不参与镜像判定）: %d' % len(excluded_books))
    for x in excluded_books[:20]:
        print('   · %s | bookId=%s' % (x['file'], x['bookId']))

    print('③ 条目级不一致的书: %d' % len(per_book))
    print('   网站有、微信读书没有的条目 → 应删: 📌 %d 条 / 💭 %d 条' % (total_orphan_hl, total_orphan_th))
    print('   微信读书有、网站缺的条目 → 应补: 📌 %d 条 / 💭 %d 条' % (total_missing_hl, total_missing_th))
    print('   （另：隐式划线 %d 条已识别为「有来源」，不计入应删——§16.1，其 ⏱ 取自 review.createTime）'
          % total_implicit_hl)
    per_book.sort(key=lambda x: -(x['orphanHighlights'] + x['orphanThoughts'] +
                                  x['missingHighlights'] + x['missingThoughts']))
    for x in per_book[:30]:
        print('   · %s: 多 📌%d/💭%d  缺 📌%d/💭%d  (网站 %d/%d vs 微信读书 %d/%d)' %
              (x['title'][:30], x['orphanHighlights'], x['orphanThoughts'],
               x['missingHighlights'], x['missingThoughts'],
               x['siteHl'], x['siteTh'], x['wereadHl'], x['wereadTh']))
    if len(per_book) > 30:
        print('   …另有 %d 本' % (len(per_book) - 30))

    print('④ 微信读书有、网站整本没有的书（应补）: %d' % len(absent_books))
    for x in absent_books[:30]:
        print('   · %s | bookId=%s | 📌%d 💭%d | 在书架=%s 在笔记本=%s' %
              (x['title'][:36], x['bookId'], x['highlights'], x['thoughts'],
               x['onShelf'], x['inNotebook']))
    if len(absent_books) > 30:
        print('   …另有 %d 本' % (len(absent_books) - 30))

    report = {
        'manifestFailureCount': manifest.get('failureCount'),
        'wereadBooks': len(weread),
        'siteBooks': len(site_files),
        'orphanBooks': orphan_books,
        'excludedBooks': excluded_books,
        'inconsistentBooks': per_book,
        'absentBooks': absent_books,
        'totals': {
            'orphanHighlights': total_orphan_hl,
            'orphanThoughts': total_orphan_th,
            'implicitHighlights': total_implicit_hl,
            'missingHighlights': total_missing_hl,
            'missingThoughts': total_missing_th,
        },
    }
    if args.write_report:
        os.makedirs(os.path.dirname(os.path.abspath(args.write_report)) or '.', exist_ok=True)
        with open(args.write_report, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(report, fh, ensure_ascii=False, indent=1)
            fh.write('\n')
        print('')
        print('报告已写: %s' % os.path.abspath(args.write_report))
    print('AUDIT_DONE')


if __name__ == '__main__':
    main()
