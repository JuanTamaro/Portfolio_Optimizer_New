import { useState, useMemo, useRef, useCallback } from "react";

// ─── DEFAULTS ───────────────────────────────────────────────
const INIT_ASSETS = [
  { id:"cash",name:"Cash",color:"#4A90A4",expectedReturn:3.5,annualizedVol:0,description:"T-Bills, Money Market",liquid:true },
  { id:"fixed_income",name:"Fixed Income",color:"#2E7D6B",expectedReturn:5,annualizedVol:5,description:"US Agg / IG Bonds",liquid:true },
  { id:"equity",name:"Equity",color:"#C75B39",expectedReturn:12,annualizedVol:16.5,description:"Global Equities",liquid:true },
  { id:"hedge_funds",name:"Hedge Funds",color:"#8B6DAF",expectedReturn:10,annualizedVol:6,description:"HFRI FW Composite",liquid:false },
  { id:"gold",name:"Oro",color:"#D4A843",expectedReturn:12,annualizedVol:24.5,description:"Oro físico + mineras",liquid:true },
  { id:"private_equity",name:"Private Equity",color:"#3D4F7C",expectedReturn:13.5,annualizedVol:15,description:"Cambridge (de-smoothed)",liquid:false },
  { id:"real_estate",name:"Real Estate",color:"#A0522D",expectedReturn:10,annualizedVol:6,description:"REITs / REOCs",liquid:false },
  { id:"bitcoin",name:"Bitcoin",color:"#F7931A",expectedReturn:20,annualizedVol:54,description:"BTC spot",liquid:true },
];
const INIT_CORR = [
  [1,.15,-.02,.05,0,-.02,-.05,0],[.15,1,.15,.1,-.1,.1,.2,-.05],[-.02,.15,1,.75,.15,.85,.65,.3],[.05,.1,.75,1,.2,.7,.5,.25],
  [0,-.1,.15,.2,1,.15,.1,.2],[-.02,.1,.85,.7,.15,1,.55,.2],[-.05,.2,.65,.5,.1,.55,1,.15],[0,-.05,.3,.25,.2,.2,.15,1],
];
const PALETTE=["#4A90A4","#2E7D6B","#C75B39","#8B6DAF","#D4A843","#3D4F7C","#A0522D","#F7931A","#E06C75","#56B6C2","#98C379","#C678DD","#BE5046","#61AFEF","#D19A66","#ABB2BF"];
let _id=100; const nid=()=>`a${_id++}`;
const SAVED_COLORS=["#58A6FF","#F97583","#B392F0","#FFAB70","#79B8FF","#85E89D","#F692CE","#DBEDFF"];

// ─── MATH ───────────────────────────────────────────────────
function pStats(w,assets,corr){
  const n=w.length;let ret=0;for(let i=0;i<n;i++)ret+=w[i]*assets[i].expectedReturn;
  let v=0;for(let i=0;i<n;i++)for(let j=0;j<n;j++)v+=w[i]*w[j]*assets[i].annualizedVol*assets[j].annualizedVol*corr[i][j]/10000;
  const vol=Math.sqrt(Math.max(0,v))*100;return{ret,vol,var5:ret-1.645*vol};
}
function pStatsLev(w,assets,corr,li,lr,bc){
  const aw=w.map((wi,i)=>i===li?wi*lr:wi),te=aw.reduce((a,b)=>a+b,0);
  let ret=0;for(let i=0;i<aw.length;i++)ret+=aw[i]*assets[i].expectedReturn;ret-=(te-1)*bc;
  let v=0;for(let i=0;i<aw.length;i++)for(let j=0;j<aw.length;j++)v+=aw[i]*aw[j]*assets[i].annualizedVol*assets[j].annualizedVol*corr[i][j]/10000;
  const vol=Math.sqrt(Math.max(0,v))*100;return{ret,vol,var5:ret-1.645*vol,totalExposure:te};
}
function genFrontier(assets,corr,cnt,cst){
  const pts=[],n=assets.length,{locked,maxIlliquid,active}=cst||{};
  const lk=locked?Object.keys(locked).map(Number):[],ls=lk.reduce((s,k)=>s+(locked[k]||0),0);
  const fi=Array.from({length:n},(_,i)=>i).filter(i=>!lk.includes(i));
  for(let k=0;k<cnt;k++){
    let w;
    if(active&&lk.length>0){const raw=fi.map(()=>Math.random()),rs=raw.reduce((a,b)=>a+b,0),ft=Math.max(0,(100-ls))/100;w=Array(n).fill(0);lk.forEach(i=>{w[i]=(locked[i]||0)/100});fi.forEach((f,r)=>{w[f]=(raw[r]/rs)*ft})}
    else{const raw=Array.from({length:n},()=>Math.random()),s=raw.reduce((a,b)=>a+b,0);w=raw.map(x=>x/s)}
    if(active&&maxIlliquid!=null){const il=assets.reduce((s,a,i)=>s+(a.liquid?0:w[i]*100),0);if(il>maxIlliquid)continue}
    const{ret,vol}=pStats(w,assets,corr);pts.push({ret,vol,weights:w});
  }
  const bk={};for(const p of pts){const b=Math.round(p.vol*2)/2;if(!bk[b]||p.ret>bk[b].ret)bk[b]=p}
  return{points:pts,frontier:Object.values(bk).sort((a,b)=>a.vol-b.vol)};
}
function calcERC(assets,corr,excl){
  const idx=assets.map((_,i)=>i).filter(i=>!excl.includes(i)),nn=idx.length;
  if(nn===0)return assets.map(()=>0);
  const vols=idx.map(i=>assets[i].annualizedVol/100),cm=idx.map(i=>idx.map(j=>corr[i][j]));
  let w=Array(nn).fill(1/nn);
  for(let it=0;it<300;it++){let tv=0;for(let i=0;i<nn;i++)for(let j=0;j<nn;j++)tv+=w[i]*w[j]*vols[i]*vols[j]*cm[i][j];
    const pv=Math.sqrt(Math.max(0,tv)),mrc=idx.map((_,i)=>{let s=0;for(let j=0;j<nn;j++)s+=w[j]*vols[i]*vols[j]*cm[i][j];return s/(pv+1e-12)});
    const rc=w.map((wi,i)=>wi*mrc[i]),tgt=pv/nn,nw=w.map((wi,i)=>wi*(tgt/(rc[i]+1e-12))),sw=nw.reduce((a,b)=>a+b,0);w=nw.map(wi=>wi/sw)}
  const full=Array(assets.length).fill(0);idx.forEach((ai,i)=>{full[ai]=w[i]});return full;
}

// ─── COMPONENT ──────────────────────────────────────────────
const NF=({value,onChange,color,width,step,min,max,disabled})=>(
  <input type="number" value={value} onChange={onChange} step={step||0.1} min={min} max={max} disabled={disabled}
    style={{width:width||56,padding:"4px 5px",background:disabled?"#21262D":"#0D1117",border:"1px solid #30363D",borderRadius:4,color:disabled?"#484F58":color||"#F0F6FC",fontSize:11,fontFamily:"'JetBrains Mono',monospace",textAlign:"right",outline:"none"}}
    onFocus={e=>e.target.style.borderColor="#58A6FF"} onBlur={e=>e.target.style.borderColor="#30363D"}/>
);

export default function App(){
  const[assets,setAssets]=useState(INIT_ASSETS.map(a=>({...a})));
  const[corr,setCorr]=useState(INIT_CORR.map(r=>[...r]));
  const[weights,setWeights]=useState([5,15,30,10,10,10,5,15]);
  const[tab,setTab]=useState("allocation");
  const[hov,setHov]=useState(null);
  const[mod,setMod]=useState(false);
  const[selPt,setSelPt]=useState(null);
  const[showF,setShowF]=useState(false);
  const[levOn,setLevOn]=useState(false);
  const[levIdx,setLevIdx]=useState(2);
  const[levR,setLevR]=useState(1.5);
  const[bc,setBc]=useState(5);
  const[locked,setLocked]=useState({});
  const[maxIll,setMaxIll]=useState(50);
  const[cstOn,setCstOn]=useState(false);
  // Saved portfolios
  const[saved,setSaved]=useState([]);
  const[saveName,setSaveName]=useState("");
  // Family office
  const[portfolioValue,setPortfolioValue]=useState(1000000);
  const[members,setMembers]=useState([
    {id:"padre",name:"Padre",weights:null,value:1000000,parentId:null,inheritPct:0},
  ]);
  const[activeMember,setActiveMember]=useState("padre");

  const svgRef=useRef(null);
  const n=assets.length;
  const tw=weights.reduce((a,b)=>a+b,0);
  const nw=weights.map(w=>w/(tw||1));

  // Active member
  const curMember=members.find(m=>m.id===activeMember)||members[0];

  // Stats
  const stats=useMemo(()=>{
    if(!levOn)return{...pStats(nw,assets,corr),totalExposure:1};
    return pStatsLev(nw,assets,corr,Math.min(levIdx,n-1),levR,bc);
  },[weights,assets,corr,levOn,levIdx,levR,bc]);

  const riskBudget=useMemo(()=>{
    const aw=levOn?nw.map((w,i)=>i===Math.min(levIdx,n-1)?w*levR:w):nw;
    let tv=0;for(let i=0;i<n;i++)for(let j=0;j<n;j++)tv+=aw[i]*aw[j]*assets[i].annualizedVol*assets[j].annualizedVol*corr[i][j]/10000;
    const pv=Math.sqrt(Math.max(0,tv));
    return assets.map((ac,i)=>{let mrc=0;for(let j=0;j<n;j++)mrc+=aw[j]*ac.annualizedVol*assets[j].annualizedVol*corr[i][j]/10000;mrc=mrc/(pv+1e-12);const rc=aw[i]*mrc;return{...ac,idx:i,mrc,rc,pctRisk:(rc/(pv+1e-12))*100,weight:nw[i]*100,adjW:aw[i]*100}});
  },[weights,assets,corr,levOn,levIdx,levR]);

  const ercExcl=useMemo(()=>assets.map((a,i)=>a.annualizedVol<=0.01?i:-1).filter(i=>i>=0),[assets]);
  const ercW=useMemo(()=>calcERC(assets,corr,ercExcl),[assets,corr,ercExcl]);
  const ercStats=useMemo(()=>pStats(ercW,assets,corr),[ercW,assets,corr]);
  const fCst=useMemo(()=>cstOn?{locked,maxIlliquid:maxIll,active:true}:{active:false},[cstOn,locked,maxIll]);
  const frontier=useMemo(()=>showF?genFrontier(assets,corr,cstOn?20000:10000,fCst):null,[showF,assets,corr,fCst]);
  const illPct=useMemo(()=>assets.reduce((s,a,i)=>s+(a.liquid?0:nw[i]*100),0),[assets,weights]);
  const liqPct=100-illPct;

  // Saved portfolio stats
  const savedStats=useMemo(()=>saved.map(s=>{const sw=s.weights.map(w=>w/100);return{...s,...pStats(sw,assets,corr)}}),[saved,assets,corr]);

  // ─── Family: compute consolidated weights for a member ────
  const getMemberTotal=useCallback((memberId)=>{
    const m=members.find(x=>x.id===memberId);if(!m)return{weights:Array(n).fill(0),value:0};
    const ownW=m.weights||weights;
    const ownVal=m.value||0;
    if(!m.parentId)return{weights:ownW,value:ownVal};
    const parent=members.find(x=>x.id===m.parentId);
    if(!parent)return{weights:ownW,value:ownVal};
    const parentW=parent.weights||weights;
    const parentVal=parent.value||0;
    const inhVal=parentVal*(m.inheritPct/100);
    const totalVal=ownVal+inhVal;
    if(totalVal<=0)return{weights:ownW,value:0};
    // Consolidated: (ownW * ownVal + parentW * inhVal) / totalVal
    const consW=assets.map((_,i)=>{
      const ownAlloc=(ownW[i]||0)/100*ownVal;
      const inhAlloc=(parentW[i]||0)/100*inhVal;
      return((ownAlloc+inhAlloc)/totalVal)*100;
    });
    return{weights:consW,value:totalVal};
  },[members,weights,assets,n]);

  // ─── HANDLERS ─────────────────────────────────────────────
  const setW=(idx,val)=>{const nws=[...weights];nws[idx]=Math.max(0,Math.min(100,Number(val)));setWeights(nws)};
  const updAsset=(idx,f,val)=>{setAssets(p=>p.map((a,i)=>i===idx?{...a,[f]:typeof val==='boolean'?val:Number(val)}:a));setMod(true);setShowF(false)};
  const updCorr=(i,j,val)=>{const v=Math.max(-1,Math.min(1,Number(val)));setCorr(p=>{const nc=p.map(r=>[...r]);nc[i][j]=v;nc[j][i]=v;return nc});setMod(true);setShowF(false)};
  const resetAll=()=>{setAssets(INIT_ASSETS.map(a=>({...a})));setCorr(INIT_CORR.map(r=>[...r]));setWeights([5,15,30,10,10,10,5,15]);setMod(false);setShowF(false);setLocked({})};
  const addAsset=()=>{const ci=assets.length%PALETTE.length;setAssets(p=>[...p,{id:nid(),name:"New Asset",color:PALETTE[ci],expectedReturn:8,annualizedVol:15,description:"Custom",liquid:true}]);setWeights(p=>[...p,5]);setCorr(p=>{const nn=p.length+1,nc=p.map(r=>[...r,.1]);nc.push(Array(nn).fill(.1));nc[nn-1][nn-1]=1;return nc});
    // extend saved portfolios and members weights
    setSaved(p=>p.map(s=>({...s,weights:[...s.weights,0]})));
    setMembers(p=>p.map(m=>m.weights?{...m,weights:[...m.weights,0]}:m));
  };
  const removeAsset=(idx)=>{if(assets.length<=2)return;setAssets(p=>p.filter((_,i)=>i!==idx));setWeights(p=>p.filter((_,i)=>i!==idx));setCorr(p=>p.filter((_,i)=>i!==idx).map(r=>r.filter((_,j)=>j!==idx)));
    setLocked(p=>{const nl={};Object.keys(p).forEach(k=>{const ki=+k;if(ki<idx)nl[ki]=p[k];else if(ki>idx)nl[ki-1]=p[k]});return nl});
    setSaved(p=>p.map(s=>({...s,weights:s.weights.filter((_,i)=>i!==idx)})));
    setMembers(p=>p.map(m=>m.weights?{...m,weights:m.weights.filter((_,i)=>i!==idx)}:m));
    if(levIdx>=idx&&levIdx>0)setLevIdx(p=>Math.max(0,p-(idx<=p?1:0)));setShowF(false)};
  const applyERC=()=>setWeights(ercW.map(w=>Math.round(w*1000)/10));
  const toggleLock=idx=>{setLocked(p=>{const nl={...p};if(nl[idx]!==undefined)delete nl[idx];else nl[idx]=weights[idx];return nl});setShowF(false)};
  const toggleCst=v=>{setCstOn(v);setShowF(false)};

  // Save portfolio
  const savePortfolio=()=>{
    const name=saveName.trim()||`Portfolio ${saved.length+1}`;
    setSaved(p=>[...p,{id:`sp_${Date.now()}`,name,weights:[...weights],color:SAVED_COLORS[p.length%SAVED_COLORS.length]}]);
    setSaveName("");
  };
  const removeSaved=id=>setSaved(p=>p.filter(s=>s.id!==id));
  const loadSaved=s=>setWeights([...s.weights]);

  // Family
  const addMember=(parentId)=>{
    const id=`m_${Date.now()}`;
    setMembers(p=>[...p,{id,name:"Hijo "+(p.length),weights:Array(n).fill(0),value:500000,parentId:parentId||null,inheritPct:parentId?50:0}]);
  };
  const updMember=(id,field,val)=>setMembers(p=>p.map(m=>m.id===id?{...m,[field]:val}:m));
  const removeMember=id=>{if(members.length<=1)return;setMembers(p=>p.filter(m=>m.id!==id).map(m=>m.parentId===id?{...m,parentId:null,inheritPct:0}:m));if(activeMember===id)setActiveMember(members[0].id)};
  const saveMemberWeights=()=>setMembers(p=>p.map(m=>m.id===activeMember?{...m,weights:[...weights],value:portfolioValue}:m));

  // Frontier click
  const handleFC=e=>{if(!frontier||!svgRef.current)return;const rect=svgRef.current.getBoundingClientRect(),sx=700/rect.width,sy=400/rect.height;
    const cx=(e.clientX-rect.left)*sx,cy=(e.clientY-rect.top)*sy,cv=((cx-60)/620)*30,cr=((370-cy)/340)*22;
    if(cv<0||cv>30||cr<0||cr>22)return;let best=null,bd=Infinity;
    for(const p of frontier.frontier){const d=Math.sqrt(((p.vol-cv)/30)**2+((p.ret-cr)/22)**2);if(d<bd){bd=d;best=p}}
    if(best&&bd<.08){setSelPt(best);setWeights(best.weights.map(w=>Math.round(w*1000)/10))}};

  // Styles
  const box={background:"#161B22",border:"1px solid #21262D",borderRadius:10,padding:20};
  const micro={fontSize:10,color:"#484F58",fontFamily:"'JetBrains Mono',monospace",textTransform:"uppercase",letterSpacing:1};
  const pill=(active)=>({padding:"7px 14px",fontSize:11,fontFamily:"'JetBrains Mono',monospace",fontWeight:active?600:400,color:active?"#F0F6FC":"#6E7681",background:active?"#21262D":"transparent",border:`1px solid ${active?"#30363D":"transparent"}`,borderRadius:6,cursor:"pointer"});
  const fmt=v=>v>=1e6?`$${(v/1e6).toFixed(1)}M`:v>=1e3?`$${(v/1e3).toFixed(0)}K`:`$${v}`;

  return(
    <div style={{fontFamily:"'DM Sans','Helvetica Neue',sans-serif",background:"linear-gradient(145deg,#0D1117,#161B22,#0D1117)",color:"#C9D1D9",minHeight:"100vh",padding:24}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      <div style={{maxWidth:1100,margin:"0 auto"}}>
        {/* HEADER */}
        <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:4,flexWrap:"wrap"}}>
          <h1 style={{fontFamily:"'JetBrains Mono',monospace",fontSize:22,fontWeight:700,color:"#F0F6FC",margin:0}}>Portfolio Optimizer</h1>
          <span style={{fontSize:11,color:"#484F58",fontFamily:"'JetBrains Mono',monospace"}}>v4.0 — Family Office</span>
          {mod&&<span style={{fontSize:10,color:"#D29922",background:"#2D2200",padding:"2px 8px",borderRadius:4,fontFamily:"'JetBrains Mono',monospace"}}>● modified</span>}
          {levOn&&<span style={{fontSize:10,color:"#F85149",background:"#3D1117",padding:"2px 8px",borderRadius:4,fontFamily:"'JetBrains Mono',monospace"}}>⚡{levR}x {assets[Math.min(levIdx,n-1)]?.name}</span>}
          {cstOn&&<span style={{fontSize:10,color:"#58A6FF",background:"#0D2240",padding:"2px 8px",borderRadius:4,fontFamily:"'JetBrains Mono',monospace"}}>🔒 constraints</span>}
        </div>
        <p style={{fontSize:13,color:"#6E7681",margin:"4px 0 20px"}}>Dynamic assets, constraints, saved portfolios, family office inheritance.</p>

        {/* TABS */}
        <div style={{display:"flex",gap:2,marginBottom:20,flexWrap:"wrap"}}>
          {[{id:"allocation",l:"Allocation"},{id:"saved",l:"📁 Portfolios"},{id:"family",l:"👨‍👧 Family Office"},{id:"constraints",l:"🔒 Constraints"},{id:"risk",l:"Risk Budget"},{id:"frontier",l:"Frontier"},{id:"leverage",l:"⚡ Leverage"},{id:"data",l:"⚙ Assumptions"}].map(t=>(
            <button key={t.id} onClick={()=>{setTab(t.id);if(t.id==="frontier")setShowF(true)}} style={pill(tab===t.id)}>{t.l}</button>
          ))}
        </div>

        {/* STATS */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8,marginBottom:20}}>
          {[{l:"E[Return]",v:`${stats.ret.toFixed(1)}%`,c:"#3FB950"},{l:"Vol",v:`${stats.vol.toFixed(1)}%`,c:"#D29922"},{l:"VaR 5%",v:`${stats.var5.toFixed(1)}%`,c:stats.var5<0?"#F85149":"#3FB950"},{l:"Sharpe(rf=3.5%)",v:((stats.ret-3.5)/(stats.vol+1e-12)).toFixed(2),c:"#58A6FF"},{l:"Liquid",v:`${liqPct.toFixed(0)}%`,c:liqPct>=(100-maxIll)?"#3FB950":"#F85149"},{l:"Value",v:fmt(portfolioValue),c:"#8B949E"}].map(s=>(
            <div key={s.l} style={{background:"#161B22",border:"1px solid #21262D",borderRadius:8,padding:"12px 10px"}}>
              <div style={{...micro,marginBottom:4,fontSize:9}}>{s.l}</div>
              <div style={{fontSize:17,fontWeight:700,color:s.c,fontFamily:"'JetBrains Mono',monospace"}}>{s.v}</div>
            </div>
          ))}
        </div>

        {/* ═══ ALLOCATION ═══ */}
        {tab==="allocation"&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 300px",gap:20}}>
            <div style={box}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <h3 style={{margin:0,fontSize:14,fontWeight:600,color:"#F0F6FC"}}>Asset Weights</h3>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {cstOn&&illPct>maxIll&&<span style={{fontSize:10,color:"#F85149",fontFamily:"'JetBrains Mono',monospace"}}>⚠ Illiq {illPct.toFixed(0)}%&gt;{maxIll}%</span>}
                  <span style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:Math.abs(tw-100)<.5?"#3FB950":"#F85149"}}>Σ{tw.toFixed(1)}%</span>
                </div>
              </div>
              {assets.map((ac,i)=>(
                <div key={ac.id} style={{marginBottom:11}} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:10,height:10,borderRadius:3,background:ac.color}}/>
                      <span style={{fontSize:12,fontWeight:500,color:hov===i?"#F0F6FC":"#C9D1D9"}}>{ac.name}</span>
                      {!ac.liquid&&<span style={{fontSize:8,color:"#D29922",background:"#2D2200",padding:"1px 4px",borderRadius:3}}>ILL</span>}
                      {locked[i]!==undefined&&<span style={{fontSize:8,color:"#58A6FF",background:"#0D2240",padding:"1px 4px",borderRadius:3}}>🔒</span>}
                    </div>
                    <input type="number" value={weights[i]} onChange={e=>setW(i,e.target.value)} disabled={locked[i]!==undefined}
                      style={{width:50,padding:"3px 5px",background:locked[i]!==undefined?"#21262D":"#0D1117",border:"1px solid #30363D",borderRadius:4,color:locked[i]!==undefined?"#484F58":"#F0F6FC",fontSize:11,fontFamily:"'JetBrains Mono',monospace",textAlign:"right"}}/>
                  </div>
                  <input type="range" min="0" max="60" step=".5" value={weights[i]} onChange={e=>setW(i,e.target.value)} disabled={locked[i]!==undefined}
                    style={{width:"100%",height:4,appearance:"none",background:`linear-gradient(to right,${ac.color} ${(weights[i]/60)*100}%,#21262D ${(weights[i]/60)*100}%)`,borderRadius:2,outline:"none",cursor:locked[i]!==undefined?"not-allowed":"pointer",opacity:locked[i]!==undefined?.5:1}}/>
                </div>
              ))}
              <div style={{marginTop:14,paddingTop:12,borderTop:"1px solid #21262D",display:"flex",flexWrap:"wrap",gap:6}}>
                <button onClick={()=>setWeights(Array(n).fill(+(100/n).toFixed(1)))} style={{padding:"5px 10px",fontSize:11,background:"#21262D",border:"1px solid #30363D",borderRadius:5,color:"#C9D1D9",cursor:"pointer"}}>Equal Weight</button>
                <button onClick={applyERC} style={{padding:"5px 10px",fontSize:11,background:"#1F3A2D",border:"1px solid #238636",borderRadius:5,color:"#3FB950",cursor:"pointer",fontWeight:600}}>ERC (ex zero-vol)</button>
              </div>
              {/* Portfolio value */}
              <div style={{marginTop:14,paddingTop:12,borderTop:"1px solid #21262D",display:"flex",alignItems:"center",gap:12}}>
                <span style={{...micro}}>Portfolio Value $</span>
                <NF value={portfolioValue} onChange={e=>setPortfolioValue(Number(e.target.value))} width={100} step={10000} color="#8B949E"/>
              </div>
            </div>
            {/* PIE + liquidity */}
            <div style={{...box,display:"flex",flexDirection:"column",alignItems:"center"}}>
              <h3 style={{margin:"0 0 10px",fontSize:14,fontWeight:600,color:"#F0F6FC",alignSelf:"flex-start"}}>Allocation</h3>
              <svg viewBox="0 0 200 200" style={{width:190,height:190}}>
                {(()=>{let cum=-90;return assets.map((ac,i)=>{const pct=nw[i]*100;if(pct<.5)return null;const angle=(pct/100)*360,s=cum;cum+=angle;const sr=s*Math.PI/180,er=cum*Math.PI/180;return<path key={ac.id} d={`M 100 100 L ${100+85*Math.cos(sr)} ${100+85*Math.sin(sr)} A 85 85 0 ${angle>180?1:0} 1 ${100+85*Math.cos(er)} ${100+85*Math.sin(er)} Z`} fill={ac.color} stroke="#161B22" strokeWidth="1.5" opacity={hov===null||hov===i?1:.35} style={{transition:"opacity 0.2s"}}/>})})()}
                <circle cx="100" cy="100" r="38" fill="#161B22"/><text x="100" y="96" textAnchor="middle" fill="#F0F6FC" fontSize="15" fontWeight="700" fontFamily="JetBrains Mono">{stats.ret.toFixed(1)}%</text><text x="100" y="110" textAnchor="middle" fill="#6E7681" fontSize="7" fontFamily="JetBrains Mono">E[Return]</text>
              </svg>
              <div style={{marginTop:10,width:"100%"}}>
                {assets.map((ac,i)=>{const pct=nw[i]*100;if(pct<.3)return null;return(
                  <div key={ac.id} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",opacity:hov===null||hov===i?1:.4}} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)}>
                    <div style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:7,height:7,borderRadius:2,background:ac.color}}/><span style={{fontSize:10}}>{ac.name}</span></div>
                    <span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"#8B949E"}}>{pct.toFixed(1)}%</span>
                  </div>)})}
              </div>
              <div style={{width:"100%",marginTop:12,paddingTop:10,borderTop:"1px solid #21262D"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <span style={{fontSize:9,color:"#3FB950"}}>Líquido {liqPct.toFixed(0)}%</span><span style={{fontSize:9,color:"#D29922"}}>Ilíquido {illPct.toFixed(0)}%</span>
                </div>
                <div style={{height:5,background:"#21262D",borderRadius:3,overflow:"hidden",display:"flex"}}><div style={{width:`${liqPct}%`,background:"#3FB950",transition:"width .3s"}}/><div style={{width:`${illPct}%`,background:"#D29922",transition:"width .3s"}}/></div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ SAVED PORTFOLIOS ═══ */}
        {tab==="saved"&&(
          <div style={box}>
            <h3 style={{margin:"0 0 12px",fontSize:14,fontWeight:600,color:"#F0F6FC"}}>📁 Portfolios Guardados</h3>
            <div style={{display:"flex",gap:8,marginBottom:16,alignItems:"center"}}>
              <input value={saveName} onChange={e=>setSaveName(e.target.value)} placeholder="Nombre del portfolio..." style={{flex:1,padding:"6px 10px",background:"#0D1117",border:"1px solid #30363D",borderRadius:5,color:"#F0F6FC",fontSize:12,outline:"none"}} onKeyDown={e=>e.key==="Enter"&&savePortfolio()}/>
              <button onClick={savePortfolio} style={{padding:"6px 14px",fontSize:12,background:"#1F3A2D",border:"1px solid #238636",borderRadius:5,color:"#3FB950",cursor:"pointer",fontWeight:600,whiteSpace:"nowrap"}}>+ Guardar Actual</button>
            </div>
            {saved.length===0&&<p style={{fontSize:12,color:"#484F58",margin:0}}>No hay portfolios guardados. Ajustá los weights y guardá con el botón de arriba.</p>}
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {savedStats.map(s=>(
                <div key={s.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:"#0D1117",border:"1px solid #21262D",borderRadius:8}}>
                  <div style={{width:10,height:10,borderRadius:5,background:s.color,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:600,color:"#F0F6FC"}}>{s.name}</div>
                    <div style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"#6E7681",marginTop:2}}>
                      E[R]:{s.ret.toFixed(1)}% | Vol:{s.vol.toFixed(1)}% | VaR5:{s.var5.toFixed(1)}% | Sharpe:{((s.ret-3.5)/(s.vol+1e-12)).toFixed(2)}
                    </div>
                    <div style={{fontSize:9,color:"#484F58",marginTop:2}}>{assets.map((ac,i)=>s.weights[i]>1?`${ac.name.slice(0,4)}:${s.weights[i].toFixed(0)}%`:null).filter(Boolean).join(" · ")}</div>
                  </div>
                  <button onClick={()=>loadSaved(s)} style={{padding:"4px 10px",fontSize:10,background:"#21262D",border:"1px solid #30363D",borderRadius:4,color:"#C9D1D9",cursor:"pointer"}}>Cargar</button>
                  <button onClick={()=>removeSaved(s.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#F85149",fontSize:16}}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══ FAMILY OFFICE ═══ */}
        {tab==="family"&&(
          <div style={{display:"flex",flexDirection:"column",gap:20}}>
            <div style={box}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <h3 style={{margin:0,fontSize:14,fontWeight:600,color:"#F0F6FC"}}>👨‍👧 Family Office — Miembros</h3>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>addMember(null)} style={{padding:"4px 12px",fontSize:11,background:"#21262D",border:"1px solid #30363D",borderRadius:5,color:"#C9D1D9",cursor:"pointer"}}>+ Miembro Raíz</button>
                  <button onClick={()=>addMember(activeMember)} style={{padding:"4px 12px",fontSize:11,background:"#0D2240",border:"1px solid #58A6FF",borderRadius:5,color:"#58A6FF",cursor:"pointer"}}>+ Hijo de {curMember?.name}</button>
                </div>
              </div>
              <p style={{fontSize:12,color:"#6E7681",margin:"0 0 14px",lineHeight:1.6}}>
                Cada miembro tiene su propio portfolio y valor. Un hijo hereda un % del padre: su portfolio consolidado = propio + herencia.
                Modificar el padre actualiza automáticamente el consolidado del hijo. El hijo no puede tener menos que lo heredado en cada asset.
              </p>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {members.map(m=>{
                  const parent=m.parentId?members.find(x=>x.id===m.parentId):null;
                  const cons=getMemberTotal(m.id);
                  const consStats=pStats(cons.weights.map(w=>w/100),assets,corr);
                  const isActive=activeMember===m.id;
                  return(
                    <div key={m.id} style={{padding:"12px 16px",background:isActive?"#0D2240":"#0D1117",border:`1px solid ${isActive?"#58A6FF":"#21262D"}`,borderRadius:8,cursor:"pointer"}} onClick={()=>setActiveMember(m.id)}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <input value={m.name} onChange={e=>updMember(m.id,"name",e.target.value)} onClick={e=>e.stopPropagation()}
                            style={{background:"transparent",border:"none",color:"#F0F6FC",fontSize:13,fontWeight:600,outline:"none",width:120}}/>
                          {parent&&<span style={{fontSize:9,color:"#58A6FF",background:"#0D2240",padding:"1px 6px",borderRadius:3}}>hijo de {parent.name} ({m.inheritPct}%)</span>}
                          {!parent&&!m.parentId&&<span style={{fontSize:9,color:"#8B949E",background:"#21262D",padding:"1px 6px",borderRadius:3}}>raíz</span>}
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          {members.length>1&&<button onClick={e=>{e.stopPropagation();removeMember(m.id)}} style={{background:"none",border:"none",cursor:"pointer",color:"#F85149",fontSize:14}}>×</button>}
                        </div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:8}}>
                        <div><div style={{fontSize:9,color:"#484F58"}}>Valor Propio</div>
                          <NF value={m.value} onChange={e=>{e.stopPropagation();updMember(m.id,"value",Number(e.target.value))}} width={90} step={10000} color="#8B949E"/>
                        </div>
                        {parent&&<div><div style={{fontSize:9,color:"#484F58"}}>% Herencia</div>
                          <NF value={m.inheritPct} onChange={e=>{e.stopPropagation();updMember(m.id,"inheritPct",Math.max(0,Math.min(100,Number(e.target.value))))}} width={60} step={5} color="#58A6FF" min={0} max={100}/>
                        </div>}
                        <div><div style={{fontSize:9,color:"#484F58"}}>Valor Total</div>
                          <div style={{fontSize:13,fontWeight:700,color:"#F0F6FC",fontFamily:"'JetBrains Mono',monospace"}}>{fmt(cons.value)}</div>
                        </div>
                        <div><div style={{fontSize:9,color:"#484F58"}}>E[R] | Vol</div>
                          <div style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace"}}><span style={{color:"#3FB950"}}>{consStats.ret.toFixed(1)}%</span> <span style={{color:"#484F58"}}>|</span> <span style={{color:"#D29922"}}>{consStats.vol.toFixed(1)}%</span></div>
                        </div>
                      </div>
                      {/* Mini bar of consolidated weights */}
                      <div style={{display:"flex",height:6,borderRadius:3,overflow:"hidden"}}>
                        {assets.map((ac,i)=>{const pct=cons.weights[i];return pct>.3?<div key={ac.id} style={{width:`${pct}%`,background:ac.color,transition:"width .3s"}}/>:null})}
                      </div>
                      {isActive&&(
                        <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #21262D"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                            <span style={{fontSize:11,color:"#58A6FF",fontWeight:600}}>Editando: {m.name}</span>
                            <button onClick={e=>{e.stopPropagation();saveMemberWeights()}} style={{padding:"4px 10px",fontSize:10,background:"#1F3A2D",border:"1px solid #238636",borderRadius:4,color:"#3FB950",cursor:"pointer",fontWeight:600}}>
                              💾 Guardar weights actuales a este miembro
                            </button>
                          </div>
                          {m.weights&&(
                            <div style={{fontSize:10,color:"#6E7681"}}>
                              Weights propios: {assets.map((ac,i)=>(m.weights[i]||0)>0.5?`${ac.name.slice(0,4)}:${(m.weights[i]||0).toFixed(0)}%`:null).filter(Boolean).join(" · ")}
                            </div>
                          )}
                          {parent&&m.weights&&(
                            <div style={{fontSize:10,color:"#484F58",marginTop:4}}>
                              Herencia ({m.inheritPct}% de {parent.name}): {assets.map((ac,i)=>{const pw=parent.weights||weights;const inh=(pw[i]||0)*m.inheritPct/100;return inh>0.5?`${ac.name.slice(0,4)}:${inh.toFixed(0)}%`:null}).filter(Boolean).join(" · ")}
                            </div>
                          )}
                          {parent&&(
                            <div style={{marginTop:6,padding:8,background:"#161B22",borderRadius:6,fontSize:10,color:"#D29922"}}>
                              ⚠ El hijo no puede tener menos del {m.inheritPct}% de lo que tiene {parent.name} en cada asset.
                              {m.weights&&assets.map((ac,i)=>{const pw=parent.weights||weights;const minW=(pw[i]||0)*m.inheritPct/100;const ownW=m.weights[i]||0;return ownW<minW?<span key={i} style={{display:"block",color:"#F85149"}}>{ac.name}: tiene {ownW.toFixed(1)}%, mínimo {minW.toFixed(1)}%</span>:null})}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* ═══ CONSTRAINTS ═══ */}
        {tab==="constraints"&&(
          <div style={box}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <h3 style={{margin:0,fontSize:14,fontWeight:600,color:"#F0F6FC"}}>Constraints</h3>
              <button onClick={()=>toggleCst(!cstOn)} style={{padding:"6px 14px",fontSize:11,fontFamily:"'JetBrains Mono',monospace",background:cstOn?"#0D2240":"#21262D",border:`1px solid ${cstOn?"#58A6FF":"#30363D"}`,color:cstOn?"#58A6FF":"#C9D1D9",borderRadius:6,cursor:"pointer",fontWeight:600}}>{cstOn?"ON":"Activar"}</button>
            </div>
            <div style={{marginBottom:20}}>
              <div style={{...micro,marginBottom:8}}>Fijar Assets</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
                {assets.map((ac,i)=>(
                  <div key={ac.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:locked[i]!==undefined?"#0D2240":"#0D1117",border:`1px solid ${locked[i]!==undefined?"#58A6FF":"#21262D"}`,borderRadius:6}}>
                    <button onClick={()=>toggleLock(i)} style={{background:"none",border:"none",cursor:"pointer",fontSize:14,padding:0}}>{locked[i]!==undefined?"🔒":"🔓"}</button>
                    <div style={{width:8,height:8,borderRadius:2,background:ac.color}}/><span style={{fontSize:11,flex:1}}>{ac.name}</span>
                    {locked[i]!==undefined?<NF value={locked[i]} width={48} onChange={e=>{const v=Math.max(0,Math.min(100,+e.target.value));setLocked(p=>({...p,[i]:v}));setW(i,v)}} color="#58A6FF"/>:<span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"#484F58"}}>{weights[i].toFixed(1)}%</span>}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div style={{...micro,marginBottom:8}}>Liquidez (Max Ilíquido: {maxIll}%)</div>
              <input type="range" min="0" max="100" step="5" value={maxIll} onChange={e=>{setMaxIll(+e.target.value);setShowF(false)}} style={{width:"100%",marginBottom:8}}/>
              <div style={{display:"flex",gap:16,padding:"12px",background:"#0D1117",borderRadius:8,border:"1px solid #21262D"}}>
                <div><div style={{fontSize:9,color:"#484F58"}}>Ilíquido</div><div style={{fontSize:16,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:cstOn&&illPct>maxIll?"#F85149":"#D29922"}}>{illPct.toFixed(1)}%</div></div>
                <div><div style={{fontSize:9,color:"#484F58"}}>Líquido</div><div style={{fontSize:16,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#3FB950"}}>{liqPct.toFixed(1)}%</div></div>
                <div><div style={{fontSize:9,color:"#484F58"}}>Status</div><div style={{fontSize:16,fontWeight:700,color:!cstOn?"#484F58":illPct<=maxIll?"#3FB950":"#F85149"}}>{!cstOn?"OFF":illPct<=maxIll?"✓":"✗"}</div></div>
              </div>
              <div style={{marginTop:12,display:"flex",flexWrap:"wrap",gap:6}}>
                {assets.map((ac,i)=>(<button key={ac.id} onClick={()=>updAsset(i,"liquid",!ac.liquid)} style={{padding:"4px 8px",fontSize:10,background:ac.liquid?"#1F3A2D":"#2D2200",border:`1px solid ${ac.liquid?"#238636":"#D29922"}`,borderRadius:4,color:ac.liquid?"#3FB950":"#D29922",cursor:"pointer"}}><span style={{display:"inline-block",width:6,height:6,borderRadius:2,background:ac.color,marginRight:4}}/>{ac.name}:{ac.liquid?"LIQ":"ILL"}</button>))}
              </div>
            </div>
          </div>
        )}

        {/* ═══ RISK ═══ */}
        {tab==="risk"&&(
          <div style={box}>
            <h3 style={{margin:"0 0 10px",fontSize:14,fontWeight:600,color:"#F0F6FC"}}>Risk Budget</h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
              <div>{riskBudget.filter(r=>r.weight>.3).sort((a,b)=>b.pctRisk-a.pctRisk).map(rb=>(
                <div key={rb.id} style={{marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}><span style={{fontSize:11}}>{rb.name}</span><span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:600,color:rb.pctRisk>rb.weight*1.5?"#F85149":rb.pctRisk<rb.weight*.5?"#3FB950":"#D29922"}}>risk:{rb.pctRisk.toFixed(1)}%</span></div>
                  <div style={{height:5,background:"#21262D",borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.min(100,Math.max(0,rb.pctRisk))}%`,background:rb.color,borderRadius:3,transition:"width .3s"}}/></div>
                </div>))}</div>
              <div>
                <div style={{...micro,marginBottom:8}}>ERC Optimal (ex zero-vol)</div>
                {assets.map((ac,i)=>ercW[i]>.005?<div key={ac.id} style={{display:"flex",justifyContent:"space-between",padding:"2px 0"}}><span style={{fontSize:11}}>{ac.name}</span><span style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"#3FB950"}}>{(ercW[i]*100).toFixed(1)}%</span></div>:null)}
                <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #21262D",fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"#58A6FF"}}>E[R]:{ercStats.ret.toFixed(1)}% | Vol:{ercStats.vol.toFixed(1)}%</div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ FRONTIER ═══ */}
        {tab==="frontier"&&(
          <div style={box}>
            <h3 style={{margin:"0 0 4px",fontSize:14,fontWeight:600,color:"#F0F6FC"}}>Frontier — Clickeá para seleccionar</h3>
            {cstOn&&<p style={{fontSize:10,color:"#58A6FF",margin:"0 0 8px"}}>🔒 Constraints activos: portfolios respetan locks y max ilíquido.</p>}
            {selPt&&(
              <div style={{display:"flex",gap:10,padding:"6px 12px",background:"#0D1117",borderRadius:6,border:"1px solid #58A6FF",margin:"6px 0 10px",flexWrap:"wrap",alignItems:"center"}}>
                <span style={{fontSize:11,color:"#58A6FF",fontWeight:600}}>Selected:</span>
                <span style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"#3FB950"}}>Ret {selPt.ret.toFixed(1)}%</span>
                <span style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"#D29922"}}>Vol {selPt.vol.toFixed(1)}%</span>
                <span style={{fontSize:9,fontFamily:"'JetBrains Mono',monospace",color:"#8B949E"}}>{assets.map((ac,i)=>selPt.weights[i]>.03?`${ac.name.slice(0,5)}:${(selPt.weights[i]*100).toFixed(0)}%`:null).filter(Boolean).join(" · ")}</span>
              </div>
            )}
            {frontier&&(
              <svg ref={svgRef} viewBox="0 0 700 400" style={{width:"100%",background:"#0D1117",borderRadius:8,border:"1px solid #21262D",cursor:"crosshair"}} onClick={handleFC}>
                {[0,2,4,6,8,10,12,14,16,18,20,22].map(v=>{const y=370-(v/22)*340;return<g key={`y${v}`}><line x1="60" y1={y} x2="680" y2={y} stroke="#21262D" strokeWidth=".5"/><text x="52" y={y+4} textAnchor="end" fill="#484F58" fontSize="8" fontFamily="JetBrains Mono">{v}%</text></g>})}
                {[0,5,10,15,20,25,30].map(v=>{const x=60+(v/30)*620;return<g key={`x${v}`}><line x1={x} y1="30" x2={x} y2="370" stroke="#21262D" strokeWidth=".5"/><text x={x} y="386" textAnchor="middle" fill="#484F58" fontSize="8" fontFamily="JetBrains Mono">{v}%</text></g>})}
                <text x="370" y="399" textAnchor="middle" fill="#6E7681" fontSize="9" fontFamily="JetBrains Mono">Volatility</text>
                <text x="12" y="200" textAnchor="middle" fill="#6E7681" fontSize="9" fontFamily="JetBrains Mono" transform="rotate(-90,12,200)">Return</text>
                {frontier.points.map((p,i)=>{const x=60+(p.vol/30)*620,y=370-(p.ret/22)*340;return(x>=60&&x<=680&&y>=30&&y<=370)?<circle key={i} cx={x} cy={y} r="1.2" fill="#30363D" opacity=".2"/>:null})}
                {frontier.frontier.length>2&&<polyline points={frontier.frontier.filter(p=>p.vol<=30&&p.ret<=22).map(p=>`${60+(p.vol/30)*620},${370-(p.ret/22)*340}`).join(" ")} fill="none" stroke="#D29922" strokeWidth="2.5"/>}
                {frontier.frontier.filter(p=>p.vol<=30&&p.ret<=22).map((p,i)=><circle key={`fd${i}`} cx={60+(p.vol/30)*620} cy={370-(p.ret/22)*340} r="3" fill="#D29922" opacity=".4"/>)}
                {/* Current */}
                <circle cx={60+(stats.vol/30)*620} cy={370-(stats.ret/22)*340} r="7" fill="#F85149" stroke="#F0F6FC" strokeWidth="2"/>
                <text x={Math.min(640,60+(stats.vol/30)*620+12)} y={370-(stats.ret/22)*340+4} fill="#F85149" fontSize="9" fontWeight="600" fontFamily="JetBrains Mono">Actual</text>
                {/* ERC */}
                <circle cx={60+(ercStats.vol/30)*620} cy={370-(ercStats.ret/22)*340} r="5" fill="#3FB950" stroke="#F0F6FC" strokeWidth="1.5"/>
                <text x={60+(ercStats.vol/30)*620+9} y={370-(ercStats.ret/22)*340+4} fill="#3FB950" fontSize="8" fontFamily="JetBrains Mono">ERC</text>
                {/* Saved portfolios */}
                {savedStats.map(s=>{const x=60+(s.vol/30)*620,y=370-(s.ret/22)*340;return(x<=680&&y>=30)?<g key={s.id}><circle cx={x} cy={y} r="5" fill={s.color} stroke="#F0F6FC" strokeWidth="1"/><text x={x+8} y={y+3} fill={s.color} fontSize="7" fontWeight="600" fontFamily="JetBrains Mono">{s.name}</text></g>:null})}
                {/* Individual assets */}
                {assets.map(ac=>{const x=60+(ac.annualizedVol/30)*620,y=370-(ac.expectedReturn/22)*340;return(x<=680&&y>=30)?<g key={ac.id}><circle cx={x} cy={y} r="3.5" fill={ac.color} opacity=".7"/><text x={x+6} y={y+3} fill={ac.color} fontSize="7" fontFamily="JetBrains Mono">{ac.name}</text></g>:null})}
                {selPt&&<circle cx={60+(selPt.vol/30)*620} cy={370-(selPt.ret/22)*340} r="8" fill="none" stroke="#58A6FF" strokeWidth="2.5" strokeDasharray="4 2"/>}
                {levOn&&(()=>{const rf=bc,bs=pStats(nw,assets,corr),slope=(bs.ret-rf)/(bs.vol+1e-12),er=Math.min(22,rf+slope*30);return<line x1={60} y1={370-(rf/22)*340} x2={680} y2={370-(er/22)*340} stroke="#F85149" strokeWidth="1.5" strokeDasharray="6 3" opacity=".5"/>})()}
              </svg>
            )}
          </div>
        )}

        {/* ═══ LEVERAGE ═══ */}
        {tab==="leverage"&&(
          <div style={box}>
            <h3 style={{margin:"0 0 12px",fontSize:14,fontWeight:600,color:"#F0F6FC"}}>⚡ Leverage</h3>
            <button onClick={()=>setLevOn(!levOn)} style={{padding:"8px 16px",fontSize:12,fontFamily:"'JetBrains Mono',monospace",background:levOn?"#3D1117":"#21262D",border:`1px solid ${levOn?"#F85149":"#30363D"}`,color:levOn?"#F85149":"#C9D1D9",borderRadius:6,cursor:"pointer",fontWeight:600,marginBottom:16}}>{levOn?"Desactivar":"Activar"}</button>
            {levOn&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
                <div>
                  <div style={{...micro,marginBottom:8}}>Asset</div>
                  {assets.map((ac,i)=>(<button key={ac.id} onClick={()=>setLevIdx(i)} style={{display:"block",width:"100%",padding:"5px 10px",fontSize:11,textAlign:"left",background:i===levIdx?"#21262D":"transparent",border:`1px solid ${i===levIdx?ac.color:"transparent"}`,borderRadius:5,color:i===levIdx?"#F0F6FC":"#6E7681",cursor:"pointer",marginBottom:3}}><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:ac.color,marginRight:8}}/>{ac.name}</button>))}
                </div>
                <div>
                  <div style={{...micro,marginBottom:8}}>Ratio: {levR}x</div>
                  <input type="range" min="1" max="3" step=".1" value={levR} onChange={e=>setLevR(+e.target.value)} style={{width:"100%",marginBottom:12}}/>
                  <div style={{...micro,marginBottom:8}}>Costo: {bc}%</div>
                  <input type="range" min="2" max="8" step=".25" value={bc} onChange={e=>setBc(+e.target.value)} style={{width:"100%",marginBottom:12}}/>
                  <div style={{padding:12,background:"#0D1117",borderRadius:6,border:"1px solid #21262D",display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {[{l:"E[R]",v:`${stats.ret.toFixed(1)}%`,c:"#3FB950"},{l:"Vol",v:`${stats.vol.toFixed(1)}%`,c:"#D29922"},{l:"VaR5",v:`${stats.var5.toFixed(1)}%`,c:stats.var5<0?"#F85149":"#3FB950"},{l:"Exposure",v:`${(stats.totalExposure*100).toFixed(0)}%`,c:"#F85149"}].map(m=>(<div key={m.l}><div style={{fontSize:9,color:"#484F58"}}>{m.l}</div><div style={{fontSize:14,fontWeight:700,color:m.c,fontFamily:"'JetBrains Mono',monospace"}}>{m.v}</div></div>))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ ASSUMPTIONS ═══ */}
        {tab==="data"&&(
          <div style={{display:"flex",flexDirection:"column",gap:20}}>
            <div style={box}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
                <h3 style={{margin:0,fontSize:14,fontWeight:600,color:"#F0F6FC"}}>Returns & Vol</h3>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={addAsset} style={{padding:"4px 12px",fontSize:11,background:"#1F3A2D",border:"1px solid #238636",borderRadius:5,color:"#3FB950",cursor:"pointer",fontWeight:600}}>+ Asset</button>
                  <button onClick={resetAll} style={{padding:"4px 12px",fontSize:11,background:"#21262D",border:"1px solid #30363D",borderRadius:5,color:"#C9D1D9",cursor:"pointer"}}>↺ Reset</button>
                </div>
              </div>
              <table style={{width:"100%",fontSize:11,borderCollapse:"collapse"}}>
                <thead><tr style={{borderBottom:"1px solid #30363D"}}>{["","Asset","E[R]%","Vol%","VaR5","Liq",""].map((h,i)=>(<th key={i} style={{textAlign:i<=1?"left":"center",padding:"6px 3px",...micro}}>{h}</th>))}</tr></thead>
                <tbody>{assets.map((ac,i)=>{const v5=ac.expectedReturn-1.645*ac.annualizedVol;return(
                  <tr key={ac.id} style={{borderBottom:"1px solid #21262D"}}>
                    <td style={{padding:"6px 3px"}}><div style={{width:10,height:10,borderRadius:3,background:ac.color}}/></td>
                    <td style={{padding:"6px 3px"}}><input value={ac.name} onChange={e=>{setAssets(p=>p.map((a,j)=>j===i?{...a,name:e.target.value}:a));setMod(true)}} style={{background:"transparent",border:"none",color:"#F0F6FC",fontSize:11,fontWeight:500,outline:"none",width:100}}/></td>
                    <td style={{textAlign:"center",padding:"6px 3px"}}><NF value={ac.expectedReturn} onChange={e=>updAsset(i,"expectedReturn",e.target.value)} color="#3FB950" width={52}/></td>
                    <td style={{textAlign:"center",padding:"6px 3px"}}><NF value={ac.annualizedVol} onChange={e=>updAsset(i,"annualizedVol",e.target.value)} color="#D29922" width={52}/></td>
                    <td style={{textAlign:"center",padding:"6px 3px",fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:v5<0?"#F85149":"#3FB950"}}>{v5.toFixed(1)}%</td>
                    <td style={{textAlign:"center",padding:"6px 3px"}}><button onClick={()=>updAsset(i,"liquid",!ac.liquid)} style={{background:"none",border:"none",cursor:"pointer",fontSize:10,color:ac.liquid?"#3FB950":"#D29922"}}>{ac.liquid?"LIQ":"ILL"}</button></td>
                    <td style={{textAlign:"center",padding:"6px 3px"}}>{assets.length>2&&<button onClick={()=>removeAsset(i)} style={{background:"none",border:"none",cursor:"pointer",color:"#F85149",fontSize:14}}>×</button>}</td>
                  </tr>)})}</tbody>
              </table>
            </div>
            <div style={box}>
              <h3 style={{margin:"0 0 10px",fontSize:14,fontWeight:600,color:"#58A6FF"}}>Correlaciones</h3>
              <div style={{overflowX:"auto"}}>
                <table style={{fontSize:9,borderCollapse:"collapse",fontFamily:"'JetBrains Mono',monospace"}}>
                  <thead><tr><th style={{padding:"4px 5px"}}></th>{assets.map((ac,i)=><th key={i} style={{padding:"4px 3px",color:ac.color,fontWeight:500,minWidth:48,textAlign:"center"}}>{ac.name.length>5?ac.name.slice(0,4)+"…":ac.name}</th>)}</tr></thead>
                  <tbody>{assets.map((ac,i)=>(
                    <tr key={i}><td style={{padding:"3px 5px",color:ac.color,fontWeight:500}}>{ac.name.length>5?ac.name.slice(0,4)+"…":ac.name}</td>
                      {(corr[i]||[]).map((c,j)=>(<td key={j} style={{padding:"2px 1px",textAlign:"center",background:i===j?"#161B22":`rgba(${c>0?"248,81,73":"63,185,80"},${Math.abs(c)*.15})`}}>
                        {i===j?<span style={{color:"#484F58"}}>1.00</span>:i<j?<input type="number" value={c} step=".05" min="-1" max="1" onChange={e=>updCorr(i,j,e.target.value)} style={{width:42,padding:"2px 1px",background:"transparent",border:"1px solid transparent",borderRadius:3,color:c>.5?"#F85149":c<0?"#3FB950":"#8B949E",fontSize:9,fontFamily:"'JetBrains Mono',monospace",textAlign:"center",outline:"none"}} onFocus={e=>e.target.style.borderColor="#58A6FF"} onBlur={e=>e.target.style.borderColor="transparent"}/>:<span style={{color:c>.5?"#F85149":c<0?"#3FB950":"#6E7681"}}>{(c??0).toFixed(2)}</span>}
                      </td>))}
                    </tr>))}</tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        <div style={{marginTop:20,padding:12,background:"#0D1117",borderRadius:8,fontSize:10,color:"#484F58",fontFamily:"'JetBrains Mono',monospace"}}>
          VaR 5%=E[R]−1.645×σ | ERC Newton (ex zero-vol) | Family: consolidado = propio + herencia% × padre | No es asesoramiento financiero.
        </div>
      </div>
    </div>
  );
}
