# -*- coding: utf-8 -*-
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "site" / "src" / "layouts" / "BaseLayout.astro"
t = p.read_text(encoding="utf-8")
old = 'src="/footer/far.jpg" alt="" loading="lazy" decoding="async" width="2160" height="400"'
new = 'src="/footer/far.jpg" alt="" loading="lazy" decoding="async" width="2240" height="400"'
assert t.count(old) == 2, t.count(old)
p.write_text(t.replace(old, new), encoding="utf-8", newline="")
print("far img dims updated")
