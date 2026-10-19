import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../src/search-svc/engine.js');
const { segment } = await import('../src/core/tokenize/tokenizer.js');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true, fileMustExist: true });
const PID='proj_d--agent1super';
const jarr=(v)=>{try{return v==null?[]:JSON.parse(String(v))}catch{return[]}};
const norm1=(s)=>s.trim().toLowerCase().replace(/\s+/g,' ');
const bn=(p)=>norm1(String(p).split(/[\\/]/).pop()??'');
const rows = db.prepare('SELECT id,title,topics,user_tags,files_mentioned FROM sessions WHERE project_id=? ORDER BY id').all(PID);
const metas = rows.map(r=>({id:r.id,title:r.title,tnorm:norm1(r.title??''),
 topics:[...new Set(jarr(r.topics).map(norm1).filter(x=>x.length>=2))],
 tags:[...new Set(jarr(r.user_tags).map(norm1))],
 files:[...new Set(jarr(r.files_mentioned).map(bn).filter(x=>x.length>=3))],
 toks:[...new Set(segment(r.title??'').map(norm1).filter(x=>x.length>=2))]}));
const N=metas.length; const SIGS=['topic','file','title','tag'];
const it=(m,s)=>s==='topic'?m.topics:s==='tag'?m.tags:s==='file'?m.files:m.toks;
const cap={topic:Math.floor(N*0.10),file:Math.floor(N*0.10),title:Math.floor(N*0.10),tag:Math.floor(N*0.03)};
const df={}; for(const s of SIGS) df[s]=new Map();
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
const out=[];
const byId=new Map(metas.map(m=>[m.id,m]));
const h32=(s)=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;};
function recallCheck(pairs,label){
 let okA=0,okB=0,okAny=0,n=0;
 for(const [a,b] of pairs){
  const ta=byId.get(a)?.title, tb=byId.get(b)?.title;
  if(!ta||!tb||ta.length<6||tb.length<6) continue; n++;
  let hA=[],hB=[];
  try{hA=searchSessions(db,{project:PID,query:ta,limit:10,rewrite:true,lengthNorm:true,coreOnly:true});}catch{}
  try{hB=searchSessions(db,{project:PID,query:tb,limit:10,rewrite:true,lengthNorm:true,coreOnly:true});}catch{}
  const inA=hA.some(x=>x.sessionId===b), inB=hB.some(x=>x.sessionId===a);
  if(inA)okA++; if(inB)okB++; if(inA||inB)okAny++;
 }
 out.push(label+' n='+n+' A→B '+(okA/n*100).toFixed(1)+'%  B→A '+(okB/n*100).toFixed(1)+'%  任一 '+(okAny/n*100).toFixed(1)+'%');
}
for(const MINW of [0.4,1.0,2.0]){
 const es=edges.filter(e=>e.w>=MINW);
 const pick=[]; const step=Math.max(1,Math.floor(es.length/120));
 for(let i=0;i<es.length&&pick.length<120;i+=step) pick.push([es[i].a,es[i].b]);
 recallCheck(pick,'一致率 w>='+MINW);
}
const rnd=[]; let s=12345; const nx=()=>{s=(s*1103515245+12345)&0x7fffffff; return s;};
for(let i=0;i<120;i++){rnd.push([metas[nx()%N].id, metas[nx()%N].id]);}
recallCheck(rnd.filter(([a,b])=>a!==b),'一致率 随机对');
const qs = JSON.parse(fs.readFileSync('scripts/bench-questions-paraphrase-v2.json','utf8')).items.filter(x=>x.arm==='X');
const ret=[]; for(const it2 of qs){let h=[];try{h=searchSessions(db,{project:PID,query:it2.query,limit:50,rewrite:true,lengthNorm:true,coreOnly:true});}catch{} ret.push(h.map(x=>({id:x.sessionId,score:x.score})));}
const per=new Map();
for(const e of edges){ if(e.w<0.4) continue; if(!per.has(e.a))per.set(e.a,[]); if(!per.has(e.b))per.set(e.b,[]); per.get(e.a).push(e.b); per.get(e.b).push(e.a);}
const adj=new Map(); for(const [k,l] of per) adj.set(k,new Set(l.slice(0,5)));
const baseR=qs.map((t,i)=>{const k=ret[i].findIndex(x=>x.id===t.target);return k>=0?k+1:0;});
const cntR=qs.map((t,i)=>{const ids=new Set(ret[i].map(x=>x.id)); const sc=ret[i].map(r=>{let c=0;const nb=adj.get(r.id); if(nb)for(const x of nb)if(ids.has(x))c++; return {id:r.id,s:r.score*(1+0.5*Math.min(2,c))};}).sort((a,b)=>b.s-a.s); const k=sc.findIndex(x=>x.id===t.target); return k>=0?k+1:0;});
const disc=baseR.map((b,i)=>[b===1,cntR[i]===1]);
const b01=disc.filter(([x,y])=>!x&&y).length, b10=disc.filter(([x,y])=>x&&!y).length;
const chi=(Math.abs(b01-b10)-1)**2/(b01+b10||1);
out.push('McNemar hit@1: base=1&cnt=0 → '+b10+' ; base=0&cnt=1 → '+b01+' ; chi2='+chi.toFixed(2)+' (p'+(chi>3.84?'<':'≥')+'0.05)');
let nbAbove=0,nbBelow=0,nbNone=0;
for(let i=0;i<qs.length;i++){const t=qs[i].target; const ti=ret[i].findIndex(x=>x.id===t); if(ti<0){nbNone++;continue;}
 const nb=adj.get(t); if(!nb||nb.size===0){nbNone++;continue;}
 const pos=[...nb].map(x=>ret[i].findIndex(y=>y.id===x)).filter(p=>p>=0);
 if(pos.length===0){nbNone++;continue;}
 if(Math.min(...pos)<ti) nbAbove++; else nbBelow++;}
out.push('目标有命中邻居时：邻居排得比目标前 '+nbAbove+' · 比目标后 '+nbBelow+' · 无命中邻居/目标不在池 '+nbNone);
fs.writeFileSync('scripts/_diag2.txt', out.join('\n'));
