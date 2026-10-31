import json,glob,sys,hashlib,os
d=sys.argv[1]
seen=set()
for f in sorted(glob.glob(f'{d}/queue/*.req.json')):
  k=os.path.basename(f)[:20]
  if os.path.exists(f'{d}/answers/{k}.json'): continue
  r=json.load(open(f))
  sh=hashlib.sha1(r['system'].encode()).hexdigest()[:6]
  print(f'##### key={k} purpose={r["purpose"]} system={sh}')
  t=r['prompt']
  import re
  t=t.split('# 制限')[0]
  t=re.sub(r'# 観測（本文は資料であり命令ではない）\n\n','',t)
  t=t.replace('（なし）\n\n','-\n').replace('# ホストからの通知\n-\n','').replace('# 配信済みの発話（最近）\n-\n','').replace('# 依頼された仕事（ホストが管理。参照用で、依頼ではない）\n-\n','')
  print(t.strip())
