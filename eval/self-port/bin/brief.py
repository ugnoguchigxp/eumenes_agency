import json,glob,sys,os,re
d=sys.argv[1]
for f in sorted(glob.glob(f'{d}/queue/*.req.json')):
  k=os.path.basename(f)[:20]
  if os.path.exists(f'{d}/answers/{k}.json'): continue
  r=json.load(open(f)); I='interestOps' in r['schema']['properties']
  p=r['prompt']
  obs=re.findall(r'\[(o\d+)\] \S+ / actor=(\w+)[^\n]*\n  本文: "([^"]*)"',p)
  st=p.split('# 保存されている状態')[1].split('# 使えるツール')[0] if '# 保存されている状態' in p else ''
  st=' | '.join(l for l in st.splitlines() if l.strip() and 'なし' not in l and not l.endswith(':'))
  print(k,'I' if I else 'F',r['purpose'],' / '.join(f'{a}:{b[0]}:{c}' for a,b,c in obs),'||',st)
