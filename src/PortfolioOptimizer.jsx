import { useState, useMemo, useRef, useCallback, useEffect } from "react";

// ─── SUPABASE (minimal fetch client — no npm dependency) ───
const SB_URL = "https://erufkqzkslvixdergllr.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVydWZrcXprc2x2aXhkZXJnbGxyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MTIyNDYsImV4cCI6MjA4NjM4ODI0Nn0.kNmeBTiRZ3pkLglGixy7M9yjQOgmBRMAObYQ24yMlyo";
const sbHeaders = { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" };
const sbFetch = async (table, method, opts = {}) => {
  const { query = "", body } = opts;
  const url = `${SB_URL}/rest/v1/${table}${query ? "?" + query : ""}`;
  const res = await fetch(url, { method, headers: { ...sbHeaders, ...(opts.headers || {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (method === "GET") return res.ok ? res.json() : [];
  return res.ok;
};
const sb = {
  select: (table, query) => sbFetch(table, "GET", { query }),
  upsert: (table, rows) => sbFetch(table, "POST", { body: rows, headers: { "Prefer": "resolution=merge-duplicates,return=minimal" } }),
  deleteAll: (table) => sbFetch(table, "DELETE", { query: "id=neq." }),
};

// ─── DEFAULTS ───────────────────────────────────────────────
const INIT_ASSETS = [
  { id:"cash",name:"Cash",color:"#4A90A4",expectedReturn:3.5,annualizedVol:0,description:"T-Bills, Money Market",liquid:true },
  { id:"fixed_income",name:"Fixed Income",color:"#2E7D6B",expectedReturn:5,annualizedVol:5,description:"US Agg / IG Bonds",liquid:true },
  { id:"equity",name:"Equity",color:"#C75B39",expectedReturn:12,annualizedVol:16.5,description:"Global Equities",liquid:true },
  { id:"hedge_funds",name:"Hedge Funds",color:"#8B6DAF",expectedReturn:10,annualizedVol:6,description:"HFRI FW Composite",liquid:false },
  { id:"gold",name:"Gold",color:"#D4A843",expectedReturn:12,annualizedVol:24.5,description:"Physical gold + miners",liquid:true },
  { id:"private_equity",name:"Private Equity",color:"#3D4F7C",expectedReturn:13.5,annualizedVol:15,description:"Cambridge (de-smoothed)",liquid:false },
  { id:"real_estate",name:"Real Estate",color:"#A0522D",expectedReturn:10,annualizedVol:6,description:"REITs / REOCs",liquid:false },
  { id:"bitcoin",name:"Bitcoin",color:"#F7931A",expectedReturn:20,annualizedVol:54,description:"BTC spot",liquid:true },
];
const INIT_CORR = [
  [1,.15,-.02,.05,0,-.02,-.05,0],[.15,1,.15,.1,-.1,.1,.2,-.05],[-.02,.15,1,.75,.15,.85,.65,.3],[.05,.1,.75,1,.2,.7,.5,.25],
  [0,-.1,.15,.2,1,.15,.1,.2],[-.02,.1,.85,.7,.15,1,.55,.2],[-.05,.2,.65,.5,.1,.55,1,.15],[0,-.05,.3,.25,.2,.2,.15,1],
];
const PALETTE=["#4A90A4","#2E7D6B","#C75B39","#8B6DAF","#D4A843","#3D4F7C","#A0522D","#F7931A","#E06C75","#56B6C2","#98C379","#C678DD","#BE5046","#61AFEF","#D19A66","#ABB2BF"];
const SAVED_COLORS=["#58A6FF","#F97583","#B392F0","#FFAB70","#79B8FF","#85E89D","#F692CE","#DBEDFF"];
let _id=100;const nid=()=>`a${_id++}`;

function pStats(w, assets, corr) {
  const n = w.length; let ret = 0;
  for (let i = 0; i < n; i++) ret += w[i] * assets[i].expectedReturn;
  let v = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
    v += w[i] * w[j] * assets[i].annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
  const vol = Math.sqrt(Math.max(0, v)) * 100;
  return { ret, vol, var5: ret - 1.645 * vol };
}

function pStatsLev(w, assets, corr, levRatios, bc) {
  const aw = w.map((wi, i) => wi * (levRatios[i] || 1));
  const te = aw.reduce((a, b) => a + b, 0);
  let ret = 0; for (let i = 0; i < aw.length; i++) ret += aw[i] * assets[i].expectedReturn;
  ret -= (te - 1) * bc;
  let v = 0;
  for (let i = 0; i < aw.length; i++) for (let j = 0; j < aw.length; j++)
    v += aw[i] * aw[j] * assets[i].annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
  const vol = Math.sqrt(Math.max(0, v)) * 100;
  return { ret, vol, var5: ret - 1.645 * vol, totalExposure: te };
}

function genFrontier(assets, corr, cnt, cst) {
  const pts = [], n = assets.length;
  const { locked, maxIlliquid, active } = cst || {};
  const lk = locked ? Object.keys(locked).map(Number) : [];
  const fixedIdx = lk.filter(k => locked[k]?.type === 'fixed');
  const fixedSum = fixedIdx.reduce((s, k) => s + (locked[k]?.val || 0), 0);
  const freeIdx = Array.from({ length: n }, (_, i) => i).filter(i => !fixedIdx.includes(i));

  const clampAndCheck = (w) => {
    // Enforce min/max/range constraints
    if (active && locked) {
      for (const k of lk) {
        const c = locked[k]; if (!c) continue;
        const pct = w[k] * 100;
        if (c.type === 'min' && pct < (c.min || 0)) return null;
        if (c.type === 'max' && pct > (c.max ?? 100)) return null;
        if (c.type === 'range' && (pct < (c.min || 0) || pct > (c.max ?? 100))) return null;
      }
    }
    if (active && maxIlliquid != null) {
      const il = assets.reduce((s, a, i) => s + (a.liquid ? 0 : w[i] * 100), 0);
      if (il > maxIlliquid) return null;
    }
    const { ret, vol } = pStats(w, assets, corr);
    return { ret, vol, weights: w };
  };

  const tryAdd = (w) => { const p = clampAndCheck(w); if (p) pts.push(p); };

  // 1) Edge portfolios
  for (let i = 0; i < n; i++) {
    if (active && fixedIdx.length > 0) {
      if (fixedIdx.includes(i)) continue;
      const w = Array(n).fill(0);
      fixedIdx.forEach(k => { w[k] = (locked[k]?.val || 0) / 100 });
      w[i] = Math.max(0, (100 - fixedSum)) / 100;
      tryAdd(w);
    } else {
      const w = Array(n).fill(0); w[i] = 1; tryAdd(w);
    }
  }

  // 2) Pairwise blends
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    for (let a = 0; a <= 10; a++) {
      const wi = a / 10, wj = 1 - wi;
      if (active && fixedIdx.length > 0) {
        if (fixedIdx.includes(i) || fixedIdx.includes(j)) continue;
        const w = Array(n).fill(0);
        fixedIdx.forEach(k => { w[k] = (locked[k]?.val || 0) / 100 });
        const rem = Math.max(0, (100 - fixedSum)) / 100;
        w[i] = wi * rem; w[j] = wj * rem;
        tryAdd(w);
      } else {
        const w = Array(n).fill(0); w[i] = wi; w[j] = wj; tryAdd(w);
      }
    }
  }

  // 3) Random portfolios — constraint-aware generation
  // Compute floor allocations from min/range constraints
  const floors = Array(n).fill(0);
  const caps = Array(n).fill(100);
  if (active && locked) {
    for (const k of lk) {
      const c = locked[k]; if (!c) continue;
      if (c.type === 'fixed') { floors[k] = c.val || 0; caps[k] = c.val || 0; }
      if (c.type === 'min') floors[k] = c.min || 0;
      if (c.type === 'max') caps[k] = c.max ?? 100;
      if (c.type === 'range') { floors[k] = c.min || 0; caps[k] = c.max ?? 100; }
    }
  }
  const floorSum = floors.reduce((s, v) => s + v, 0);
  const hasFloors = floorSum > 0.01;

  for (let k = 0; k < cnt; k++) {
    let w;
    const alpha = k < cnt * 0.2 ? 0.05 : k < cnt * 0.4 ? 0.1 : k < cnt * 0.65 ? 0.5 : 1.0;

    if (hasFloors) {
      // Start from floor allocations, distribute remaining budget randomly
      w = floors.map(f => f / 100);
      const remaining = Math.max(0, 1 - floorSum / 100);
      if (remaining > 0.001) {
        // Only distribute to non-fixed assets that have room (below cap)
        const eligible = Array.from({ length: n }, (_, i) => i).filter(i => !fixedIdx.includes(i) && caps[i] > floors[i] + 0.01);
        if (eligible.length > 0) {
          const raw = eligible.map(() => Math.pow(Math.random(), 1 / alpha));
          const rs = raw.reduce((a, b) => a + b, 0);
          eligible.forEach((ei, ri) => {
            const room = (caps[ei] - floors[ei]) / 100;
            w[ei] += Math.min(room, (raw[ri] / rs) * remaining);
          });
          // Normalize to sum to 1
          const s = w.reduce((a, b) => a + b, 0);
          if (s > 0.001) w = w.map(x => x / s);
        }
      }
    } else if (active && fixedIdx.length > 0) {
      const raw = freeIdx.map(() => Math.pow(Math.random(), 1 / alpha)), rs = raw.reduce((a, b) => a + b, 0);
      const ft = Math.max(0, (100 - fixedSum)) / 100;
      w = Array(n).fill(0);
      fixedIdx.forEach(i => { w[i] = (locked[i]?.val || 0) / 100 });
      freeIdx.forEach((f, r) => { w[f] = (raw[r] / rs) * ft });
    } else {
      const raw = Array.from({ length: n }, () => Math.pow(Math.random(), 1 / alpha));
      const s = raw.reduce((a, b) => a + b, 0);
      w = raw.map(x => x / s);
    }
    tryAdd(w);
  }

  // Build frontier: true Pareto — a point is on the frontier if no other point
  // has both lower vol AND higher return
  // Step 1: sort all points by vol ascending
  const sorted = [...pts].sort((a, b) => a.vol - b.vol);

  // Step 2: sweep from left, track running max return — any point that sets a new max is on the frontier
  let maxRet = -Infinity;
  const pareto = [];
  for (const p of sorted) {
    if (p.ret > maxRet) { maxRet = p.ret; pareto.push(p); }
  }

  // Step 3: bucket the Pareto points into fine 0.25% vol intervals for a smooth line
  const bk = {};
  for (const p of pareto) { const b = Math.round(p.vol * 4) / 4; if (!bk[b] || p.ret > bk[b].ret) bk[b] = p; }
  const frontier = Object.values(bk).sort((a, b) => a.vol - b.vol);

  return { points: pts, frontier };
}

function calcERC(assets, corr, excl) {
  const idx = assets.map((_, i) => i).filter(i => !excl.includes(i));
  const nn = idx.length;
  if (nn === 0) return assets.map(() => 0);
  const vols = idx.map(i => assets[i].annualizedVol / 100);
  const cm = idx.map(i => idx.map(j => corr[i][j]));
  let w = Array(nn).fill(1 / nn);
  for (let it = 0; it < 300; it++) {
    let tv = 0;
    for (let i = 0; i < nn; i++) for (let j = 0; j < nn; j++) tv += w[i] * w[j] * vols[i] * vols[j] * cm[i][j];
    const pv = Math.sqrt(Math.max(0, tv));
    const mrc = idx.map((_, i) => {
      let s = 0; for (let j = 0; j < nn; j++) s += w[j] * vols[i] * vols[j] * cm[i][j]; return s / (pv + 1e-12);
    });
    const rc = w.map((wi, i) => wi * mrc[i]);
    const tgt = pv / nn;
    const nw = w.map((wi, i) => wi * (tgt / (rc[i] + 1e-12)));
    const sw = nw.reduce((a, b) => a + b, 0);
    w = nw.map(wi => wi / sw);
  }
  const full = Array(assets.length).fill(0);
  idx.forEach((ai, i) => { full[ai] = w[i] });
  return full;
}

const fmt = v => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v}`;
const NF = ({ value, onChange, color, width, step, min, max, disabled }) => (
  <input type="number" value={value} onChange={onChange} step={step || 0.1} min={min} max={max} disabled={disabled}
    style={{ width: width || 56, padding: "4px 5px", background: disabled ? "#21262D" : "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: disabled ? "#484F58" : color || "#F0F6FC", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", textAlign: "right", outline: "none" }}
    onFocus={e => { e.target.style.borderColor = "#58A6FF" }} onBlur={e => { e.target.style.borderColor = "#30363D" }} />
);

// Constraint helpers: locked[i] = { type: 'fixed'|'min'|'max'|'range', val?, min?, max? }
const cHas = (locked, i) => locked[i] !== undefined;
const cIsFixed = (locked, i) => locked[i]?.type === 'fixed';
const cFixedVal = (locked, i) => cIsFixed(locked, i) ? locked[i].val : undefined;
const cMin = (locked, i) => { const c = locked[i]; if (!c) return 0; if (c.type === 'fixed') return c.val; if (c.type === 'min' || c.type === 'range') return c.min || 0; return 0; };
const cMax = (locked, i) => { const c = locked[i]; if (!c) return 100; if (c.type === 'fixed') return c.val; if (c.type === 'max' || c.type === 'range') return c.max ?? 100; return 100; };
const cLabel = (locked, i) => { const c = locked[i]; if (!c) return ""; if (c.type === 'fixed') return `=${c.val}%`; if (c.type === 'min') return `≥${c.min}%`; if (c.type === 'max') return `≤${c.max}%`; if (c.type === 'range') return `${c.min}-${c.max}%`; return ""; };

// ─── AUTH GATE ─────────────────────────────────────────────
const PW_HASH = "f9589fb8cdd87cc38fa8c5d4022d9bc8b53e9690c0f16e0696020b0a316e3de0";
async function sha256(msg) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function AuthGate({ children }) {
  const [ok, setOk] = useState(() => typeof sessionStorage !== "undefined" && sessionStorage.getItem("po_auth") === "1");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const tryLogin = async () => {
    const h = await sha256(pw);
    if (h === PW_HASH) { setOk(true); try { sessionStorage.setItem("po_auth", "1"); } catch {} }
    else { setErr(true); setTimeout(() => setErr(false), 1500); }
  };
  if (ok) return children;
  return (
    <div style={{ minHeight: "100vh", background: "#0D1117", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#161B22", border: "1px solid #21262D", borderRadius: 12, padding: 40, width: 340, textAlign: "center" }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
        <h2 style={{ color: "#F0F6FC", fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>Portfolio Optimizer</h2>
        <p style={{ color: "#6E7681", fontSize: 11, margin: "0 0 20px" }}>Ingresá la contraseña para continuar</p>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && tryLogin()}
          placeholder="Contraseña" autoFocus
          style={{ width: "100%", padding: "10px 14px", background: "#0D1117", border: `1px solid ${err ? "#F85149" : "#30363D"}`, borderRadius: 6, color: "#F0F6FC", fontSize: 13, fontFamily: "'JetBrains Mono',monospace", outline: "none", boxSizing: "border-box", marginBottom: 12, transition: "border .2s" }} />
        <button onClick={tryLogin}
          style={{ width: "100%", padding: "10px 0", background: "#238636", border: "none", borderRadius: 6, color: "#F0F6FC", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          Ingresar
        </button>
        {err && <p style={{ color: "#F85149", fontSize: 11, marginTop: 10 }}>Contraseña incorrecta</p>}
      </div>
    </div>
  );
}

export default function App() {
  return <AuthGate><AppInner /></AuthGate>;
}

function AppInner() {
  const [assets, setAssets] = useState(INIT_ASSETS.map(a => ({ ...a })));
  const [corr, setCorr] = useState(INIT_CORR.map(r => [...r]));
  const [weights, setWeights] = useState([5, 15, 30, 10, 10, 10, 5, 15]);
  const [tab, setTab] = useState("allocation");
  const [hov, setHov] = useState(null);
  const [mod, setMod] = useState(false);
  const [selPt, setSelPt] = useState(null);
  const [showF, setShowF] = useState(false);
  const [levOn, setLevOn] = useState(false);
  const [levRatios, setLevRatios] = useState({});
  const [bc, setBc] = useState(5);
  const [locked, setLocked] = useState({});
  const [maxIll, setMaxIll] = useState(50);
  const [cstOn, setCstOn] = useState(false);
  const [saved, setSaved] = useState([]);
  const [saveName, setSaveName] = useState("");
  const [members, setMembers] = useState([
    { id: "padre", name: "Padre", portfolioId: null, value: 1000000, parentId: null, inheritPct: 0 },
  ]);
  const [activeMemberId, setActiveMemberId] = useState("padre");
  const [fShow, setFShow] = useState({ editor: true, assets: true, saved: true, members: true, familia: true });
  const [fShowSaved, setFShowSaved] = useState({}); // { portfolioId: true/false } — default true if not set
  const [fShowMembers, setFShowMembers] = useState({}); // { memberId: true/false } — default true if not set
  const [dbReady, setDbReady] = useState(false);
  const [savedCst, setSavedCst] = useState([]);
  const [cstName, setCstName] = useState("");
  const [activeCstId, setActiveCstId] = useState(null);
  const [allocMode, setAllocMode] = useState("%"); // "%" or "$"
  const [totalAUM, setTotalAUM] = useState(10000000); // total portfolio value for $ mode
  const [cmpItems, setCmpItems] = useState([]); // [{ type:'portfolio'|'member', id, mode:'individual'|'consolidated' }]
  const [cmpTarget, setCmpTarget] = useState(null); // target weights from frontier click
  const [cmpDeltaIdx, setCmpDeltaIdx] = useState(0); // which resolved item to compute delta against

  // ─── SUPABASE: Load on mount ───
  useEffect(() => {
    const load = async () => {
      try {
        // Load assumptions
        const aData = await sb.select("assumptions", "id=eq.1&limit=1");
        if (aData && aData.length > 0) {
          const a = aData[0];
          setAssets(a.assets);
          setCorr(a.correlation);
          setWeights(a.assets.map(() => +(100 / a.assets.length).toFixed(1)));
        }
        // Load portfolios
        const pData = await sb.select("saved_portfolios", "order=created_at.asc");
        if (pData && pData.length > 0) {
          setSaved(pData.map(p => ({ id: p.id, name: p.name, weights: p.weights, color: p.color, constraints: p.constraints || {} })));
        }
        // Load family members
        const fData = await sb.select("family_members", "order=sort_order.asc");
        if (fData && fData.length > 0) {
          setMembers(fData.map(f => ({ id: f.id, name: f.name, portfolioId: f.portfolio_id, value: +f.value, parentId: f.parent_id, inheritPct: +f.inherit_pct })));
          setActiveMemberId(fData[0].id);
        }
        // Load saved constraints
        const cData = await sb.select("saved_constraints", "order=created_at.asc");
        if (cData && cData.length > 0) {
          setSavedCst(cData.map(c => ({ id: c.id, name: c.name, locked: c.locked, maxIll: c.max_ill, cstOn: c.cst_on })));
        }
      } catch (e) { console.warn("Supabase load error:", e); }
      setDbReady(true);
    };
    load();
  }, []);

  // ─── SUPABASE: Sync saved portfolios ───
  const dbSyncSaved = useCallback(async (portfolios) => {
    if (!dbReady) return;
    try {
      await sb.deleteAll("saved_portfolios");
      if (portfolios.length > 0) {
        await sb.upsert("saved_portfolios",
          portfolios.map(p => ({ id: p.id, name: p.name, weights: p.weights, color: p.color, constraints: p.constraints }))
        );
      }
    } catch (e) { console.warn("Sync portfolios error:", e); }
  }, [dbReady]);

  // ─── SUPABASE: Sync family members ───
  const dbSyncMembers = useCallback(async (mems) => {
    if (!dbReady) return;
    try {
      await sb.deleteAll("family_members");
      if (mems.length > 0) {
        await sb.upsert("family_members",
          mems.map((m, i) => ({ id: m.id, name: m.name, portfolio_id: m.portfolioId, value: m.value, parent_id: m.parentId, inherit_pct: m.inheritPct, sort_order: i }))
        );
      }
    } catch (e) { console.warn("Sync members error:", e); }
  }, [dbReady]);

  // ─── SUPABASE: Sync assumptions ───
  const dbSyncAssumptions = useCallback(async (a, c) => {
    if (!dbReady) return;
    try {
      await sb.upsert("assumptions", [{ id: 1, assets: a, correlation: c, updated_at: new Date().toISOString() }]);
    } catch (e) { console.warn("Sync assumptions error:", e); }
  }, [dbReady]);

  // ─── SUPABASE: Sync saved constraints ───
  const dbSyncCst = useCallback(async (csts) => {
    if (!dbReady) return;
    try {
      await sb.deleteAll("saved_constraints");
      if (csts.length > 0) {
        await sb.upsert("saved_constraints",
          csts.map(c => ({ id: c.id, name: c.name, locked: c.locked, max_ill: c.maxIll, cst_on: c.cstOn }))
        );
      }
    } catch (e) { console.warn("Sync constraints error:", e); }
  }, [dbReady]);

  const svgRef = useRef(null);
  const n = assets.length;
  const tw = weights.reduce((a, b) => a + b, 0);
  const nw = weights.map(w => w / (tw || 1));

  const stats = useMemo(() => {
    if (!levOn) return { ...pStats(nw, assets, corr), totalExposure: 1 };
    return pStatsLev(nw, assets, corr, levRatios, bc);
  }, [weights, assets, corr, levOn, levRatios, bc, n, nw]);

  const riskBudget = useMemo(() => {
    const aw = levOn ? nw.map((w, i) => w * (levRatios[i] || 1)) : nw;
    let tv = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
      tv += aw[i] * aw[j] * assets[i].annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
    const pv = Math.sqrt(Math.max(0, tv));
    return assets.map((ac, i) => {
      let mrc = 0;
      for (let j = 0; j < n; j++) mrc += aw[j] * ac.annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
      mrc = mrc / (pv + 1e-12);
      const rc = aw[i] * mrc;
      return { ...ac, idx: i, mrc, rc, pctRisk: (rc / (pv + 1e-12)) * 100, weight: nw[i] * 100 };
    });
  }, [weights, assets, corr, levOn, levRatios, n, nw]);

  const ercExcl = useMemo(() => assets.map((a, i) => a.annualizedVol <= 0.01 ? i : -1).filter(i => i >= 0), [assets]);
  const ercW = useMemo(() => calcERC(assets, corr, ercExcl), [assets, corr, ercExcl]);
  const ercStats = useMemo(() => pStats(ercW, assets, corr), [ercW, assets, corr]);
  const fCst = useMemo(() => cstOn ? { locked, maxIlliquid: maxIll, active: true } : { active: false }, [cstOn, locked, maxIll]);
  const frontier = useMemo(() => showF ? genFrontier(assets, corr, cstOn ? 35000 : 15000, fCst) : null, [showF, assets, corr, fCst, cstOn]);
  const illPct = useMemo(() => assets.reduce((s, a, i) => s + (a.liquid ? 0 : nw[i] * 100), 0), [assets, nw]);
  const liqPct = 100 - illPct;

  const savedStats = useMemo(() => saved.map(s => {
    const sw = s.weights.map(w => w / 100);
    return { ...s, ...pStats(sw, assets, corr) };
  }), [saved, assets, corr]);

  const getPortfolioWeights = useCallback((portfolioId) => {
    if (!portfolioId) return Array(n).fill(0);
    const sp = saved.find(s => s.id === portfolioId);
    return sp ? sp.weights.map(w => w / 100) : Array(n).fill(0);
  }, [saved, n]);

  const getMemberConsolidated = useCallback((memberId) => {
    const m = members.find(x => x.id === memberId);
    if (!m) return { ownWeights: Array(n).fill(0), consWeights: Array(n).fill(0), ownValue: 0, inhValue: 0, totalValue: 0, consStats: { ret: 0, vol: 0, var5: 0 } };
    const ownW = getPortfolioWeights(m.portfolioId);
    const ownVal = m.value || 0;
    if (!m.parentId || m.inheritPct <= 0) {
      const cs = pStats(ownW, assets, corr);
      return { ownWeights: ownW, consWeights: ownW, ownValue: ownVal, inhValue: 0, totalValue: ownVal, consStats: cs };
    }
    const parent = members.find(x => x.id === m.parentId);
    if (!parent) {
      const cs = pStats(ownW, assets, corr);
      return { ownWeights: ownW, consWeights: ownW, ownValue: ownVal, inhValue: 0, totalValue: ownVal, consStats: cs };
    }
    const parentW = getPortfolioWeights(parent.portfolioId);
    const parentVal = parent.value || 0;
    const inhVal = parentVal * (m.inheritPct / 100);
    const totalVal = ownVal + inhVal;
    if (totalVal <= 0) return { ownWeights: ownW, consWeights: Array(n).fill(0), ownValue: 0, inhValue: inhVal, totalValue: 0, consStats: { ret: 0, vol: 0, var5: 0 } };
    const consW = assets.map((_, i) => ((ownW[i] * ownVal) + (parentW[i] * inhVal)) / totalVal);
    const cs = pStats(consW, assets, corr);
    return { ownWeights: ownW, consWeights: consW, ownValue: ownVal, inhValue: inhVal, totalValue: totalVal, consStats: cs };
  }, [members, assets, corr, getPortfolioWeights, n]);

  const familySummary = useMemo(() => {
    const mems = members.map(m => {
      const c = getMemberConsolidated(m.id);
      return { ...m, ...c };
    });
    // Aggregate uses each member's OWN value + OWN weights only (no double-counting inheritance)
    const aggVal = mems.reduce((s, m) => s + m.ownValue, 0);
    const aggW = aggVal > 0 ? assets.map((_, i) => mems.reduce((s, m) => s + m.ownWeights[i] * m.ownValue, 0) / aggVal) : Array(n).fill(0);
    const aggStats = pStats(aggW, assets, corr);
    return { members: mems, aggW, aggVal, aggStats };
  }, [members, assets, corr, getMemberConsolidated, n]);

  // When a family member is active and in family/risk tab, show their consolidated stats
  const activeConsStats = useMemo(() => {
    if (tab !== "family" && tab !== "risk") return null;
    const m = members.find(x => x.id === activeMemberId);
    if (!m || !m.portfolioId) return null;
    const c = getMemberConsolidated(m.id);
    if (c.totalValue <= 0) return null;
    const cw = c.consWeights;
    const cs = c.consStats;
    let tv = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
      tv += cw[i] * cw[j] * assets[i].annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
    const pv = Math.sqrt(Math.max(0, tv));
    const rb = assets.map((ac, i) => {
      let mrc = 0;
      for (let j = 0; j < n; j++) mrc += cw[j] * ac.annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
      mrc = mrc / (pv + 1e-12);
      const rc = cw[i] * mrc;
      return { ...ac, idx: i, mrc, rc, pctRisk: (rc / (pv + 1e-12)) * 100, weight: cw[i] * 100 };
    });
    return { name: m.name, stats: cs, riskBudget: rb, weights: cw };
  }, [tab, activeMemberId, members, assets, corr, n, getMemberConsolidated]);

  // Handlers
  const setW = (idx, val) => { const nws = [...weights]; nws[idx] = Math.max(0, Math.min(100, Number(val))); setWeights(nws) };
  const setWFromDollar = (idx, dollarVal) => { if (totalAUM <= 0) return; const pct = (dollarVal / totalAUM) * 100; setW(idx, Math.round(pct * 10) / 10) };
  const updAsset = (idx, f, val) => { setAssets(p => { const na = p.map((a, i) => i === idx ? { ...a, [f]: typeof val === 'boolean' ? val : Number(val) } : a); dbSyncAssumptions(na, corr); return na }); setMod(true); setShowF(false) };
  const updCorr = (i, j, val) => { const v = Math.max(-1, Math.min(1, Number(val))); setCorr(p => { const nc = p.map(r => [...r]); nc[i][j] = v; nc[j][i] = v; dbSyncAssumptions(assets, nc); return nc }); setMod(true); setShowF(false) };
  const resetAll = () => { setAssets(INIT_ASSETS.map(a => ({ ...a }))); setCorr(INIT_CORR.map(r => [...r])); setWeights([5, 15, 30, 10, 10, 10, 5, 15]); setMod(false); setShowF(false); setLocked({}); dbSyncAssumptions(INIT_ASSETS, INIT_CORR) };
  const addAsset = () => {
    const ci = assets.length % PALETTE.length;
    const na = [...assets, { id: nid(), name: "New Asset", color: PALETTE[ci], expectedReturn: 8, annualizedVol: 15, description: "Custom", liquid: true }];
    setAssets(na);
    setWeights(p => [...p, 5]);
    setCorr(p => { const nn = p.length + 1; const nc = p.map(r => [...r, .1]); nc.push(Array(nn).fill(.1)); nc[nn - 1][nn - 1] = 1; dbSyncAssumptions(na, nc); return nc });
    setSaved(p => p.map(s => ({ ...s, weights: [...s.weights, 0] })));
  };
  const removeAsset = (idx) => {
    if (assets.length <= 2) return;
    const na = assets.filter((_, i) => i !== idx);
    setAssets(na); setWeights(p => p.filter((_, i) => i !== idx));
    setCorr(p => { const nc = p.filter((_, i) => i !== idx).map(r => r.filter((_, j) => j !== idx)); dbSyncAssumptions(na, nc); return nc });
    setLocked(p => { const nl = {}; Object.keys(p).forEach(k => { const ki = +k; if (ki < idx) nl[ki] = p[k]; else if (ki > idx) nl[ki - 1] = p[k] }); return nl });
    setSaved(p => { const ns = p.map(s => ({ ...s, weights: s.weights.filter((_, i) => i !== idx) })); dbSyncSaved(ns); return ns });
    setLevRatios(p => { const nl = {}; Object.keys(p).forEach(k => { const ki = +k; if (ki < idx) nl[ki] = p[k]; else if (ki > idx) nl[ki - 1] = p[k] }); return nl });
    setShowF(false);
  };
  const applyERC = () => {
    const fixedIdx = Object.keys(locked).map(Number).filter(k => cIsFixed(locked, k));
    if (fixedIdx.length === 0 && Object.keys(locked).length === 0) { setWeights(ercW.map(w => Math.round(w * 1000) / 10)); return; }
    const excl = [...ercExcl, ...fixedIdx];
    const ew = calcERC(assets, corr, excl);
    const fixedSum = fixedIdx.reduce((s, k) => s + (locked[k]?.val || 0), 0);
    const freeIdx = assets.map((_, i) => i).filter(i => !fixedIdx.includes(i));
    const freeSum = freeIdx.reduce((s, i) => s + ew[i], 0);
    const nws = assets.map((_, i) => {
      if (fixedIdx.includes(i)) return locked[i]?.val || 0;
      const raw = freeSum > 0 ? (ew[i] / freeSum) * (100 - fixedSum) : 0;
      return Math.max(cMin(locked, i), Math.min(cMax(locked, i), raw));
    });
    setWeights(nws.map(w => Math.round(w * 10) / 10));
  };
  const setCst = (idx, cst) => { setLocked(p => { const nl = { ...p }; if (cst === null) delete nl[idx]; else nl[idx] = cst; return nl }); setShowF(false) };
  const toggleCst = v => { setCstOn(v); setShowF(false) };
  const saveCst = () => { const name = cstName.trim() || `Constraint ${savedCst.length + 1}`; const nc = { id: `cst_${Date.now()}`, name, locked: { ...locked }, maxIll, cstOn }; setSavedCst(p => { const ns = [...p, nc]; dbSyncCst(ns); return ns }); setCstName(""); setActiveCstId(nc.id) };
  const loadCst = c => { setLocked(c.locked || {}); setMaxIll(c.maxIll ?? 50); setCstOn(c.cstOn ?? true); setActiveCstId(c.id); setShowF(false) };
  const removeCst = id => { setSavedCst(p => { const ns = p.filter(c => c.id !== id); dbSyncCst(ns); return ns }); if (activeCstId === id) setActiveCstId(null) };
  const savePortfolio = () => { const name = saveName.trim() || `Portfolio ${saved.length + 1}`; const np = { id: `sp_${Date.now()}`, name, weights: [...weights], color: SAVED_COLORS[saved.length % SAVED_COLORS.length], constraints: { locked: { ...locked }, maxIll, cstOn } }; setSaved(p => { const ns = [...p, np]; dbSyncSaved(ns); return ns }); setSaveName("") };
  const removeSaved = id => { setSaved(p => { const ns = p.filter(s => s.id !== id); dbSyncSaved(ns); return ns }); setMembers(p => { const nm = p.map(m => m.portfolioId === id ? { ...m, portfolioId: null } : m); dbSyncMembers(nm); return nm }) };
  const loadSaved = s => setWeights([...s.weights]);
  const addMember = (parentId) => { const id = `m_${Date.now()}`; setMembers(p => { const nm = [...p, { id, name: "Hijo " + p.length, portfolioId: null, value: 500000, parentId: parentId || null, inheritPct: parentId ? 50 : 0 }]; dbSyncMembers(nm); return nm }) };
  const updMember = (id, field, val) => setMembers(p => { const nm = p.map(m => m.id === id ? { ...m, [field]: val } : m); dbSyncMembers(nm); return nm });
  const removeMember = id => { if (members.length <= 1) return; setMembers(p => { const nm = p.filter(m => m.id !== id).map(m => m.parentId === id ? { ...m, parentId: null, inheritPct: 0 } : m); dbSyncMembers(nm); return nm }); if (activeMemberId === id) setActiveMemberId(members[0].id) };
  const moveMember = (idx, dir) => { const ni = idx + dir; if (ni < 0 || ni >= members.length) return; setMembers(p => { const nm = [...p]; const tmp = nm[idx]; nm[idx] = nm[ni]; nm[ni] = tmp; dbSyncMembers(nm); return nm }) };

  const box = { background: "#161B22", border: "1px solid #21262D", borderRadius: 10, padding: 20 };
  const micro = { fontSize: 10, color: "#484F58", fontFamily: "'JetBrains Mono',monospace", textTransform: "uppercase", letterSpacing: 1 };
  const pill = (active) => ({ padding: "7px 14px", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", fontWeight: active ? 600 : 400, color: active ? "#F0F6FC" : "#6E7681", background: active ? "#21262D" : "transparent", border: `1px solid ${active ? "#30363D" : "transparent"}`, borderRadius: 6, cursor: "pointer" });

  // ─── RENDER ───────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'DM Sans','Helvetica Neue',sans-serif", background: "linear-gradient(145deg,#0D1117,#161B22,#0D1117)", color: "#C9D1D9", minHeight: "100vh", padding: 24 }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
          <h1 style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 22, fontWeight: 700, color: "#F0F6FC", margin: 0 }}>Portfolio Optimizer</h1>
          <span style={{ fontSize: 11, color: "#484F58", fontFamily: "'JetBrains Mono',monospace" }}>v6.1 — Family Office</span>
          {mod && <span style={{ fontSize: 10, color: "#D29922", background: "#2D2200", padding: "2px 8px", borderRadius: 4, fontFamily: "'JetBrains Mono',monospace" }}>● modified</span>}
          {levOn && (() => { const lKeys = Object.keys(levRatios).filter(k => levRatios[k] > 1); const summary = lKeys.length === 0 ? "ON" : lKeys.length <= 2 ? lKeys.map(k => `${assets[+k]?.name}:${levRatios[k]}x`).join(" ") : `${lKeys.length} assets`; return <span style={{ fontSize: 10, color: "#F85149", background: "#3D1117", padding: "2px 8px", borderRadius: 4, fontFamily: "'JetBrains Mono',monospace" }}>⚡ {summary}</span> })()}
          {cstOn && <span style={{ fontSize: 10, color: "#58A6FF", background: "#0D2240", padding: "2px 8px", borderRadius: 4, fontFamily: "'JetBrains Mono',monospace" }}>🔒 constraints</span>}
        </div>
        <div style={{ display: "flex", gap: 2, marginBottom: 20, marginTop: 16, flexWrap: "wrap" }}>
          {[{ id: "allocation", l: "Allocation" }, { id: "family", l: "👨‍👧 Family Office" }, { id: "constraints", l: "🔒 Constraints" }, { id: "risk", l: "Risk Budget" }, { id: "frontier", l: "Frontier" }, { id: "compare", l: "⚖ Comparar" }, { id: "leverage", l: "⚡ Leverage" }, { id: "data", l: "⚙ Assumptions" }].map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); if (t.id === "frontier") setShowF(true) }} style={pill(tab === t.id)}>{t.l}</button>
          ))}
        </div>
        {activeConsStats && <div style={{ marginBottom: 8, padding: "6px 12px", background: "#0D2240", borderRadius: 6, border: "1px solid #58A6FF", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#58A6FF" }}>
          Showing consolidated: <span style={{ fontWeight: 700, color: "#F0F6FC" }}>{activeConsStats.name}</span>
        </div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8, marginBottom: 20 }}>
          {(() => { const ds = activeConsStats ? activeConsStats.stats : stats; const dSharpe = ((ds.ret - 3.5) / (ds.vol + 1e-12)).toFixed(2); return [{ l: "E[Return]", v: `${ds.ret.toFixed(1)}%`, c: "#3FB950" }, { l: "Vol", v: `${ds.vol.toFixed(1)}%`, c: "#D29922" }, { l: "VaR 5%", v: `${ds.var5.toFixed(1)}%`, c: ds.var5 < 0 ? "#F85149" : "#3FB950" }, { l: "Sharpe(rf=3.5%)", v: dSharpe, c: "#58A6FF" }, { l: "Liquid", v: `${liqPct.toFixed(0)}%`, c: liqPct >= (100 - maxIll) ? "#3FB950" : "#F85149" }, { l: "Exposure", v: levOn ? `${(stats.totalExposure * 100).toFixed(0)}%` : "100%", c: levOn && stats.totalExposure > 1 ? "#F85149" : "#8B949E" }] })().map(s => (
            <div key={s.l} style={{ background: "#161B22", border: "1px solid #21262D", borderRadius: 8, padding: "12px 10px" }}>
              <div style={{ ...micro, marginBottom: 4, fontSize: 9 }}>{s.l}</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: s.c, fontFamily: "'JetBrains Mono',monospace" }}>{s.v}</div>
            </div>
          ))}
        </div>

{/* ═══ ALLOCATION + PORTFOLIOS ═══ */}
{tab === "allocation" && (
  <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20 }}>
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Asset Weights</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", background: "#21262D", borderRadius: 5, border: "1px solid #30363D", overflow: "hidden" }}>
            <button onClick={() => setAllocMode("%")} style={{ padding: "4px 10px", fontSize: 10, fontWeight: 600, background: allocMode === "%" ? "#0D2240" : "transparent", color: allocMode === "%" ? "#58A6FF" : "#6E7681", border: "none", cursor: "pointer" }}>%</button>
            <button onClick={() => setAllocMode("$")} style={{ padding: "4px 10px", fontSize: 10, fontWeight: 600, background: allocMode === "$" ? "#0D2240" : "transparent", color: allocMode === "$" ? "#58A6FF" : "#6E7681", border: "none", cursor: "pointer" }}>$</button>
          </div>
          {allocMode === "$" && <NF value={totalAUM} width={100} step={100000} min={0} onChange={e => setTotalAUM(Math.max(0, +e.target.value))} color="#58A6FF" />}
          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: Math.abs(tw - 100) < .5 ? "#3FB950" : "#F85149" }}>Σ {tw.toFixed(1)}%</span>
        </div>
      </div>
      {allocMode === "$" && <div style={{ fontSize: 10, color: "#6E7681", marginBottom: 10, fontFamily: "'JetBrains Mono',monospace" }}>AUM Total: {fmt(totalAUM)}</div>}
      {assets.map((ac, i) => { const dollarVal = Math.round(nw[i] * totalAUM); return (
        <div key={ac.id} style={{ marginBottom: 10 }} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: 3, background: ac.color }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: hov === i ? "#F0F6FC" : "#C9D1D9" }}>{ac.name}</span>
              {!ac.liquid && <span style={{ fontSize: 8, color: "#D29922", background: "#2D2200", padding: "1px 4px", borderRadius: 3 }}>ILL</span>}
              {cHas(locked, i) && <span style={{ fontSize: 8, color: "#58A6FF", background: "#0D2240", padding: "1px 4px", borderRadius: 3 }}>{cIsFixed(locked, i) ? "🔒" : "📏"} {cLabel(locked, i)}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {allocMode === "$" && <input type="number" value={dollarVal} onChange={e => setWFromDollar(i, +e.target.value)} disabled={cIsFixed(locked, i)} style={{ width: 90, padding: "3px 5px", background: cIsFixed(locked, i) ? "#21262D" : "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: cIsFixed(locked, i) ? "#484F58" : "#3FB950", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", textAlign: "right" }} />}
              <input type="number" value={weights[i]} onChange={e => setW(i, e.target.value)} disabled={cIsFixed(locked, i)} style={{ width: 50, padding: "3px 5px", background: cIsFixed(locked, i) ? "#21262D" : "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: cIsFixed(locked, i) ? "#484F58" : "#F0F6FC", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", textAlign: "right" }} />
              {allocMode === "%" && <span style={{ fontSize: 9, color: "#484F58", fontFamily: "'JetBrains Mono',monospace", minWidth: 50, textAlign: "right" }}>{fmt(dollarVal)}</span>}
            </div>
          </div>
          <input type="range" min="0" max="60" step=".5" value={weights[i]} onChange={e => setW(i, e.target.value)} disabled={cIsFixed(locked, i)} style={{ width: "100%", height: 4, appearance: "none", background: `linear-gradient(to right,${ac.color} ${(weights[i] / 60) * 100}%,#21262D ${(weights[i] / 60) * 100}%)`, borderRadius: 2, outline: "none", cursor: cIsFixed(locked, i) ? "not-allowed" : "pointer", opacity: cIsFixed(locked, i) ? .5 : 1 }} />
        </div>
      ) })}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #21262D" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          <button onClick={() => {
            const fixedIdx = Object.keys(locked).map(Number).filter(k => cIsFixed(locked, k));
            if (fixedIdx.length === 0 && Object.keys(locked).length === 0) { setWeights(Array(n).fill(+(100 / n).toFixed(1))); return; }
            const fixedSum = fixedIdx.reduce((s, k) => s + (locked[k]?.val || 0), 0);
            const freeCount = n - fixedIdx.length;
            const each = freeCount > 0 ? +((100 - fixedSum) / freeCount).toFixed(1) : 0;
            setWeights(assets.map((_, i) => {
              if (fixedIdx.includes(i)) return locked[i]?.val || 0;
              return Math.max(cMin(locked, i), Math.min(cMax(locked, i), each));
            }));
          }} style={{ padding: "5px 10px", fontSize: 11, background: "#21262D", border: "1px solid #30363D", borderRadius: 5, color: "#C9D1D9", cursor: "pointer" }}>Equal Weight</button>
          <button onClick={applyERC} style={{ padding: "5px 10px", fontSize: 11, background: "#1F3A2D", border: "1px solid #238636", borderRadius: 5, color: "#3FB950", cursor: "pointer", fontWeight: 600 }}>ERC (ex zero-vol)</button>
        </div>
        <div style={{ ...micro, marginBottom: 6, marginTop: 14 }}>Portfolios Guardados</div>
        {saved.length === 0 && <p style={{ fontSize: 11, color: "#484F58", margin: "0 0 8px" }}>Sin portfolios guardados.</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
          {saved.map(s => { const ss = pStats(s.weights.map(w => w / 100), assets, corr); return (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#0D1117", border: "1px solid #21262D", borderRadius: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: 4, background: s.color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#F0F6FC", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name} {s.constraints && s.constraints.cstOn && <span style={{ fontSize: 8, color: "#58A6FF", background: "#0D2240", padding: "1px 4px", borderRadius: 3, marginLeft: 4 }}>🔒</span>}</div>
                <div style={{ fontSize: 9, fontFamily: "'JetBrains Mono',monospace", color: "#6E7681" }}>E[R]:{ss.ret.toFixed(1)}% Vol:{ss.vol.toFixed(1)}% Sharpe:{((ss.ret - 3.5) / (ss.vol + 1e-12)).toFixed(2)}</div>
              </div>
              <button onClick={() => loadSaved(s)} style={{ padding: "3px 8px", fontSize: 9, background: "#21262D", border: "1px solid #30363D", borderRadius: 4, color: "#C9D1D9", cursor: "pointer" }}>Cargar</button>
              <button onClick={() => removeSaved(s.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#F85149", fontSize: 14, padding: 0 }}>×</button>
            </div>
          ) })}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Nombre..." onKeyDown={e => e.key === "Enter" && savePortfolio()} style={{ flex: 1, padding: "5px 8px", background: "#0D1117", border: "1px solid #30363D", borderRadius: 5, color: "#F0F6FC", fontSize: 11, outline: "none" }} />
          <button onClick={savePortfolio} style={{ padding: "5px 10px", fontSize: 11, background: "#0D2240", border: "1px solid #58A6FF", borderRadius: 5, color: "#58A6FF", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>+ Guardar</button>
        </div>
      </div>
    </div>
    {/* PIE */}
    <div style={{ ...box, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: "#F0F6FC", alignSelf: "flex-start" }}>Allocation</h3>
      <svg viewBox="0 0 200 200" style={{ width: 190, height: 190 }}>
        {(() => { let cum = -90; return assets.map((ac, i) => { const pct = nw[i] * 100; if (pct < .5) return null; const angle = (pct / 100) * 360; const s = cum; cum += angle; const sr = s * Math.PI / 180; const er = cum * Math.PI / 180; return <path key={ac.id} d={`M 100 100 L ${100 + 85 * Math.cos(sr)} ${100 + 85 * Math.sin(sr)} A 85 85 0 ${angle > 180 ? 1 : 0} 1 ${100 + 85 * Math.cos(er)} ${100 + 85 * Math.sin(er)} Z`} fill={ac.color} stroke="#161B22" strokeWidth="1.5" opacity={hov === null || hov === i ? 1 : .35} style={{ transition: "opacity 0.2s" }} /> }) })()}
        <circle cx="100" cy="100" r="38" fill="#161B22" />
        <text x="100" y="96" textAnchor="middle" fill="#F0F6FC" fontSize="15" fontWeight="700" fontFamily="JetBrains Mono">{stats.ret.toFixed(1)}%</text>
        <text x="100" y="110" textAnchor="middle" fill="#6E7681" fontSize="7" fontFamily="JetBrains Mono">E[Return]</text>
      </svg>
      <div style={{ marginTop: 10, width: "100%" }}>
        {assets.map((ac, i) => { const pct = nw[i] * 100; const dv = Math.round(nw[i] * totalAUM); if (pct < .3) return null; return (
          <div key={ac.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", opacity: hov === null || hov === i ? 1 : .4 }} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 7, height: 7, borderRadius: 2, background: ac.color }} /><span style={{ fontSize: 10 }}>{ac.name}</span></div>
            <div style={{ display: "flex", gap: 8 }}>
              <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#8B949E" }}>{pct.toFixed(1)}%</span>
              <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#6E7681" }}>{fmt(dv)}</span>
            </div>
          </div>) })}
      </div>
      <div style={{ width: "100%", marginTop: 12, paddingTop: 10, borderTop: "1px solid #21262D" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
          <span style={{ fontSize: 9, color: "#3FB950" }}>Líquido {liqPct.toFixed(0)}%</span>
          <span style={{ fontSize: 9, color: "#D29922" }}>Ilíquido {illPct.toFixed(0)}%</span>
        </div>
        <div style={{ height: 5, background: "#21262D", borderRadius: 3, overflow: "hidden", display: "flex" }}>
          <div style={{ width: `${liqPct}%`, background: "#3FB950", transition: "width .3s" }} />
          <div style={{ width: `${illPct}%`, background: "#D29922", transition: "width .3s" }} />
        </div>
      </div>
    </div>
  </div>
)}

{/* ═══ FAMILY OFFICE ═══ */}
{tab === "family" && (
  <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>👨‍👧 Family Office</h3>
        <button onClick={() => addMember(null)} style={{ padding: "4px 12px", fontSize: 11, background: "#21262D", border: "1px solid #30363D", borderRadius: 5, color: "#C9D1D9", cursor: "pointer" }}>+ Miembro Raíz</button>
      </div>
      {saved.length === 0 && <p style={{ fontSize: 12, color: "#D29922", margin: "0 0 12px", padding: "8px 12px", background: "#2D2200", borderRadius: 6 }}>⚠ Primero guardá portfolios en Allocation para asignarlos.</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: "1px solid #30363D" }}>
            {["Miembro", "Portfolio", "Valor Propio", "Herencia", "Valor Total", "E[R]", "Vol", "VaR5", ""].map((h, i) => (
              <th key={i} style={{ textAlign: i < 2 ? "left" : "right", padding: "8px 6px", ...micro }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {familySummary.members.map(m => {
              const parent = m.parentId ? members.find(x => x.id === m.parentId) : null;
              const isActive = activeMemberId === m.id;
              return (
                <tr key={m.id} onClick={() => setActiveMemberId(m.id)} style={{ borderBottom: "1px solid #21262D", background: isActive ? "#0D2240" : "transparent", cursor: "pointer" }}>
                  <td style={{ padding: "8px 6px" }}>
                    <input value={m.name} onChange={e => { e.stopPropagation(); updMember(m.id, "name", e.target.value) }} onClick={e => e.stopPropagation()} style={{ background: "transparent", border: "none", color: "#F0F6FC", fontSize: 12, fontWeight: 600, outline: "none", width: 100 }} />
                    {parent && <div style={{ fontSize: 9, color: "#58A6FF" }}>↳ {m.inheritPct}% de {parent.name}</div>}
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    <select value={m.portfolioId || ""} onChange={e => { e.stopPropagation(); updMember(m.id, "portfolioId", e.target.value || null) }} onClick={e => e.stopPropagation()} style={{ background: "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: "#C9D1D9", fontSize: 11, padding: "3px 6px", outline: "none", maxWidth: 130 }}>
                      <option value="">— Ninguno —</option>
                      {saved.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: "8px 6px", textAlign: "right" }}><NF value={m.value} onChange={e => { e.stopPropagation(); updMember(m.id, "value", Number(e.target.value)) }} width={85} step={10000} color="#8B949E" /></td>
                  <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "#58A6FF" }}>
                    {parent ? <NF value={m.inheritPct} onChange={e => { e.stopPropagation(); updMember(m.id, "inheritPct", Math.max(0, Math.min(100, Number(e.target.value)))) }} width={45} step={5} color="#58A6FF" min={0} max={100} /> : <span style={{ color: "#484F58" }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, color: "#F0F6FC" }}>{fmt(m.totalValue)}</td>
                  <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "#3FB950" }}>{m.consStats.ret.toFixed(1)}%</td>
                  <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "#D29922" }}>{m.consStats.vol.toFixed(1)}%</td>
                  <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: m.consStats.var5 < 0 ? "#F85149" : "#3FB950" }}>{m.consStats.var5.toFixed(1)}%</td>
                  <td style={{ padding: "8px 6px" }}>
                    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                      <button onClick={e => { e.stopPropagation(); const idx = members.findIndex(x => x.id === m.id); moveMember(idx, -1) }} style={{ background: "none", border: "none", cursor: "pointer", color: "#6E7681", fontSize: 11, padding: "0 2px" }} title="Mover arriba">↑</button>
                      <button onClick={e => { e.stopPropagation(); const idx = members.findIndex(x => x.id === m.id); moveMember(idx, 1) }} style={{ background: "none", border: "none", cursor: "pointer", color: "#6E7681", fontSize: 11, padding: "0 2px" }} title="Mover abajo">↓</button>
                      <button onClick={e => { e.stopPropagation(); addMember(m.id) }} style={{ background: "none", border: "none", cursor: "pointer", color: "#58A6FF", fontSize: 11 }} title="Agregar hijo">+hijo</button>
                      {members.length > 1 && <button onClick={e => { e.stopPropagation(); removeMember(m.id) }} style={{ background: "none", border: "none", cursor: "pointer", color: "#F85149", fontSize: 14, marginLeft: 2 }}>×</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
            <tr style={{ borderTop: "2px solid #30363D", background: "#0D1117" }}>
              <td colSpan={4} style={{ padding: "8px 6px", fontWeight: 700, color: "#F0F6FC", fontSize: 12 }}>FAMILIA TOTAL</td>
              <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, color: "#F0F6FC" }}>{fmt(familySummary.aggVal)}</td>
              <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "#3FB950", fontWeight: 700 }}>{familySummary.aggStats.ret.toFixed(1)}%</td>
              <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "#D29922", fontWeight: 700 }}>{familySummary.aggStats.vol.toFixed(1)}%</td>
              <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: familySummary.aggStats.var5 < 0 ? "#F85149" : "#3FB950", fontWeight: 700 }}>{familySummary.aggStats.var5.toFixed(1)}%</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    {/* Constraint violation warnings */}
    {(() => {
      const warnings = [];
      familySummary.members.forEach(m => {
        if (!m.portfolioId) return;
        const sp = saved.find(s => s.id === m.portfolioId);
        if (!sp || !sp.constraints || !sp.constraints.cstOn) return;
        const cst = sp.constraints;
        const sw = sp.weights.map(w => w / 100);
        // Check locked constraints
        if (cst.locked) {
          Object.entries(cst.locked).forEach(([idx, constraint]) => {
            const i = Number(idx);
            const actual = sp.weights[i];
            if (actual === undefined || !constraint) return;
            if (constraint.type === 'fixed' && Math.abs(actual - constraint.val) > 0.5) {
              warnings.push({ member: m.name, portfolio: sp.name, msg: `${assets[i]?.name || "Asset " + i} debería ser ${constraint.val}% (es ${actual.toFixed(1)}%)`, type: "lock" });
            } else if (constraint.type === 'min' && actual < (constraint.min || 0) - 0.5) {
              warnings.push({ member: m.name, portfolio: sp.name, msg: `${assets[i]?.name || "Asset " + i} debería ser ≥${constraint.min}% (es ${actual.toFixed(1)}%)`, type: "min" });
            } else if (constraint.type === 'max' && actual > (constraint.max ?? 100) + 0.5) {
              warnings.push({ member: m.name, portfolio: sp.name, msg: `${assets[i]?.name || "Asset " + i} debería ser ≤${constraint.max}% (es ${actual.toFixed(1)}%)`, type: "max" });
            } else if (constraint.type === 'range' && (actual < (constraint.min || 0) - 0.5 || actual > (constraint.max ?? 100) + 0.5)) {
              warnings.push({ member: m.name, portfolio: sp.name, msg: `${assets[i]?.name || "Asset " + i} debería estar en ${constraint.min}-${constraint.max}% (es ${actual.toFixed(1)}%)`, type: "range" });
            }
          });
        }
        // Check illiquidity constraint
        if (cst.maxIll !== undefined) {
          const illiq = assets.reduce((s, a, i) => s + (a.liquid ? 0 : sw[i] * 100), 0);
          if (illiq > cst.maxIll) {
            warnings.push({ member: m.name, portfolio: sp.name, msg: `Ilíquido ${illiq.toFixed(1)}% > máx ${cst.maxIll}%`, type: "liquidity" });
          }
        }
      });
      return warnings.length > 0 ? (
        <div style={{ padding: 14, background: "#3D1117", borderRadius: 8, border: "1px solid #F85149", marginTop: 12 }}>
          <div style={{ fontSize: 12, color: "#F85149", fontWeight: 700, marginBottom: 8 }}>⚠ Constraint Violations</div>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: "#F97583", padding: "3px 0", display: "flex", gap: 8 }}>
              <span style={{ fontWeight: 600, color: "#F0F6FC" }}>{w.member}</span>
              <span style={{ color: "#6E7681" }}>({w.portfolio})</span>
              <span>{w.msg}</span>
            </div>
          ))}
        </div>
      ) : null;
    })()}
    {/* Member detail */}
    {(() => { const m = members.find(x => x.id === activeMemberId); if (!m) return null; const c = getMemberConsolidated(m.id); const parent = m.parentId ? members.find(x => x.id === m.parentId) : null; return (
      <div style={box}>
        <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 600, color: "#58A6FF" }}>Detalle: {m.name}</h3>
        <div style={{ display: "grid", gridTemplateColumns: parent ? "1fr 1fr" : "1fr", gap: 20 }}>
          <div>
            <div style={{ ...micro, marginBottom: 8 }}>Portfolio Propio {m.portfolioId ? `(${saved.find(s => s.id === m.portfolioId)?.name || "?"})` : "(sin asignar)"}</div>
            <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
              {assets.map((ac, i) => { const pct = c.ownWeights[i] * 100; return pct > .3 ? <div key={ac.id} style={{ width: `${pct}%`, background: ac.color }} /> : null })}
            </div>
            {assets.map((ac, i) => { const pct = c.ownWeights[i] * 100; const val = c.ownValue * c.ownWeights[i]; return pct > .3 ? (
              <div key={ac.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 6, height: 6, borderRadius: 2, background: ac.color }} /><span style={{ fontSize: 10 }}>{ac.name}</span></div>
                <div style={{ display: "flex", gap: 12 }}><span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#8B949E" }}>{pct.toFixed(1)}%</span><span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#6E7681" }}>{fmt(val)}</span></div>
              </div>) : null })}
          </div>
          {parent && (
            <div>
              <div style={{ ...micro, marginBottom: 8, color: "#58A6FF" }}>Consolidado (Propio + {m.inheritPct}% de {parent.name})</div>
              <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                {assets.map((ac, i) => { const pct = c.consWeights[i] * 100; return pct > .3 ? <div key={ac.id} style={{ width: `${pct}%`, background: ac.color }} /> : null })}
              </div>
              {assets.map((ac, i) => {
                const consPct = c.consWeights[i] * 100; const consVal = c.totalValue * c.consWeights[i];
                const parentW = getPortfolioWeights(parent.portfolioId);
                const inhFloor = (parent.value || 0) * (m.inheritPct / 100) * parentW[i];
                const breach = consVal < inhFloor - 0.01;
                return consPct > .3 ? (
                  <div key={ac.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 6, height: 6, borderRadius: 2, background: ac.color }} /><span style={{ fontSize: 10, color: breach ? "#F85149" : "#C9D1D9" }}>{ac.name}</span>{breach && <span style={{ fontSize: 8, color: "#F85149" }}>⚠</span>}</div>
                    <div style={{ display: "flex", gap: 8 }}><span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#8B949E" }}>{consPct.toFixed(1)}%</span><span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: breach ? "#F85149" : "#6E7681" }}>{fmt(consVal)}</span>{inhFloor > 0.01 && <span style={{ fontSize: 9, fontFamily: "'JetBrains Mono',monospace", color: "#484F58" }}>min:{fmt(inhFloor)}</span>}</div>
                  </div>) : null;
              })}
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #21262D", fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#58A6FF" }}>
                E[R]:{c.consStats.ret.toFixed(1)}% | Vol:{c.consStats.vol.toFixed(1)}% | Total: {fmt(c.totalValue)}
              </div>
              {(() => { const parentW = getPortfolioWeights(parent.portfolioId); const breaches = assets.map((ac, i) => { const inhFloor = (parent.value || 0) * (m.inheritPct / 100) * parentW[i]; const consVal = c.totalValue * c.consWeights[i]; return consVal < inhFloor - 0.01 ? { name: ac.name, have: consVal, need: inhFloor } : null }).filter(Boolean);
                return breaches.length > 0 ? (
                  <div style={{ marginTop: 8, padding: 8, background: "#3D1117", borderRadius: 6, border: "1px solid #F85149" }}>
                    <div style={{ fontSize: 10, color: "#F85149", fontWeight: 600 }}>⚠ Valor consolidado menor al piso de herencia</div>
                    {breaches.map(b => <div key={b.name} style={{ fontSize: 10, color: "#F85149" }}>{b.name}: {fmt(b.have)} &lt; mín {fmt(b.need)}</div>)}
                  </div>
                ) : null;
              })()}
            </div>
          )}
        </div>
      </div>
    ) })()}
  </div>
)}

{/* ═══ CONSTRAINTS ═══ */}
{tab === "constraints" && (
  <div style={box}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Constraints</h3>
      <button onClick={() => toggleCst(!cstOn)} style={{ padding: "6px 14px", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", background: cstOn ? "#0D2240" : "#21262D", border: `1px solid ${cstOn ? "#58A6FF" : "#30363D"}`, color: cstOn ? "#58A6FF" : "#C9D1D9", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>{cstOn ? "ON" : "Activar"}</button>
    </div>
    <div style={{ marginBottom: 20 }}>
      <div style={{ ...micro, marginBottom: 8 }}>Asset Constraints</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {assets.map((ac, i) => { const c = locked[i]; const active = c !== undefined; const tp = c?.type || 'none'; return (
          <div key={ac.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: active ? "#0D2240" : "#0D1117", border: `1px solid ${active ? "#58A6FF" : "#21262D"}`, borderRadius: 6, flexWrap: "wrap" }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: ac.color, flexShrink: 0 }} />
            <span style={{ fontSize: 11, minWidth: 80 }}>{ac.name}</span>
            <select value={tp} onChange={e => {
              const v = e.target.value;
              if (v === 'none') setCst(i, null);
              else if (v === 'fixed') setCst(i, { type: 'fixed', val: weights[i] });
              else if (v === 'min') setCst(i, { type: 'min', min: 0 });
              else if (v === 'max') setCst(i, { type: 'max', max: 50 });
              else if (v === 'range') setCst(i, { type: 'range', min: 5, max: 30 });
            }} style={{ padding: "3px 6px", background: "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: "#C9D1D9", fontSize: 10, outline: "none" }}>
              <option value="none">Sin constraint</option>
              <option value="fixed">Fijo (=)</option>
              <option value="min">Mínimo (≥)</option>
              <option value="max">Máximo (≤)</option>
              <option value="range">Rango (↔)</option>
            </select>
            {tp === 'fixed' && <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 9, color: "#58A6FF" }}>=</span>
              <NF value={c.val} width={48} step={1} onChange={e => { const v = Math.max(0, Math.min(100, +e.target.value)); setCst(i, { ...c, val: v }); setW(i, v) }} color="#58A6FF" />
            </div>}
            {tp === 'min' && <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 9, color: "#3FB950" }}>≥</span>
              <NF value={c.min || 0} width={48} step={1} onChange={e => setCst(i, { ...c, min: Math.max(0, Math.min(100, +e.target.value)) })} color="#3FB950" />
            </div>}
            {tp === 'max' && <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 9, color: "#D29922" }}>≤</span>
              <NF value={c.max ?? 50} width={48} step={1} onChange={e => setCst(i, { ...c, max: Math.max(0, Math.min(100, +e.target.value)) })} color="#D29922" />
            </div>}
            {tp === 'range' && <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <NF value={c.min || 0} width={42} step={1} onChange={e => setCst(i, { ...c, min: Math.max(0, Math.min(c.max ?? 100, +e.target.value)) })} color="#3FB950" />
              <span style={{ fontSize: 9, color: "#6E7681" }}>–</span>
              <NF value={c.max ?? 50} width={42} step={1} onChange={e => setCst(i, { ...c, max: Math.max(c.min || 0, Math.min(100, +e.target.value)) })} color="#D29922" />
            </div>}
            <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#484F58", marginLeft: "auto" }}>{weights[i].toFixed(1)}%{active && (weights[i] < cMin(locked, i) - 0.1 || weights[i] > cMax(locked, i) + 0.1) ? <span style={{ color: "#F85149", marginLeft: 4 }}>⚠</span> : null}</span>
          </div>
        ) })}
      </div>
    </div>
    <div>
      <div style={{ ...micro, marginBottom: 8 }}>Liquidez (Max Ilíquido: {maxIll}%)</div>
      <input type="range" min="0" max="100" step="5" value={maxIll} onChange={e => { setMaxIll(+e.target.value); setShowF(false) }} style={{ width: "100%", marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 16, padding: "12px", background: "#0D1117", borderRadius: 8, border: "1px solid #21262D" }}>
        <div><div style={{ fontSize: 9, color: "#484F58" }}>Ilíquido</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: cstOn && illPct > maxIll ? "#F85149" : "#D29922" }}>{illPct.toFixed(1)}%</div></div>
        <div><div style={{ fontSize: 9, color: "#484F58" }}>Líquido</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: "#3FB950" }}>{liqPct.toFixed(1)}%</div></div>
        <div><div style={{ fontSize: 9, color: "#484F58" }}>Status</div><div style={{ fontSize: 16, fontWeight: 700, color: !cstOn ? "#484F58" : illPct <= maxIll ? "#3FB950" : "#F85149" }}>{!cstOn ? "OFF" : illPct <= maxIll ? "✓" : "✗"}</div></div>
      </div>
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
        {assets.map((ac, i) => (<button key={ac.id} onClick={() => updAsset(i, "liquid", !ac.liquid)} style={{ padding: "4px 8px", fontSize: 10, background: ac.liquid ? "#1F3A2D" : "#2D2200", border: `1px solid ${ac.liquid ? "#238636" : "#D29922"}`, borderRadius: 4, color: ac.liquid ? "#3FB950" : "#D29922", cursor: "pointer" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: ac.color, marginRight: 4 }} />{ac.name}:{ac.liquid ? "LIQ" : "ILL"}</button>))}
      </div>
    </div>
    {/* Save / Load Constraints */}
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #21262D" }}>
      <div style={{ ...micro, marginBottom: 8 }}>Saved Constraints</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input value={cstName} onChange={e => setCstName(e.target.value)} placeholder="Nombre..." style={{ flex: 1, padding: "6px 10px", background: "#0D1117", border: "1px solid #30363D", borderRadius: 5, color: "#F0F6FC", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", outline: "none" }} />
        <button onClick={saveCst} style={{ padding: "6px 14px", fontSize: 11, background: "#1F3A2D", border: "1px solid #238636", borderRadius: 5, color: "#3FB950", cursor: "pointer", fontWeight: 600 }}>💾 Guardar</button>
      </div>
      {savedCst.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {savedCst.map(c => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: activeCstId === c.id ? "#0D2240" : "#0D1117", border: `1px solid ${activeCstId === c.id ? "#58A6FF" : "#21262D"}`, borderRadius: 6 }}>
            <span style={{ flex: 1, fontSize: 11, color: activeCstId === c.id ? "#58A6FF" : "#C9D1D9", fontWeight: activeCstId === c.id ? 600 : 400 }}>{c.name}</span>
            <span style={{ fontSize: 9, color: "#484F58", fontFamily: "'JetBrains Mono',monospace" }}>{Object.keys(c.locked || {}).length} cst</span>
            <button onClick={() => loadCst(c)} style={{ padding: "3px 8px", fontSize: 9, background: "#21262D", border: "1px solid #30363D", borderRadius: 4, color: "#C9D1D9", cursor: "pointer" }}>Cargar</button>
            <button onClick={() => removeCst(c.id)} style={{ background: "none", border: "none", color: "#F85149", cursor: "pointer", fontSize: 12, padding: 0 }}>×</button>
          </div>
        ))}
      </div>}
    </div>
  </div>
)}

{/* ═══ RISK ═══ */}
{tab === "risk" && (
  <div style={box}>
    <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Risk Budget {activeConsStats ? <span style={{ fontSize: 11, color: "#58A6FF", fontWeight: 400 }}>({activeConsStats.name} consolidado)</span> : null}</h3>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      <div>{(activeConsStats ? activeConsStats.riskBudget : riskBudget).filter(r => r.weight > .3).sort((a, b) => b.pctRisk - a.pctRisk).map(rb => (
        <div key={rb.id} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}><span style={{ fontSize: 11 }}>{rb.name}</span><span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: rb.pctRisk > rb.weight * 1.5 ? "#F85149" : rb.pctRisk < rb.weight * .5 ? "#3FB950" : "#D29922" }}>risk:{rb.pctRisk.toFixed(1)}%</span></div>
          <div style={{ height: 5, background: "#21262D", borderRadius: 3, overflow: "hidden" }}><div style={{ height: "100%", width: `${Math.min(100, Math.max(0, rb.pctRisk))}%`, background: rb.color, borderRadius: 3, transition: "width .3s" }} /></div>
        </div>))}</div>
      <div>
        <div style={{ ...micro, marginBottom: 8 }}>ERC Optimal (ex zero-vol)</div>
        {assets.map((ac, i) => ercW[i] > .005 ? <div key={ac.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}><span style={{ fontSize: 11 }}>{ac.name}</span><span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#3FB950" }}>{(ercW[i] * 100).toFixed(1)}%</span></div> : null)}
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #21262D", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#58A6FF" }}>E[R]:{ercStats.ret.toFixed(1)}% | Vol:{ercStats.vol.toFixed(1)}%</div>
      </div>
    </div>
  </div>
)}

{/* ═══ FRONTIER ═══ */}
{tab === "frontier" && (() => {
  const isSavedVisible = (id) => fShow.saved && (fShowSaved[id] !== false);
  const isMemberVisible = (id) => fShow.members && (fShowMembers[id] !== false);

  // Dynamic axes based on all visible points
  const allPts = [];
  if (frontier) frontier.points.forEach(p => allPts.push(p));
  if (fShow.editor) allPts.push({ vol: stats.vol, ret: stats.ret });
  if (fShow.assets) assets.forEach(a => allPts.push({ vol: a.annualizedVol, ret: a.expectedReturn }));
  if (fShow.saved) savedStats.filter(s => isSavedVisible(s.id)).forEach(s => allPts.push({ vol: s.vol, ret: s.ret }));
  if (fShow.members) familySummary.members.filter(m => m.totalValue > 0 && m.portfolioId && isMemberVisible(m.id)).forEach(m => allPts.push({ vol: m.consStats.vol, ret: m.consStats.ret }));
  if (fShow.familia && familySummary.aggVal > 0) allPts.push({ vol: familySummary.aggStats.vol, ret: familySummary.aggStats.ret });

  const pad = 0.5;
  const volMin = allPts.length > 0 ? Math.max(0, Math.floor(Math.min(...allPts.map(p => p.vol)) - pad)) : 0;
  const volMax = allPts.length > 0 ? Math.ceil(Math.max(...allPts.map(p => p.vol)) + pad) : 30;
  const retMin = allPts.length > 0 ? Math.max(0, Math.floor(Math.min(...allPts.map(p => p.ret)) - pad)) : 0;
  const retMax = allPts.length > 0 ? Math.ceil(Math.max(...allPts.map(p => p.ret)) + pad) : 22;
  const vRange = Math.max(1, volMax - volMin), rRange = Math.max(1, retMax - retMin);

  const toSvgX = v => 60 + ((v - volMin) / vRange) * 620;
  const toSvgY = v => 370 - ((v - retMin) / rRange) * 340;
  const inView = (vol, ret) => vol >= volMin && vol <= volMax && ret >= retMin && ret <= retMax;

  // Grid tick generation
  const volStep = vRange <= 5 ? 0.5 : vRange <= 15 ? 1 : vRange <= 30 ? 2 : 5;
  const retStep = rRange <= 5 ? 0.5 : rRange <= 15 ? 1 : rRange <= 20 ? 2 : 5;
  const volTicks = []; for (let v = Math.ceil(volMin / volStep) * volStep; v <= volMax; v += volStep) volTicks.push(+v.toFixed(1));
  const retTicks = []; for (let v = Math.ceil(retMin / retStep) * retStep; v <= retMax; v += retStep) retTicks.push(+v.toFixed(1));

  // Collect labeled points for offset calculation (only visible ones)
  const labeledPts = [];
  if (fShow.editor) labeledPts.push({ vol: stats.vol, ret: stats.ret, name: "Editor", color: "#F85149" });
  if (fShow.saved) savedStats.filter(s => isSavedVisible(s.id)).forEach(s => labeledPts.push({ vol: s.vol, ret: s.ret, name: s.name, color: s.color }));
  if (fShow.members) familySummary.members.filter(m => m.totalValue > 0 && m.portfolioId && isMemberVisible(m.id)).forEach(m => labeledPts.push({ vol: m.consStats.vol, ret: m.consStats.ret, name: m.name, color: "#58A6FF" }));
  if (fShow.familia && familySummary.aggVal > 0) labeledPts.push({ vol: familySummary.aggStats.vol, ret: familySummary.aggStats.ret, name: "Familia", color: "#C9D1D9" });

  const offsets = labeledPts.map((p, i) => {
    let ox = 10, oy = 3;
    for (let j = 0; j < i; j++) {
      const dx = Math.abs(toSvgX(p.vol) - toSvgX(labeledPts[j].vol));
      const dy = Math.abs(toSvgY(p.ret) - toSvgY(labeledPts[j].ret));
      if (dx < 60 && dy < 14) { oy = oy > 0 ? -12 : 16; ox = dx < 30 ? -50 : 10; }
    }
    return { ox, oy };
  });

  let oi = 0;
  const nextOi = () => offsets[oi++] || { ox: 10, oy: 3 };

  const handleFrontierClick = e => {
    if (!frontier || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = 700 / rect.width, sy = 400 / rect.height;
    const cx = (e.clientX - rect.left) * sx, cy = (e.clientY - rect.top) * sy;
    let best = null, bd = Infinity;
    for (const p of frontier.points) {
      const px = toSvgX(p.vol), py = toSvgY(p.ret);
      const d = Math.sqrt(((px - cx) / 620) ** 2 + ((py - cy) / 340) ** 2);
      if (d < bd) { bd = d; best = p }
    }
    if (best && bd < .08) { setSelPt(best); setWeights(best.weights.map(w => Math.round(w * 1000) / 10)) }
  };

  const toggleF = k => setFShow(p => ({ ...p, [k]: !p[k] }));
  const chk = (k, label, color) => (
    <label key={k} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color, cursor: "pointer", userSelect: "none" }}>
      <input type="checkbox" checked={fShow[k]} onChange={() => toggleF(k)} style={{ accentColor: color, width: 12, height: 12 }} />{label}
    </label>
  );

  return (
  <div style={box}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Frontier — Clickeá para seleccionar</h3>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {chk("editor", "Editor", "#F85149")}
        {chk("assets", "Assets", "#8B949E")}
        {chk("saved", "Portfolios", "#58A6FF")}
        {chk("members", "Miembros", "#58A6FF")}
        {chk("familia", "Familia", "#C9D1D9")}
      </div>
    </div>
    {/* Per-item selectors */}
    {fShow.saved && saved.length > 1 && (
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontSize: 9, color: "#484F58", lineHeight: "22px" }}>Portfolios:</span>
        {saved.map(s => (<label key={s.id} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: isSavedVisible(s.id) ? s.color : "#484F58", cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={isSavedVisible(s.id)} onChange={() => setFShowSaved(p => ({ ...p, [s.id]: !(p[s.id] !== false) }))} style={{ accentColor: s.color, width: 10, height: 10 }} />{s.name}
        </label>))}
      </div>
    )}
    {fShow.members && familySummary.members.filter(m => m.totalValue > 0 && m.portfolioId).length > 1 && (
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontSize: 9, color: "#484F58", lineHeight: "22px" }}>Miembros:</span>
        {familySummary.members.filter(m => m.totalValue > 0 && m.portfolioId).map(m => (<label key={m.id} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: isMemberVisible(m.id) ? "#58A6FF" : "#484F58", cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={isMemberVisible(m.id)} onChange={() => setFShowMembers(p => ({ ...p, [m.id]: !(p[m.id] !== false) }))} style={{ accentColor: "#58A6FF", width: 10, height: 10 }} />{m.name}
        </label>))}
      </div>
    )}
    {/* Constraint selector in Frontier */}
    {savedCst.length > 0 && (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 10, color: "#484F58" }}>Constraints:</span>
        <button onClick={() => { setLocked({}); setCstOn(false); setActiveCstId(null); setShowF(true) }} style={{ padding: "3px 8px", fontSize: 9, background: !activeCstId && !cstOn ? "#21262D" : "#0D1117", border: `1px solid ${!activeCstId && !cstOn ? "#30363D" : "#21262D"}`, borderRadius: 4, color: !activeCstId && !cstOn ? "#F0F6FC" : "#484F58", cursor: "pointer" }}>Ninguno</button>
        {savedCst.map(c => (
          <button key={c.id} onClick={() => { setLocked(c.locked || {}); setMaxIll(c.maxIll ?? 50); setCstOn(c.cstOn ?? true); setActiveCstId(c.id); setShowF(true) }} style={{ padding: "3px 8px", fontSize: 9, background: activeCstId === c.id ? "#0D2240" : "#0D1117", border: `1px solid ${activeCstId === c.id ? "#58A6FF" : "#21262D"}`, borderRadius: 4, color: activeCstId === c.id ? "#58A6FF" : "#C9D1D9", cursor: "pointer" }}>{c.name}</button>
        ))}
      </div>
    )}
    {cstOn && <p style={{ fontSize: 10, color: "#58A6FF", margin: "0 0 8px" }}>🔒 Constraints: {activeCstId ? savedCst.find(c => c.id === activeCstId)?.name || "Custom" : "Custom"}</p>}
    {selPt && <div style={{ display: "flex", gap: 10, padding: "8px 12px", background: "#0D1117", borderRadius: 6, border: "1px solid #58A6FF", margin: "6px 0 10px", flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: 11, color: "#58A6FF", fontWeight: 600 }}>Selected:</span>
      <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#3FB950" }}>Ret {selPt.ret.toFixed(1)}%</span>
      <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#D29922" }}>Vol {selPt.vol.toFixed(1)}%</span>
      <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#8B949E" }}>VaR5: {(selPt.ret - 1.645 * selPt.vol).toFixed(1)}%</span>
      <div style={{ width: "100%", display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
        {assets.map((ac, i) => { const pct = (selPt.weights[i] || 0) * 100; return pct > 0.5 ? (
          <span key={ac.id} style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: 2, background: ac.color, display: "inline-block" }} />
            <span style={{ color: "#C9D1D9" }}>{ac.name}:</span>
            <span style={{ color: ac.color, fontWeight: 600 }}>{pct.toFixed(1)}%</span>
          </span>
        ) : null })}
      </div>
    </div>}
    {frontier && (
      <svg ref={svgRef} viewBox="0 0 700 400" style={{ width: "100%", background: "#0D1117", borderRadius: 8, border: "1px solid #21262D", cursor: "crosshair" }} onClick={handleFrontierClick}>
        {/* Grid */}
        {retTicks.map(v => { const y = toSvgY(v); return <g key={`y${v}`}><line x1="60" y1={y} x2="680" y2={y} stroke="#21262D" strokeWidth=".5" /><text x="52" y={y + 4} textAnchor="end" fill="#484F58" fontSize="8" fontFamily="JetBrains Mono">{v}%</text></g> })}
        {volTicks.map(v => { const x = toSvgX(v); return <g key={`x${v}`}><line x1={x} y1="30" x2={x} y2="370" stroke="#21262D" strokeWidth=".5" /><text x={x} y="386" textAnchor="middle" fill="#484F58" fontSize="8" fontFamily="JetBrains Mono">{v}%</text></g> })}
        <text x="370" y="399" textAnchor="middle" fill="#6E7681" fontSize="9" fontFamily="JetBrains Mono">Volatility</text>
        <text x="12" y="200" textAnchor="middle" fill="#6E7681" fontSize="9" fontFamily="JetBrains Mono" transform="rotate(-90,12,200)">Return</text>
        {/* Scatter */}
        {frontier.points.map((p, i) => { const x = toSvgX(p.vol); const y = toSvgY(p.ret); return (x >= 58 && x <= 682 && y >= 28 && y <= 372) ? <circle key={i} cx={x} cy={y} r="1.3" fill="#30363D" opacity=".25" /> : null })}
        {/* Frontier line */}
        {frontier.frontier.length > 2 && <polyline points={frontier.frontier.filter(p => inView(p.vol, p.ret)).map(p => `${toSvgX(p.vol)},${toSvgY(p.ret)}`).join(" ")} fill="none" stroke="#D29922" strokeWidth="2.5" />}
        {frontier.frontier.filter(p => inView(p.vol, p.ret)).map((p, i) => <circle key={`fd${i}`} cx={toSvgX(p.vol)} cy={toSvgY(p.ret)} r="3" fill="#D29922" opacity=".4" />)}
        {/* CML line */}
        {levOn && (() => { const rf = bc; const bs = pStats(nw, assets, corr); const slope = (bs.ret - rf) / (bs.vol + 1e-12); const er = Math.min(retMax, rf + slope * volMax); return <line x1={toSvgX(0)} y1={toSvgY(rf)} x2={toSvgX(volMax)} y2={toSvgY(er)} stroke="#F85149" strokeWidth="1.5" strokeDasharray="6 3" opacity=".5" /> })()}
        {/* Individual assets */}
        {fShow.assets && assets.map(ac => { if (!inView(ac.annualizedVol, ac.expectedReturn)) return null; const x = toSvgX(ac.annualizedVol); const y = toSvgY(ac.expectedReturn); return <g key={ac.id}><circle cx={x} cy={y} r="4" fill={ac.color} opacity=".6" stroke={ac.color} strokeWidth=".5" /><text x={x + 7} y={y + 3} fill={ac.color} fontSize="7" fontFamily="JetBrains Mono" opacity=".8">{ac.name}</text></g> })}
        {/* Saved portfolios */}
        {fShow.saved && savedStats.filter(s => isSavedVisible(s.id)).map(s => { if (!inView(s.vol, s.ret)) return null; const x = toSvgX(s.vol); const y = toSvgY(s.ret); return <g key={s.id}><circle cx={x} cy={y} r="6" fill={s.color} stroke="#F0F6FC" strokeWidth="1.5" /><text x={x + 10} y={y + 3} fill={s.color} fontSize="8" fontWeight="600" fontFamily="JetBrains Mono">{s.name}</text></g> })}
        {/* Editor (current) */}
        {fShow.editor && inView(stats.vol, stats.ret) && (() => { const o = nextOi(); return <g>
          <circle cx={toSvgX(stats.vol)} cy={toSvgY(stats.ret)} r="8" fill="#F85149" stroke="#F0F6FC" strokeWidth="2" />
          <text x={toSvgX(stats.vol) + o.ox} y={toSvgY(stats.ret) + o.oy} fill="#F85149" fontSize="9" fontWeight="600" fontFamily="JetBrains Mono">Editor</text>
        </g> })()}
        {/* Family members */}
        {fShow.members && familySummary.members.filter(m => m.totalValue > 0 && m.portfolioId && isMemberVisible(m.id)).map((m, mi) => {
          if (!inView(m.consStats.vol, m.consStats.ret)) return null;
          const x = toSvgX(m.consStats.vol); const y = toSvgY(m.consStats.ret);
          const o = nextOi();
          return <g key={m.id}>
            <circle cx={x} cy={y} r="12" fill="#58A6FF" opacity=".12" />
            <rect x={x - 7} y={y - 7} width="14" height="14" rx="3" fill="#161B22" stroke="#58A6FF" strokeWidth="2.5" />
            <text x={x} y={y + 3} textAnchor="middle" fill="#58A6FF" fontSize="7" fontWeight="700" fontFamily="JetBrains Mono">{m.name.charAt(0)}</text>
            <line x1={x + 7} y1={y} x2={x + o.ox - 2} y2={y + o.oy - 3} stroke="#58A6FF" strokeWidth=".7" opacity=".5" />
            <text x={x + o.ox} y={y + o.oy} fill="#58A6FF" fontSize="8" fontWeight="700" fontFamily="JetBrains Mono">{m.name}</text>
          </g> })}
        {/* Family aggregate */}
        {fShow.familia && familySummary.aggVal > 0 && inView(familySummary.aggStats.vol, familySummary.aggStats.ret) && (() => {
          const x = toSvgX(familySummary.aggStats.vol); const y = toSvgY(familySummary.aggStats.ret);
          const o = nextOi();
          return <g>
            <circle cx={x} cy={y} r="14" fill="#C9D1D9" opacity=".08" />
            <polygon points={`${x},${y - 9} ${x - 8},${y + 6} ${x + 8},${y + 6}`} fill="#161B22" stroke="#C9D1D9" strokeWidth="2.5" />
            <line x1={x + 8} y1={y} x2={x + o.ox - 2} y2={y + o.oy - 3} stroke="#C9D1D9" strokeWidth=".7" opacity=".5" />
            <text x={x + o.ox} y={y + o.oy} fill="#C9D1D9" fontSize="8" fontWeight="700" fontFamily="JetBrains Mono">Familia</text>
          </g> })()}
        {/* Selected point indicator */}
        {selPt && inView(selPt.vol, selPt.ret) && <circle cx={toSvgX(selPt.vol)} cy={toSvgY(selPt.ret)} r="9" fill="none" stroke="#58A6FF" strokeWidth="2.5" strokeDasharray="4 2" />}
      </svg>
    )}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10, fontSize: 10, alignItems: "center" }}>
      <span style={{ color: "#D29922" }}>— Efficient Frontier</span>
    </div>
  </div>
  );
})()} 

{/* ═══ COMPARE ═══ */}
{tab === "compare" && (() => {
  // Resolve a compare item to { name, weights (fractions), value ($ or null), stats, color }
  const resolveItem = (item) => {
    if (item.type === "portfolio") {
      const sp = saved.find(s => s.id === item.id);
      if (!sp) return null;
      const w = sp.weights.map(v => v / 100);
      return { name: sp.name, weights: w, value: null, stats: pStats(w, assets, corr), color: sp.color };
    }
    if (item.type === "member") {
      const m = members.find(x => x.id === item.id);
      if (!m) return null;
      const c = getMemberConsolidated(m.id);
      if (item.mode === "consolidated") {
        return { name: `${m.name} (cons.)`, weights: c.consWeights, value: c.totalValue, stats: c.consStats, color: "#58A6FF" };
      } else {
        const ow = getPortfolioWeights(m.portfolioId);
        return { name: `${m.name} (indiv.)`, weights: ow, value: m.value, stats: pStats(ow, assets, corr), color: "#B392F0" };
      }
    }
    if (item.type === "editor") {
      return { name: "Editor", weights: nw, value: totalAUM, stats, color: "#F85149" };
    }
    return null;
  };

  const resolved = cmpItems.map(resolveItem).filter(Boolean);
  const hasValue = resolved.some(r => r.value != null);

  // Target stats
  const tgtStats = cmpTarget ? pStats(cmpTarget, assets, corr) : null;

  return (
  <div style={box}>
    <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>⚖ Comparar</h3>

    {/* Add items */}
    <div style={{ marginBottom: 16 }}>
      <div style={{ ...micro, marginBottom: 8 }}>Agregar al comparador</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button onClick={() => setCmpItems(p => [...p, { type: "editor", id: "editor" }])} style={{ padding: "4px 10px", fontSize: 10, background: "#3D1117", border: "1px solid #F85149", borderRadius: 4, color: "#F85149", cursor: "pointer" }}>+ Editor</button>
        {saved.map(s => (
          <button key={s.id} onClick={() => setCmpItems(p => [...p, { type: "portfolio", id: s.id }])} style={{ padding: "4px 10px", fontSize: 10, background: "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: "#C9D1D9", cursor: "pointer" }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: s.color, display: "inline-block", marginRight: 4 }} />{s.name}
          </button>
        ))}
        {members.map(m => (
          <span key={m.id} style={{ display: "inline-flex", gap: 2 }}>
            <button onClick={() => setCmpItems(p => [...p, { type: "member", id: m.id, mode: "individual" }])} style={{ padding: "4px 8px", fontSize: 10, background: "#0D1117", border: "1px solid #B392F0", borderRadius: "4px 0 0 4px", color: "#B392F0", cursor: "pointer" }}>{m.name} indiv.</button>
            <button onClick={() => setCmpItems(p => [...p, { type: "member", id: m.id, mode: "consolidated" }])} style={{ padding: "4px 8px", fontSize: 10, background: "#0D1117", border: "1px solid #58A6FF", borderRadius: "0 4px 4px 0", color: "#58A6FF", cursor: "pointer" }}>cons.</button>
          </span>
        ))}
      </div>
    </div>

    {/* Active items */}
    {resolved.length > 0 && (
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {cmpItems.map((item, idx) => { const r = resolveItem(item); if (!r) return null; return (
            <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", background: "#0D1117", border: `1px solid ${r.color}`, borderRadius: 4, fontSize: 10, color: r.color }}>
              {r.name}
              <button onClick={() => setCmpItems(p => p.filter((_, i) => i !== idx))} style={{ background: "none", border: "none", color: "#F85149", cursor: "pointer", fontSize: 11, padding: 0, marginLeft: 2 }}>×</button>
            </span>
          ) })}
          <button onClick={() => setCmpItems([])} style={{ padding: "3px 8px", fontSize: 9, background: "#21262D", border: "1px solid #30363D", borderRadius: 4, color: "#6E7681", cursor: "pointer" }}>Limpiar</button>
        </div>

        {/* Stats comparison */}
        <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", marginBottom: 16 }}>
          <thead><tr style={{ borderBottom: "2px solid #30363D" }}>
            <th style={{ textAlign: "left", padding: "6px 4px", ...micro }}>Metric</th>
            {resolved.map((r, i) => <th key={i} style={{ textAlign: "center", padding: "6px 4px", color: r.color, fontSize: 10, fontFamily: "'JetBrains Mono',monospace" }}>{r.name}</th>)}
            {tgtStats && <th style={{ textAlign: "center", padding: "6px 4px", color: "#D29922", fontSize: 10, fontFamily: "'JetBrains Mono',monospace" }}>🎯 Target</th>}
          </tr></thead>
          <tbody>
            {[
              { l: "E[R]", fn: s => `${s.ret.toFixed(1)}%`, c: "#3FB950" },
              { l: "Vol", fn: s => `${s.vol.toFixed(1)}%`, c: "#D29922" },
              { l: "VaR 5%", fn: s => `${s.var5.toFixed(1)}%`, c: s => s.var5 < 0 ? "#F85149" : "#3FB950" },
              { l: "Sharpe", fn: s => ((s.ret - 3.5) / (s.vol + 1e-12)).toFixed(2), c: "#58A6FF" },
            ].map(row => (
              <tr key={row.l} style={{ borderBottom: "1px solid #21262D" }}>
                <td style={{ padding: "5px 4px", fontSize: 10, color: "#6E7681" }}>{row.l}</td>
                {resolved.map((r, i) => <td key={i} style={{ textAlign: "center", padding: "5px 4px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, fontWeight: 600, color: typeof row.c === "function" ? row.c(r.stats) : row.c }}>{row.fn(r.stats)}</td>)}
                {tgtStats && <td style={{ textAlign: "center", padding: "5px 4px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, fontWeight: 600, color: typeof row.c === "function" ? row.c(tgtStats) : row.c }}>{row.fn(tgtStats)}</td>}
              </tr>
            ))}
            {hasValue && <tr style={{ borderBottom: "1px solid #21262D" }}>
              <td style={{ padding: "5px 4px", fontSize: 10, color: "#6E7681" }}>Valor</td>
              {resolved.map((r, i) => <td key={i} style={{ textAlign: "center", padding: "5px 4px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "#8B949E" }}>{r.value != null ? fmt(r.value) : "—"}</td>)}
              {tgtStats && <td style={{ textAlign: "center", padding: "5px 4px", color: "#484F58" }}>—</td>}
            </tr>}
          </tbody>
        </table>

        {/* Per-asset comparison */}
        <div style={{ ...micro, marginBottom: 8 }}>Weights por Asset</div>
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: "2px solid #30363D" }}>
            <th style={{ textAlign: "left", padding: "5px 4px", ...micro }}>Asset</th>
            {resolved.map((r, i) => <th key={i} style={{ textAlign: "center", padding: "5px 4px", color: r.color, fontSize: 9, fontFamily: "'JetBrains Mono',monospace" }}>{r.name}</th>)}
            {tgtStats && <th style={{ textAlign: "center", padding: "5px 4px", color: "#D29922", fontSize: 9, fontFamily: "'JetBrains Mono',monospace" }}>🎯 Target</th>}
            {tgtStats && resolved.length > 0 && <th style={{ textAlign: "center", padding: "5px 4px", color: "#F85149", fontSize: 9, fontFamily: "'JetBrains Mono',monospace" }}>Δ vs {resolved[cmpDeltaIdx]?.name || resolved[0]?.name}</th>}
          </tr></thead>
          <tbody>
            {assets.map((ac, ai) => {
              const anyVisible = resolved.some(r => r.weights[ai] > 0.003) || (cmpTarget && cmpTarget[ai] > 0.003);
              if (!anyVisible) return null;
              return (
                <tr key={ac.id} style={{ borderBottom: "1px solid #21262D" }}>
                  <td style={{ padding: "4px", display: "flex", alignItems: "center", gap: 4 }}><div style={{ width: 6, height: 6, borderRadius: 2, background: ac.color }} />{ac.name}</td>
                  {resolved.map((r, i) => {
                    const pct = r.weights[ai] * 100;
                    const dv = r.value != null ? r.value * r.weights[ai] : null;
                    return <td key={i} style={{ textAlign: "center", padding: "4px", fontFamily: "'JetBrains Mono',monospace" }}>
                      <span style={{ color: "#C9D1D9" }}>{pct.toFixed(1)}%</span>
                      {dv != null && <div style={{ fontSize: 8, color: "#6E7681" }}>{fmt(Math.round(dv))}</div>}
                    </td>;
                  })}
                  {cmpTarget && <td style={{ textAlign: "center", padding: "4px", fontFamily: "'JetBrains Mono',monospace", color: "#D29922" }}>{(cmpTarget[ai] * 100).toFixed(1)}%</td>}
                  {cmpTarget && resolved.length > 0 && (() => {
                    const base = resolved[cmpDeltaIdx] || resolved[0];
                    const delta = (cmpTarget[ai] - base.weights[ai]) * 100;
                    const dv = base.value != null ? delta / 100 * base.value : null;
                    return <td style={{ textAlign: "center", padding: "4px", fontFamily: "'JetBrains Mono',monospace", color: delta > 0.05 ? "#3FB950" : delta < -0.05 ? "#F85149" : "#484F58" }}>
                      {delta > 0 ? "+" : ""}{delta.toFixed(1)}%
                      {dv != null && <div style={{ fontSize: 8 }}>{dv > 0 ? "+" : ""}{fmt(Math.round(dv))}</div>}
                    </td>;
                  })()}
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>

        {/* Target selector */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #21262D" }}>
          <div style={{ ...micro, marginBottom: 8 }}>🎯 Target (desde Frontier, Portfolio o Persona)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {selPt && <button onClick={() => setCmpTarget(selPt.weights)} style={{ padding: "4px 10px", fontSize: 10, background: "#2D2200", border: "1px solid #D29922", borderRadius: 4, color: "#D29922", cursor: "pointer" }}>Frontier seleccionado (Ret:{selPt.ret.toFixed(1)}% Vol:{selPt.vol.toFixed(1)}%)</button>}
            <button onClick={() => setCmpTarget(nw)} style={{ padding: "4px 10px", fontSize: 10, background: "#3D1117", border: "1px solid #F85149", borderRadius: 4, color: "#F85149", cursor: "pointer" }}>Editor actual</button>
            {saved.map(s => (
              <button key={s.id} onClick={() => setCmpTarget(s.weights.map(w => w / 100))} style={{ padding: "4px 10px", fontSize: 10, background: "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: "#C9D1D9", cursor: "pointer" }}>{s.name}</button>
            ))}
            {members.filter(m => m.portfolioId).map(m => {
              const c = getMemberConsolidated(m.id);
              return (
                <span key={m.id} style={{ display: "inline-flex", gap: 2 }}>
                  <button onClick={() => setCmpTarget(getPortfolioWeights(m.portfolioId))} style={{ padding: "4px 8px", fontSize: 10, background: "#0D1117", border: "1px solid #B392F0", borderRadius: "4px 0 0 4px", color: "#B392F0", cursor: "pointer" }}>{m.name} indiv.</button>
                  <button onClick={() => setCmpTarget(c.consWeights)} style={{ padding: "4px 8px", fontSize: 10, background: "#0D1117", border: "1px solid #58A6FF", borderRadius: "0 4px 4px 0", color: "#58A6FF", cursor: "pointer" }}>cons.</button>
                </span>
              );
            })}
            {cmpTarget && <button onClick={() => setCmpTarget(null)} style={{ padding: "4px 10px", fontSize: 10, background: "#21262D", border: "1px solid #30363D", borderRadius: 4, color: "#6E7681", cursor: "pointer" }}>Quitar target</button>}
          </div>
          {tgtStats && <div style={{ marginTop: 4, fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#D29922" }}>
            Target: E[R]:{tgtStats.ret.toFixed(1)}% | Vol:{tgtStats.vol.toFixed(1)}% | Sharpe:{((tgtStats.ret - 3.5) / (tgtStats.vol + 1e-12)).toFixed(2)}
          </div>}
          {/* Delta base selector */}
          {tgtStats && resolved.length > 1 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ ...micro, marginBottom: 6 }}>Δ calcular contra:</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {resolved.map((r, i) => (
                  <button key={i} onClick={() => setCmpDeltaIdx(i)} style={{ padding: "3px 8px", fontSize: 10, background: cmpDeltaIdx === i ? "#0D2240" : "#0D1117", border: `1px solid ${cmpDeltaIdx === i ? r.color : "#21262D"}`, borderRadius: 4, color: cmpDeltaIdx === i ? r.color : "#6E7681", cursor: "pointer", fontWeight: cmpDeltaIdx === i ? 600 : 400 }}>{r.name}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    )}

    {resolved.length === 0 && <p style={{ fontSize: 11, color: "#484F58" }}>Agregá portfolios o personas para comparar. Podés elegir un target desde la Frontier.</p>}
  </div>
  );
})()}

{/* ═══ LEVERAGE ═══ */}
{tab === "leverage" && (
  <div style={box}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>⚡ Leverage</h3>
      <button onClick={() => setLevOn(!levOn)} style={{ padding: "6px 14px", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", background: levOn ? "#3D1117" : "#21262D", border: `1px solid ${levOn ? "#F85149" : "#30363D"}`, color: levOn ? "#F85149" : "#C9D1D9", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>{levOn ? "Desactivar" : "Activar"}</button>
    </div>
    {levOn && (<>
      <div style={{ marginBottom: 12 }}>
        <div style={{ ...micro, marginBottom: 8 }}>Costo de fondeo: {bc}%</div>
        <input type="range" min="2" max="8" step=".25" value={bc} onChange={e => setBc(+e.target.value)} style={{ width: "100%", marginBottom: 12 }} />
      </div>
      <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => setLevRatios(Object.fromEntries(assets.map((_, i) => [i, 1.5])))} style={{ padding: "4px 10px", fontSize: 10, background: "#3D1117", border: "1px solid #F85149", borderRadius: 4, color: "#F85149", cursor: "pointer" }}>All 1.5x</button>
        <button onClick={() => setLevRatios(Object.fromEntries(assets.map((_, i) => [i, 2])))} style={{ padding: "4px 10px", fontSize: 10, background: "#3D1117", border: "1px solid #F85149", borderRadius: 4, color: "#F85149", cursor: "pointer" }}>All 2x</button>
        <button onClick={() => setLevRatios({})} style={{ padding: "4px 10px", fontSize: 10, background: "#21262D", border: "1px solid #30363D", borderRadius: 4, color: "#C9D1D9", cursor: "pointer" }}>Reset (1x)</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
        {assets.map((ac, i) => { const r = levRatios[i] || 1; const isLev = r > 1; return (
          <div key={ac.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", background: isLev ? "#3D1117" : "#0D1117", border: `1px solid ${isLev ? "#F85149" : "#21262D"}`, borderRadius: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: ac.color, flexShrink: 0 }} />
            <span style={{ fontSize: 11, minWidth: 90, color: isLev ? "#F0F6FC" : "#6E7681" }}>{ac.name}</span>
            <input type="range" min="1" max="3" step=".1" value={r} onChange={e => setLevRatios(p => ({ ...p, [i]: +e.target.value }))} style={{ flex: 1, height: 4 }} />
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: isLev ? "#F85149" : "#484F58", minWidth: 36, textAlign: "right" }}>{r.toFixed(1)}x</span>
          </div>
        ) })}
      </div>
      <div style={{ padding: 12, background: "#0D1117", borderRadius: 8, border: "1px solid #21262D" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          {[{ l: "E[R]", v: `${stats.ret.toFixed(1)}%`, c: "#3FB950" }, { l: "Vol", v: `${stats.vol.toFixed(1)}%`, c: "#D29922" }, { l: "VaR5", v: `${stats.var5.toFixed(1)}%`, c: stats.var5 < 0 ? "#F85149" : "#3FB950" }, { l: "Exposure", v: `${(stats.totalExposure * 100).toFixed(0)}%`, c: "#F85149" }].map(m => (<div key={m.l}><div style={{ fontSize: 9, color: "#484F58" }}>{m.l}</div><div style={{ fontSize: 16, fontWeight: 700, color: m.c, fontFamily: "'JetBrains Mono',monospace" }}>{m.v}</div></div>))}
        </div>
        {Object.keys(levRatios).filter(k => levRatios[k] > 1).length > 0 && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #21262D", fontSize: 10, color: "#8B949E" }}>
            Apalancados: {Object.keys(levRatios).filter(k => levRatios[k] > 1).map(k => `${assets[+k]?.name} ${levRatios[k]}x`).join(", ")}
          </div>
        )}
      </div>
    </>)}
  </div>
)}

{/* ═══ ASSUMPTIONS ═══ */}
{tab === "data" && (
  <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Returns & Vol</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={addAsset} style={{ padding: "4px 12px", fontSize: 11, background: "#1F3A2D", border: "1px solid #238636", borderRadius: 5, color: "#3FB950", cursor: "pointer", fontWeight: 600 }}>+ Asset</button>
          <button onClick={resetAll} style={{ padding: "4px 12px", fontSize: 11, background: "#21262D", border: "1px solid #30363D", borderRadius: 5, color: "#C9D1D9", cursor: "pointer" }}>↺ Reset</button>
        </div>
      </div>
      <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
        <thead><tr style={{ borderBottom: "1px solid #30363D" }}>{["", "Asset", "E[R]%", "Vol%", "VaR5", "Liq", ""].map((h, i) => (<th key={i} style={{ textAlign: i <= 1 ? "left" : "center", padding: "6px 3px", ...micro }}>{h}</th>))}</tr></thead>
        <tbody>{assets.map((ac, i) => { const v5 = ac.expectedReturn - 1.645 * ac.annualizedVol; return (
          <tr key={ac.id} style={{ borderBottom: "1px solid #21262D" }}>
            <td style={{ padding: "6px 3px" }}><div style={{ width: 10, height: 10, borderRadius: 3, background: ac.color }} /></td>
            <td style={{ padding: "6px 3px" }}><input value={ac.name} onChange={e => { const nv = e.target.value; setAssets(p => { const na = p.map((a, j) => j === i ? { ...a, name: nv } : a); dbSyncAssumptions(na, corr); return na }); setMod(true) }} style={{ background: "transparent", border: "none", color: "#F0F6FC", fontSize: 11, fontWeight: 500, outline: "none", width: 100 }} /></td>
            <td style={{ textAlign: "center", padding: "6px 3px" }}><NF value={ac.expectedReturn} onChange={e => updAsset(i, "expectedReturn", e.target.value)} color="#3FB950" width={52} /></td>
            <td style={{ textAlign: "center", padding: "6px 3px" }}><NF value={ac.annualizedVol} onChange={e => updAsset(i, "annualizedVol", e.target.value)} color="#D29922" width={52} /></td>
            <td style={{ textAlign: "center", padding: "6px 3px", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: v5 < 0 ? "#F85149" : "#3FB950" }}>{v5.toFixed(1)}%</td>
            <td style={{ textAlign: "center", padding: "6px 3px" }}><button onClick={() => updAsset(i, "liquid", !ac.liquid)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: ac.liquid ? "#3FB950" : "#D29922" }}>{ac.liquid ? "LIQ" : "ILL"}</button></td>
            <td style={{ textAlign: "center", padding: "6px 3px" }}>{assets.length > 2 && <button onClick={() => removeAsset(i)} style={{ background: "none", border: "none", cursor: "pointer", color: "#F85149", fontSize: 14 }}>×</button>}</td>
          </tr>) })}</tbody>
      </table>
    </div>
    <div style={box}>
      <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: "#58A6FF" }}>Correlaciones</h3>
      <div style={{ overflowX: "auto" }}>
        <table style={{ fontSize: 9, borderCollapse: "collapse", fontFamily: "'JetBrains Mono',monospace" }}>
          <thead><tr><th style={{ padding: "4px 5px" }}></th>{assets.map((ac, i) => <th key={i} style={{ padding: "4px 3px", color: ac.color, fontWeight: 500, minWidth: 48, textAlign: "center" }}>{ac.name.length > 5 ? ac.name.slice(0, 4) + "…" : ac.name}</th>)}</tr></thead>
          <tbody>{assets.map((ac, i) => (
            <tr key={i}><td style={{ padding: "3px 5px", color: ac.color, fontWeight: 500 }}>{ac.name.length > 5 ? ac.name.slice(0, 4) + "…" : ac.name}</td>
              {(corr[i] || []).map((c, j) => (<td key={j} style={{ padding: "2px 1px", textAlign: "center", background: i === j ? "#161B22" : `rgba(${c > 0 ? "248,81,73" : "63,185,80"},${Math.abs(c) * .15})` }}>
                {i === j ? <span style={{ color: "#484F58" }}>1.00</span> : i < j ? <input type="number" value={c} step=".05" min="-1" max="1" onChange={e => updCorr(i, j, e.target.value)} style={{ width: 42, padding: "2px 1px", background: "transparent", border: "1px solid transparent", borderRadius: 3, color: c > .5 ? "#F85149" : c < 0 ? "#3FB950" : "#8B949E", fontSize: 9, fontFamily: "'JetBrains Mono',monospace", textAlign: "center", outline: "none" }} onFocus={e => { e.target.style.borderColor = "#58A6FF" }} onBlur={e => { e.target.style.borderColor = "transparent" }} /> : <span style={{ color: c > .5 ? "#F85149" : c < 0 ? "#3FB950" : "#6E7681" }}>{(c ?? 0).toFixed(2)}</span>}
              </td>))}
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  </div>
)}

        <div style={{ marginTop: 20, padding: 12, background: "#0D1117", borderRadius: 8, fontSize: 10, color: "#484F58", fontFamily: "'JetBrains Mono',monospace", display: "flex", justifyContent: "space-between" }}>
          <span>VaR 5% = E[R] - 1.645 x σ | ERC Newton (ex zero-vol) | Family: consolidado = propio + herencia% x padre | No es asesoramiento financiero.</span>
          <span style={{ color: dbReady ? "#3FB950" : "#D29922" }}>{dbReady ? "☁ Synced" : "⏳ Loading..."}</span>
        </div>
      </div>
    </div>
  );
}
