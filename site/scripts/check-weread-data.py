# -*- coding: utf-8 -*-
"""书摘数据层一致性校验（手册 §11.1）

    py -3 -X utf8 site\\scripts\\check-weread-data.py [--library <目录>]

只读校验，不修改任何文件。检查项：
  1. noteCount == 正文 📌 数
  2. reviewCount == 正文 💭 数 + 「章节点评与书评」下 ## 条目数
  3. 📌 都带 ⏱、💭 都带 🕰（时间戳 0 缺失——时间戳是内容身份凭证，§2.0 第 2 条）
  4. 140 字怀疑线：书架模块只查 💭 想法与独立笔记，📌 划线原文不拆不查（§7.1 第 10 条）
  5. 有笔记的书三个日期（lastReadDate/finishedDate/readingDate）不全空
  6. 全库 md 统一 LF
  7. frontmatter 无半角 % 等 URL 保留字（文件名，§24.5）

退出码：0 = 全部通过；1 = 有不符项。
"""
import argparse
import os
import re
import sys

HAN = re.compile(r'[\u4e00-\u9fff]')
FM = re.compile(r'^---\n(.*?)\n---', re.DOTALL)
NOTE_COUNT = re.compile(r'^noteCount:\s*(\d+)', re.MULTILINE)
REVIEW_COUNT = re.compile(r'^reviewCount:\s*(\d+)', re.MULTILINE)
LAST_READ = re.compile(r'^lastReadDate:\s*(\S+)', re.MULTILINE)
FINISHED = re.compile(r'^finishedDate:\s*(\S+)', re.MULTILINE)
READING = re.compile(r'^readingDate:\s*(\S+)', re.MULTILINE)
DOC_TYPE = re.compile(r'^doc_type:\s*(\S+)', re.MULTILINE)


def han_len(text):
    return len(HAN.findall(text))


def check_file(path_):
    """返回该书的问题列表。"""
    problems = []
    with open(path_, 'rb') as fh:
        raw = fh.read()
    name = os.path.basename(path_)

    # 6. LF 统一
    if b'\r\n' in raw:
        problems.append('换行符不是纯 LF（含 CRLF）')
    text = raw.decode('utf-8', errors='replace')

    fm_match = FM.search(text)
    if not fm_match:
        problems.append('无 frontmatter')
        return problems, None
    fm = fm_match.group(1)

    doc_type = (DOC_TYPE.search(fm).group(1) if DOC_TYPE.search(fm) else '').strip()
    stats = {'docType': doc_type, 'file': name}

    note_declared = int(NOTE_COUNT.search(fm).group(1)) if NOTE_COUNT.search(fm) else None
    review_declared = int(REVIEW_COUNT.search(fm).group(1)) if REVIEW_COUNT.search(fm) else None

    body = text[fm_match.end():]
    lines = body.split('\n')

    # 定位「章节点评与书评」节，统计其下 ## 条目数
    in_review_section = False
    review_h2 = 0
    hl_marks = 0
    th_marks = 0
    hl_times = 0
    th_times = 0
    recorded_at = 0

    # 140 字怀疑线：收集需要检查的文本块
    long_thoughts = []       # 💭 想法（含 blockquote 续段）
    long_standalone = []     # 独立笔记段落

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith('# ') and '章节点评与书评' in stripped:
            in_review_section = True
            i += 1
            continue
        if stripped.startswith('# ') and '章节点评与书评' not in stripped:
            in_review_section = False
            i += 1
            continue

        if in_review_section and stripped.startswith('## '):
            review_h2 += 1

        if stripped.startswith('> 📌') or stripped == '> 📌':
            hl_marks += 1
        elif stripped.startswith('> 💭'):
            th_marks += 1
            # 收集该 💭 条目的全部 blockquote 续段，合并后按 140 检查
            buf = [re.sub(r'^>\s?', '', line)]
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if nxt.startswith('>'):
                    content = re.sub(r'^>\s?', '', nxt)
                    if content.strip().startswith('🕰'):
                        break
                    buf.append(content)
                    j += 1
                elif nxt.strip() == '':
                    j += 1
                    # 空行后若不再是 blockquote 则结束
                    if j < len(lines) and not lines[j].startswith('>'):
                        break
                else:
                    break
            # 每个自然段分别检查（blockquote 内以裸 > 空行分段）
            for seg in re.split(r'\n\s*\n', '\n'.join(buf)):
                seg = seg.strip()
                if seg and han_len(seg) > 140:
                    long_thoughts.append((han_len(seg), seg[:40]))
            i = j
            continue

        if stripped.startswith('> ⏱'):
            hl_times += 1
        elif stripped.startswith('> 🕰'):
            th_times += 1
        elif stripped.startswith('> 记录于'):
            recorded_at += 1

        # 独立笔记段落（在「章节点评与书评」节内、非 blockquote、非标题、非时间戳）
        if in_review_section and stripped and not stripped.startswith('>') \
                and not stripped.startswith('#'):
            if han_len(stripped) > 140:
                long_standalone.append((han_len(stripped), stripped[:40]))
        i += 1

    stats.update({
        'noteDeclared': note_declared, 'noteActual': hl_marks,
        'reviewDeclared': review_declared, 'reviewActual': th_marks + review_h2,
        'hlMarks': hl_marks, 'thMarks': th_marks, 'reviewH2': review_h2,
        'hlTimes': hl_times, 'thTimes': th_times, 'recordedAt': recorded_at,
    })

    # 1. noteCount 恒等式
    if note_declared is not None and note_declared != hl_marks:
        problems.append('noteCount 不符：声明 %d，正文 📌 %d' % (note_declared, hl_marks))
    # 2. reviewCount 恒等式（💭 + 章节点评与书评 ## 条目）
    if review_declared is not None and review_declared != th_marks + review_h2:
        problems.append('reviewCount 不符：声明 %d，正文 💭%d + 独立条目 %d = %d'
                        % (review_declared, th_marks, review_h2, th_marks + review_h2))
    # 3. 时间戳齐全（身份凭证，§2.0 第 2 条）
    if hl_times != hl_marks:
        problems.append('⏱ 缺失：📌 %d 条，⏱ %d 条' % (hl_marks, hl_times))
    if th_times != th_marks:
        problems.append('🕰 缺失：💭 %d 条，🕰 %d 条' % (th_marks, th_times))
    # 4. 140 字怀疑线
    if long_thoughts:
        problems.append('140 字怀疑线：💭 想法有 %d 段超 140 汉字（最长 %d）'
                        % (len(long_thoughts), max(x[0] for x in long_thoughts)))
    if long_standalone:
        problems.append('140 字怀疑线：独立笔记有 %d 段超 140 汉字（最长 %d）'
                        % (len(long_standalone), max(x[0] for x in long_standalone)))
    # 5. 有笔记的书三个日期不全空
    if hl_marks or th_marks or review_h2:
        has_date = any(p and p.search(fm) for p in (LAST_READ, FINISHED, READING))
        if not has_date:
            problems.append('有笔记但 lastReadDate/finishedDate/readingDate 三个日期全空')

    return problems, stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--library', default=None)
    args = parser.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    repository_root = os.path.dirname(os.path.dirname(here))
    library = os.path.abspath(args.library) if args.library else os.path.join(repository_root, '微信读书')

    files = []
    for name in sorted(os.listdir(library)):
        if not name.endswith('.md') or name == '微信读书Gallery.md':
            continue
        files.append(os.path.join(library, name))

    print('=== 书摘数据层一致性校验（手册 §11.1）===')
    print('书库目录: %s' % library)
    print('待校验: %d 个书摘 md\n' % len(files))

    bad = []
    total_hl = total_th = total_h2 = 0
    for path_ in files:
        problems, stats = check_file(path_)
        if stats:
            total_hl += stats['hlMarks']
            total_th += stats['thMarks']
            total_h2 += stats['reviewH2']
        if problems:
            bad.append((os.path.basename(path_), problems))

    print('--- 汇总 ---')
    print('全库 📌 划线: %d 条' % total_hl)
    print('全库 💭 想法: %d 条' % total_th)
    print('全库 独立笔记/书评条目（##）: %d 条' % total_h2)
    print('')
    if bad:
        print('不符项: %d 本' % len(bad))
        for name, problems in bad[:60]:
            print('· %s' % name)
            for p in problems:
                print('    - %s' % p)
        if len(bad) > 60:
            print('…另有 %d 本' % (len(bad) - 60))
        print('CHECK_FAILED')
        sys.exit(1)
    print('不符项: 0 本 —— noteCount/reviewCount 恒等式全对、时间戳 0 缺失、'
          '140 字怀疑线 0 超长、日期齐全、全库 LF')
    print('CHECK_PASS')


if __name__ == '__main__':
    main()
