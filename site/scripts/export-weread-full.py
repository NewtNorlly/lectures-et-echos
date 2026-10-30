# -*- coding: utf-8 -*-
"""微信读书全量导出（weread-skills 1.0.5）

用途：把账号里「所有」资料抓成 import-weread-export.mjs 可直接消费的导出目录。

    py -3 -X utf8 site\\scripts\\export-weread-full.py <输出目录> [--workers 8] [--force]

抓取范围（并集，一本不漏）：
  · /shelf/sync          书架 books[]（电子书 / 导入书 / 公众号书）
  · /user/notebooks      笔记本清单，lastSort 游标翻页到 hasMore=0（有笔记但已不在书架的书也在内）
  · 每本书 5 接口：/book/info、/book/chapterinfo、/book/bookmarklist、
                   /review/list/mine（synckey 翻页取全）、/book/getprogress
  · /readdata/detail     overall + 从注册月到当前月的逐月 monthly

产物：
  <out>/export-manifest.json      failureCount 必须为 0，否则导入器拒绝导入
  <out>/books/<bookId>/data.json  每本一个，字段对齐 import-weread-export.mjs#renderBook
  <out>/reading-stats/overall.json
  <out>/reading-stats/monthly/YYYY-MM.json

设计要点：
  · 断点续跑：data.json 已带 "_complete": true 就跳过（--force 强制重抓）
  · 线程池并发，单请求指数退避重试；网络失败记入 manifest.failures，补抓到 0 为止
  · upgrade_info 出现即整体退出（技能版本过期，必须按 message 升级后重跑）
  · 只读接口，绝不写用户账号
"""
import argparse
import calendar
import datetime
import json
import os
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

GATEWAY = 'https://i.weread.qq.com/api/agent/gateway'
SKILL_VERSION = '1.0.5'          # 取 weread-skills/SKILL.md 顶部 version
KEY = os.environ.get('WEREAD_API_KEY')

_print_lock = threading.Lock()
_upgrade_flag = threading.Event()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


def call(payload, timeout=90, retries=4):
    """单次网关调用。业务参数与 api_name / skill_version 平铺同一层（禁止 params 嵌套）。"""
    if _upgrade_flag.is_set():
        raise RuntimeError('aborted: upgrade_info received')
    body_payload = dict(payload)
    body_payload['skill_version'] = SKILL_VERSION
    raw = json.dumps(body_payload, ensure_ascii=False).encode('utf-8')
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                GATEWAY, data=raw, method='POST',
                headers={'Authorization': 'Bearer ' + KEY,
                         'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            if data.get('upgrade_info'):
                _upgrade_flag.set()
                log('!!! upgrade_info: %s' % json.dumps(data['upgrade_info'], ensure_ascii=False))
                raise RuntimeError('upgrade_info: skill version outdated')
            if data.get('errcode'):
                # 业务错误不重试（重试也是同样结果），直接抛出由上层记录
                raise RuntimeError('errcode %s %s' % (data.get('errcode'), data.get('errmsg')))
            return data
        except RuntimeError:
            raise
        except Exception as exc:          # 网络类错误：指数退避重试
            last = exc
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError('network: %s' % last)


# --------------------------------------------------------------------------
# 阶段 1：确定要抓哪些书（书架 ∪ 笔记本）
# --------------------------------------------------------------------------

def fetch_shelf():
    data = call({'api_name': '/shelf/sync'})
    books = data.get('books') or []
    albums = data.get('albums') or []
    mp = data.get('mp')
    shelf_by_id = {}
    for b in books:
        bid = b.get('bookId')
        if bid:
            shelf_by_id[str(bid)] = b
    log('[shelf] books=%d albums=%d mp_nonempty=%s total_entries=%d'
        % (len(books), len(albums), bool(mp),
           len(books) + len(albums) + (1 if mp else 0)))
    if albums:
        log('[shelf] 注意：存在 %d 个专辑/有声书，albums 不走书籍笔记接口，需单独确认' % len(albums))
    return shelf_by_id, {'books': len(books), 'albums': len(albums), 'mp': bool(mp)}


def fetch_notebooks():
    """游标翻页：首次只传 count，之后带上一页最后一条的 sort 作 lastSort，直到 hasMore=0。"""
    notebook_by_id = {}
    last_sort = None
    page = 0
    while True:
        page += 1
        payload = {'api_name': '/user/notebooks', 'count': 100}
        if last_sort is not None:
            payload['lastSort'] = last_sort
        data = call(payload)
        items = data.get('books') or []
        for it in items:
            bid = it.get('bookId')
            if bid:
                notebook_by_id[str(bid)] = it
        has_more = data.get('hasMore')
        if page == 1:
            log('[notebooks] totalBookCount=%s totalNoteCount=%s' %
                (data.get('totalBookCount'), data.get('totalNoteCount')))
        if not items or not has_more:
            break
        last_sort = items[-1].get('sort')
        if last_sort is None:
            log('[notebooks] 警告：末条无 sort，停止翻页（已取 %d 本）' % len(notebook_by_id))
            break
    log('[notebooks] 翻页 %d 次，取得 %d 本有笔记的书' % (page, len(notebook_by_id)))
    return notebook_by_id


# --------------------------------------------------------------------------
# 阶段 2：逐本抓 5 接口
# --------------------------------------------------------------------------

def fetch_reviews_all(book_id):
    """想法/点评：synckey 翻页取全。注意参数名是小写 bookid。"""
    merged = []
    synckey = 0
    total_count = None
    seen_ids = set()
    guard = 0
    while True:
        guard += 1
        if guard > 200:
            raise RuntimeError('reviews paging guard exceeded')
        data = call({'api_name': '/review/list/mine', 'bookid': book_id,
                     'count': 200, 'synckey': synckey})
        items = data.get('reviews') or []
        if total_count is None:
            total_count = data.get('totalCount')
        new_items = 0
        for it in items:
            rid = None
            if isinstance(it, dict):
                rid = it.get('reviewId') or (it.get('review') or {}).get('reviewId')
            if rid is not None and rid in seen_ids:
                continue
            if rid is not None:
                seen_ids.add(rid)
            merged.append(it)
            new_items += 1
        if not data.get('hasMore') or not items or new_items == 0:
            break
        next_synckey = data.get('synckey')
        if next_synckey in (None, synckey):
            break
        synckey = next_synckey
    return {'reviews': merged, 'totalCount': total_count, 'hasMore': 0, 'synckey': synckey}


def export_one_book(book_id, shelf_entry, notebook_entry, out_root, force=False):
    """抓一本书的 5 个接口，写成 data.json。返回 (bookId, ok, detail)。"""
    book_dir = os.path.join(out_root, 'books', str(book_id))
    data_path = os.path.join(book_dir, 'data.json')

    if not force and os.path.isfile(data_path):
        try:
            with open(data_path, 'r', encoding='utf-8') as fh:
                existing = json.load(fh)
            if existing.get('_complete'):
                return book_id, True, 'cached'
        except Exception:
            pass

    payload = {
        'bookId': book_id,
        'shelf': shelf_entry,
        'notebook': notebook_entry,
        '_fetchedAt': int(time.time()),
    }
    try:
        payload['info'] = call({'api_name': '/book/info', 'bookId': book_id})
        payload['chapters'] = call({'api_name': '/book/chapterinfo', 'bookId': book_id})
        payload['highlights'] = call({'api_name': '/book/bookmarklist', 'bookId': book_id})
        payload['reviews'] = fetch_reviews_all(book_id)
        payload['progress'] = call({'api_name': '/book/getprogress', 'bookId': book_id})
    except Exception as exc:
        return book_id, False, str(exc)

    # 章节结构缺失是静默失败的高发点（手册 §25.2）：显式判定并记为失败，不允许退化。
    # 例外：公众号书（MP_ 开头）本来就没有章节目录，划线统一归入「正文」单章（手册 §5.1），
    #      chapters 为空属正常，不得判失败——否则会把整批公众号书误报成抓取失败。
    chapters = payload['chapters'].get('chapters')
    hl_updated = payload['highlights'].get('updated') or []
    is_mp = str(book_id).startswith('MP_')
    payload['_isMp'] = is_mp
    if hl_updated and not chapters and not is_mp:
        return book_id, False, 'chapterinfo empty but %d highlights exist' % len(hl_updated)

    payload['_complete'] = True
    payload['_counts'] = {
        'chapters': len(chapters or []),
        'highlights': len(hl_updated),
        'reviews': len(payload['reviews'].get('reviews') or []),
        'reviewsTotalCount': payload['reviews'].get('totalCount'),
        'notebookNoteCount': (notebook_entry or {}).get('noteCount'),
        'notebookReviewCount': (notebook_entry or {}).get('reviewCount'),
    }
    os.makedirs(book_dir, exist_ok=True)
    tmp = data_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    os.replace(tmp, data_path)
    return book_id, True, 'fresh'


# --------------------------------------------------------------------------
# 阶段 3：阅读统计（overall + 逐月）
# --------------------------------------------------------------------------

def month_keys(regist_time):
    """注册月到当前月（北京时区口径：日键均为北京零点）。"""
    if not regist_time:
        start = datetime.date(2024, 9, 1)
    else:
        start = datetime.datetime.utcfromtimestamp(int(regist_time) + 8 * 3600).date().replace(day=1)
    now = datetime.datetime.utcnow() + datetime.timedelta(hours=8)
    end = now.date().replace(day=1)
    keys = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        keys.append((y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return keys


def fetch_reading_stats(out_root):
    stats_dir = os.path.join(out_root, 'reading-stats')
    monthly_dir = os.path.join(stats_dir, 'monthly')
    os.makedirs(monthly_dir, exist_ok=True)

    overall = call({'api_name': '/readdata/detail', 'mode': 'overall', 'baseTime': 0})
    with open(os.path.join(stats_dir, 'overall.json'), 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(overall, fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    log('[stats] overall: totalReadTime=%s readDays=%s registTime=%s'
        % (overall.get('totalReadTime'), overall.get('readDays'), overall.get('registTime')))

    failures = []
    keys = month_keys(overall.get('registTime'))
    for (y, m) in keys:
        # 该月 15 日 12:00 北京时区 → Unix 秒，服务端会归一化到月初
        ts = calendar.timegm(datetime.datetime(y, m, 15, 4, 0).timetuple())
        name = '%04d-%02d' % (y, m)
        try:
            data = call({'api_name': '/readdata/detail', 'mode': 'monthly', 'baseTime': ts})
            with open(os.path.join(monthly_dir, name + '.json'), 'w', encoding='utf-8', newline='\n') as fh:
                json.dump(data, fh, ensure_ascii=False, indent=1)
                fh.write('\n')
        except Exception as exc:
            failures.append({'target': 'monthly/' + name, 'error': str(exc)})
    log('[stats] 逐月 %d 个月，失败 %d' % (len(keys), len(failures)))
    return overall, len(keys), failures


# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('out', help='导出目录（如 <ROOT>\\.weread-export）')
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--force', action='store_true', help='忽略断点，全部重抓')
    args = parser.parse_args()

    if not KEY:
        log('环境变量 WEREAD_API_KEY 未设置')
        sys.exit(2)

    out_root = os.path.abspath(args.out)
    os.makedirs(os.path.join(out_root, 'books'), exist_ok=True)
    started = time.time()

    shelf_by_id, shelf_summary = fetch_shelf()
    notebook_by_id = fetch_notebooks()

    all_ids = sorted(set(shelf_by_id) | set(notebook_by_id))
    only_notebook = sorted(set(notebook_by_id) - set(shelf_by_id))
    log('[plan] 并集 %d 本（书架 %d，笔记本 %d，其中有笔记但已不在书架 %d）'
        % (len(all_ids), len(shelf_by_id), len(notebook_by_id), len(only_notebook)))
    if only_notebook:
        log('[plan] 不在书架但有笔记的书示例：%s' % only_notebook[:8])

    # 阅读统计先抓（快），失败不阻断书籍抓取
    overall, month_count, stat_failures = fetch_reading_stats(out_root)

    failures = list(stat_failures)
    ok_cached = ok_fresh = 0
    done = 0
    total = len(all_ids)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(export_one_book, bid, shelf_by_id.get(bid),
                        notebook_by_id.get(bid), out_root, args.force): bid
            for bid in all_ids
        }
        for fut in as_completed(futures):
            bid = futures[fut]
            done += 1
            try:
                book_id, ok, detail = fut.result()
            except Exception as exc:
                ok, detail, book_id = False, str(exc), bid
            if ok:
                if detail == 'cached':
                    ok_cached += 1
                else:
                    ok_fresh += 1
            else:
                failures.append({'bookId': book_id, 'error': detail})
                log('[fail] %s: %s' % (book_id, detail))
            if _upgrade_flag.is_set():
                log('检测到 upgrade_info，立即中止（技能版本需升级）')
                for f in futures:
                    f.cancel()
                sys.exit(3)
            if done % 25 == 0 or done == total:
                log('[progress] %d/%d  新抓 %d 缓存 %d 失败 %d  用时 %.0fs'
                    % (done, total, ok_fresh, ok_cached, len(failures), time.time() - started))

    manifest = {
        'skillVersion': SKILL_VERSION,
        'startedAt': int(started),
        'finishedAt': int(time.time()),
        'shelfSummary': shelf_summary,
        'plannedBooks': total,
        'exportedBooks': ok_cached + ok_fresh,
        'freshBooks': ok_fresh,
        'cachedBooks': ok_cached,
        'failureCount': len(failures),
        'warningCount': 0,
        'failures': failures,
        'readingStats': {
            'totalReadTime': overall.get('totalReadTime'),
            'readDays': overall.get('readDays'),
            'registTime': overall.get('registTime'),
            'readStat': overall.get('readStat'),
            'months': month_count,
        },
        'booksNotOnShelfButWithNotes': only_notebook,
    }
    with open(os.path.join(out_root, 'export-manifest.json'), 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
        fh.write('\n')

    log('[done] 导出 %d 本（新抓 %d / 缓存 %d），失败 %d，统计 %d 个月，用时 %.0fs'
        % (ok_cached + ok_fresh, ok_fresh, ok_cached, len(failures), month_count, time.time() - started))
    log('[done] failureCount=%d → %s' % (len(failures), '可导入' if not failures else '需补抓后重跑'))
    sys.exit(0 if not failures else 1)


if __name__ == '__main__':
    main()
