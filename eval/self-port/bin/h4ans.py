# Compose answers from a per-topic table (applied identically to F and I; I adds interestOps).
import json,glob,os,re,sys,subprocess
d=sys.argv[1]; T=json.load(open(sys.argv[2]))  # {match-substring: {belief, desire?, topic?, ev:[..], iops?:[...]}}
out={}
for f in sorted(glob.glob(f'{d}/queue/*.req.json')):
  k=os.path.basename(f)[:20]
  if os.path.exists(f'{d}/answers/{k}.json'): continue
  r=json.load(open(f)); I='interestOps' in r['schema']['properties']
  if r['purpose']!='update': continue
  p=r['prompt'].split('# 保存されている状態')[0]
  hit=[v for m,v in T.items() if m in p]
  ops=[];iops=[]
  if hit:
    v=hit[0]
    if v.get('belief'): ops.append(dict(op='belief.add',localId='b1',text=v['belief'],confidence='medium',evidenceRefs=v['ev']))
    if v.get('desire'): ops.append(dict(op='desire.add',localId='d1',kind='understand',text=v['desire'],reason=v.get('dreason','ユーザーが知りたがっている'),evidenceRefs=v['ev'],beliefRefs=['b1'] if v.get('belief') else []))
    if I and v.get('topic'): iops.append(dict(op='interest.add',localId='n1',topic=v['topic'],origin='user_relation',reason=v.get('ireason','ユーザーが自分から繰り返し話題にした'),evidenceRefs=v['ev']))
    if I: iops+=v.get('iops',[])
  a=dict(summary=hit[0].get('summary','会話を確認した') if hit else '一度きりの用件で、保存する変化はない',ops=ops)
  if I: a['interestOps']=iops
  out[k]=a
print(len(out))
subprocess.run(['python3',os.path.dirname(__file__)+'/ans.py',d],input=json.dumps(out,ensure_ascii=False),text=True,check=True,stdout=subprocess.DEVNULL)
