# -*- coding: utf-8 -*-
import os, re, json

ROOT = r'C:\Users\NewtN\下载\lectures-et-echos-main\微信读书'
AD = os.path.join(ROOT, '文本附件')
BIDS = {
    'CB_8v5Az5AyXAEZ76V75AEJv735': '哈佛经济学家推理系列',
    'CB_2YC7c07ap2Ow6zq71574HCbY': '江村经济',
    'CB_H177IH7GS2Ow6zq71526A9Qp': '强社会与弱国家',
    'CB_3HTB0K1eS7sG5BF6xPDEY9gW': '国家为什么会失败',
    'CB_5P58rn8v29N46yQ6wwB3GELY': '社会学（第5版）',
    'CB_11t8UL8SYAlD76775A69PDoQ': '胭脂与焉支',
    'CB_6jL8CB8C62bJ6vh6ww9u996L': '党政机关公文格式',
}
ok = True
for fn in sorted(os.listdir(ROOT)):
    if not fn.endswith('.md'):
        continue
    p = os.path.join(ROOT, fn)
    txt = open(p, encoding='utf-8').read()
    m = re.search(r'^bookId:\s*["\']?([^"\'\r\n]+)', txt.split('---', 2)[1], re.M)
    bid = m.group(1).strip().strip('"').strip("'") if m else None
    if bid not in BIDS:
        continue
    print('=' * 60)
    print(BIDS[bid], '|', fn)
    fm = txt.split('---', 2)[1]
    # 衔接检查：positionY 行后必须紧跟 progress/readingTime/其他字段
    after = re.search(r'positionY: 50\s*\r?\n([^\n]*)', fm)
    print('  positionY 下一行:', after.group(1) if after else '!! 未找到')
    # cover 块字段
    for field in ['image', 'actualRatio', 'pixelWidth', 'pixelHeight', 'displayWidth', 'displayHeight', 'positionX', 'positionY']:
        if not re.search(rf'^  {field}:', fm, re.M):
            print('  !! 缺字段', field); ok = False
    # 旧 URL 残留检查（frontmatter + callout）
    for bad in ['parsecover', 'default_imported']:
        if bad in fm:
            print('  !! frontmatter 残留', bad); ok = False
    # callout 行
    cm = re.search(r'^> - !\[([^\]]*)\]\(([^)]*)\)', txt, re.M)
    print('  callout:', cm.group(2) if cm else '!! 无')
    # webp 文件
    for h in (960, 480):
        f = os.path.join(AD, f'cover-{bid}-{h}.webp')
        if not os.path.exists(f):
            print('  !! 缺文件', f); ok = False
    # progress / readingTime 等字段完整
    for field in ['progress:', 'readingTime:', 'lastReadDate:', 'sourceUrl:']:
        if not re.search(rf'^{field}', fm, re.M):
            print('  !! 缺字段', field); ok = False
print('ALL OK' if ok else 'HAS PROBLEMS')
