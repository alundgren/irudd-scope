"""Collect data and write viewer.html next to this file. Same options as collect.py, e.g.
  python build.py --days 7
  python build.py --thread <T3 thread id>
"""
import os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, 'data.json')
subprocess.run([sys.executable, '-I', os.path.join(here, 'collect.py'), *sys.argv[1:], '--out', out], check=True)
data = open(out, encoding='utf-8').read().replace('</', '<\\/')
html = open(os.path.join(here, 'viewer.template.html'), encoding='utf-8').read().replace('__DATA__', data)
open(os.path.join(here, 'viewer.html'), 'w', encoding='utf-8').write(html)
print('wrote', os.path.join(here, 'viewer.html'))
