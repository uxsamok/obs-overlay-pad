#!/usr/bin/env python3
"""Проверка переводов: все ключи t('...') / data-i18n* из кода есть в каждом i18n/*.json."""
import json, re, glob, sys, os
os.chdir(os.path.join(os.path.dirname(__file__), '..'))
used = set()
for f in glob.glob('js/*.js') + ['index.html']:
    s = open(f, encoding='utf-8').read()
    # строки-ключи внутри t(...) включая тернарники: t(on ? 'a.b' : 'c.d')
    for arg in re.findall(r"\bt\(([^()]*)", s):
        used |= {k for k in re.findall(r"'([a-z]+\.[\w.]*\w)'", arg)}
    used |= set(re.findall(r'data-i18n(?:-aria|-title)?="([\w.]+)"', s))
dyn = {'type.overlay', 'type.counter', 'type.replay', 'mode.timer', 'mode.toggle'}  # t('type.' + k)
used |= dyn
ok = True
for f in sorted(glob.glob('i18n/*.json')):
    if f.endswith('languages.json'): continue
    keys = set(json.load(open(f, encoding='utf-8')))
    miss, extra = used - keys, keys - used
    print(f'{f}: {len(keys)} keys, missing {sorted(miss) or "none"}, unused {sorted(extra) or "none"}')
    ok &= not miss
sys.exit(0 if ok else 1)
