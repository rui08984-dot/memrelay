import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../src/search-svc/engine.js');
const { segment } = await import('../src/core/tokenize/tokenizer.js');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true, fileMustExist: true });
const PID = 'proj_d--agent1super';
const jarr=(v)=>{try{return v==null?[]:JSON.parse(String(v))}catch{return[]}};
const norm1=(s)=>s.trim().toLowerCase().replace(/\s+/g,' ');
const bn=(p)=>norm1(String(p).split(/[\\/]/).pop()??'');
const rows = db.prepare('SELECT id,title,topics,user_tags,files_mentioned FROM sessions WHERE project_id=? ORDER BY id').all(PID);
const metas = rows.map(r=>({id:r.id,title:r.title,tnorm:norm1(r.title??''),
 topics:[...new Set(jarr(r.topics).map(norm1).filter(x=>x.length>=2))],
 tags:[...new Set(jarr(r.user_tags).map(norm1))],
 files:[...new Set(jarr(r.files_mentioned).map(bn).filter(x=>x.length>=3))],
 toks:[...new Set(segment(r.title??'').map(norm1).filter(x=>x.length>=2))]}));
const N=metas.length;
const SIGS=['topic','file','title','tag'];
const it=(m,s)=>s==='topic'?m.topics:s==='tag'?m.tags:s==='file'?m.files:m.toks;
const cap={topic:Math.floor(N*0.10),file:Math.floor(N*0.10),title:Math.floor(N*0.10),tag:Math.floor(N*0.03)};
const df={}; for(const s of SIGS){df[s]=new Map();}
for(const m of metas) for(const s of SIGS) for(const x of it(m,s)) df[s].set(x,(df[s].get(x)??0)+1);
const idf=(s,x)=>{const n=df[s].get(x)??0; return n<2||n>cap[s]?0:Math.log(1+N/n);};
const mass=new Map(); for(const m of metas){const r={}; for(const s of SIGS){let v=0;for(const x of it(m,s))v+=idf(s,x);r[s]=v;} mass.set(m.id,r);}
const ALPHA={topic:3,file:1.5,title:1,tag:1};
const edges=[];
for(let i=0;i<N;i++){const A=metas[i],ma=mass.get(A.id);
 for(let j=i+1;j<N;j++){const B=metas[j],mb=mass.get(B.id); let w=0,nsh=0;
  for(const s of SIGS){if(ma[s]<=0||mb[s]<=0)continue; const bs=new Set(it(B,s)); let acc=0;
   for(const x of it(A,s)){if(!bs.has(x))continue; const v=idf(s,x); if(v>0){acc+=v;nsh++;}}
   if(acc>0) w+=ALPHA[s]*acc/Math.sqrt(ma[s]*mb[s]);}
  if(w<=0||nsh<2)continue; edges.push({a:A.id,b:B.id,w});}}
const qs = JSON.parse(fs.readFileSync('scripts/bench-questions-paraphrase-v2.json','utf8')).items.filter(x=>x.arm==='X');
const ret=[]; for(const it2 of qs){let h=[];try{h=searchSessions(db,{project:PID,query:it2.query,limit:50,rewrite:true,lengthNorm:true,coreOnly:true});}catch{} ret.push(h.map(x=>({id:x.sessionId,score:x.score})));}
const out=[];
for(const MINW of [2.0,1.0,0.4]){
 const per=new Map(); for(const e of edges){if(e.w<MINW)continue; if(!per.has(e.a))per.set(e.a,[]); if(!per.has(e.b))per.set(e.b,[]); per.get(e.a).push(e.b); per.get(e.b).push(e.a);}
 let inT=0,inTop10=0,inTop3=0,none=0,linkedAny=0;
 for(let i=0;i<qs.length;i++){const t=qs[i].target; const nb=new Set(per.get(t)??[]);
  const top=ret[i]; const top10=new Set(top.slice(0,10).map(x=>x.id)); const top3=new Set(top.slice(0,3).map(x=>x.id));
  if(top.some(x=>x.id===t)) inT++;
  if([...nb].some(x=>top10.has(x)))inTop10++;
  if([...nb].some(x=>top3.has(x)))inTop3++;
  if(top.length===0) none++;
  if(top.some(x=>x.id!==t&&nb.has(x.id)))linkedAny++;}
 out.push('minW='+MINW+' edges='+edges.filter(e=>e.w>=MINW).length+' | 目标在top50 '+inT+' | 目标与top10有边 '+inTop10+' | 与top3有边 '+inTop3+' | 检索空 '+none+' | 有命中邻居 '+linkedAny);
}
fs.writeFileSync('scripts/_diag.txt', out.join('\n'));
