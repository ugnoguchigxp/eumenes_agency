# usage: ans.py DIR < answers.json  ({key: compact-answer})
import json,sys
d=sys.argv[1]; A=json.load(sys.stdin)
F=["op","id","localId","expectedRevision","state","text","reason","completionCondition","resumeCondition","withdrawCondition","applyWhen","hours","intentRef","desireRef","supersedes","kind","confidence","toolName","toolInput"]
for k,a in A.items():
  r=json.load(open(f'{d}/queue/{k}.req.json'))
  if 'ops' in a:
    ops=[]
    for o in a['ops']:
      x={f:o.get(f) for f in F}; x['evidenceRefs']=o.get('evidenceRefs',[]); x['beliefRefs']=o.get('beliefRefs',[]); ops.append(x)
    a['ops']=ops
    a.setdefault('missingInfo',None); a.setdefault('focusRefs',[]); a.setdefault('reconciliations',[])
    if 'interestOps' in r['schema']['properties']:
      IF=['op','id','localId','expectedRevision','status','topic','origin','reason','derivedFrom']
      a['interestOps']=[dict({f:o.get(f) for f in IF},evidenceRefs=o.get('evidenceRefs',[])) for o in a.get('interestOps',[])]
    if 'reportedTodos' in r['schema']['properties']: a.setdefault('reportedTodos',[])
  if 'action' in a:
    for f in ["candidateRef","utterance","toolName","toolInput","conflicts"]: a.setdefault(f,None)
    a.setdefault('evidenceRefs',[])
    if 'emotion' in r['schema']['properties']: a.setdefault('emotion',None)
  json.dump(a,open(f'{d}/answers/{k}.json','w'),ensure_ascii=False)
  print('ok',k)
