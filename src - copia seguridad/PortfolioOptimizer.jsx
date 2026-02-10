import { useState, useMemo, useRef, useCallback } from "react";

// ─── DEFAULT DATA ───────────────────────────────────────────
const INIT_ASSETS = [
  { id: "cash", name: "Cash", color: "#4A90A4", expectedReturn: 3.5, annualizedVol: 0, description: "T-Bills, Money Market", liquid: true },
  { id: "fixed_income", name: "Fixed Income", color: "#2E7D6B", expectedReturn: 5.0, annualizedVol: 5.0, description: "US Agg / IG Bonds", liquid: true },
  { id: "equity", name: "Equity", color: "#C75B39", expectedReturn: 12.0, annualizedVol: 16.5, description: "Global Equities (MSCI ACWI)", liquid: true },
  { id: "hedge_funds", name: "Hedge Funds", color: "#8B6DAF", expectedReturn: 10.0, annualizedVol: 6.0, description: "HFRI FW Composite (proxy)", liquid: false },
  { id: "gold", name: "Oro", color: "#D4A843", expectedReturn: 12.0, annualizedVol: 24.5, description: "Oro físico + mineras", liquid: true },
  { id: "private_equity", name: "Private Equity", color: "#3D4F7C", expectedReturn: 13.5, annualizedVol: 15.0, description: "Cambridge Assoc. (de-smoothed)", liquid: false },
  { id: "real_estate", name: "Real Estate", color: "#A0522D", expectedReturn: 10.0, annualizedVol: 6.0, description: "REITs / REOCs", liquid: false },
  { id: "bitcoin", name: "Bitcoin", color: "#F7931A", expectedReturn: 20.0, annualizedVol: 54.0, description: "BTC spot", liquid: true },
];

// Order: cash, fi, eq, hf, gold, pe, re, btc
const INIT_CORR = [
  [ 1.00, 0.15,-0.02, 0.05, 0.00,-0.02,-0.05, 0.00],
  [ 0.15, 1.00, 0.15, 0.10,-0.10, 0.10, 0.20,-0.05],
  [-0.02, 0.15, 1.00, 0.75, 0.15, 0.85, 0.65, 0.30],
  [ 0.05, 0.10, 0.75, 1.00, 0.20, 0.70, 0.50, 0.25],
  [ 0.00,-0.10, 0.15, 0.20, 1.00, 0.15, 0.10, 0.20],
  [-0.02, 0.10, 0.85, 0.70, 0.15, 1.00, 0.55, 0.20],
  [-0.05, 0.20, 0.65, 0.50, 0.10, 0.55, 1.00, 0.15],
  [ 0.00,-0.05, 0.30, 0.25, 0.20, 0.20, 0.15, 1.00],
];

const PALETTE = ["#4A90A4","#2E7D6B","#C75B39","#8B6DAF","#D4A843","#3D4F7C","#A0522D","#F7931A","#E06C75","#56B6C2","#98C379","#C678DD","#BE5046","#61AFEF","#D19A66","#ABB2BF"];
let _idCounter = 100;
const nextId = () => `asset_${_idCounter++}`;

// ─── MATH ───────────────────────────────────────────────────
function portfolioStats(w, assets, corr) {
  const n = w.length;
  let ret = 0;
  for (let i = 0; i < n; i++) ret += w[i] * assets[i].expectedReturn;
  let v = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) v += w[i] * w[j] * assets[i].annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
  const vol = Math.sqrt(Math.max(0, v)) * 100;
  return { ret, vol, var5: ret - 1.645 * vol };
}

function portfolioStatsLev(w, assets, corr, li, lr, bc) {
  const aw = w.map((wi, i) => i === li ? wi * lr : wi);
  const te = aw.reduce((a, b) => a + b, 0);
  let ret = 0;
  for (let i = 0; i < aw.length; i++) ret += aw[i] * assets[i].expectedReturn;
  ret -= (te - 1) * bc;
  let v = 0;
  for (let i = 0; i < aw.length; i++) for (let j = 0; j < aw.length; j++) v += aw[i] * aw[j] * assets[i].annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
  const vol = Math.sqrt(Math.max(0, v)) * 100;
  return { ret, vol, var5: ret - 1.645 * vol, totalExposure: te };
}

function genFrontier(assets, corr, cnt, constraints) {
  const pts = [], n = assets.length;
  const { locked, maxIlliquid, active } = constraints || {};
  const lockedKeys = locked ? Object.keys(locked).map(Number) : [];
  const lockedSum = lockedKeys.reduce((s, k) => s + (locked[k] || 0), 0);
  const freeIdx = Array.from({ length: n }, (_, i) => i).filter((i) => !lockedKeys.includes(i));

  for (let k = 0; k < cnt; k++) {
    let w;
    if (active && lockedKeys.length > 0) {
      // Fixed weights for locked, random for free
      const raw = freeIdx.map(() => Math.random());
      const rs = raw.reduce((a, b) => a + b, 0);
      const freeTotal = Math.max(0, (100 - lockedSum)) / 100;
      w = Array(n).fill(0);
      lockedKeys.forEach((li) => { w[li] = (locked[li] || 0) / 100; });
      freeIdx.forEach((fi, ri) => { w[fi] = (raw[ri] / rs) * freeTotal; });
    } else {
      const raw = Array.from({ length: n }, () => Math.random());
      const s = raw.reduce((a, b) => a + b, 0);
      w = raw.map((x) => x / s);
    }
    // Check liquidity constraint
    if (active && maxIlliquid != null) {
      const illiq = assets.reduce((s, a, i) => s + (a.liquid ? 0 : w[i] * 100), 0);
      if (illiq > maxIlliquid) continue; // skip this portfolio
    }
    const { ret, vol } = portfolioStats(w, assets, corr);
    pts.push({ ret, vol, weights: w });
  }
  const bk = {};
  for (const p of pts) { const b = Math.round(p.vol * 2) / 2; if (!bk[b] || p.ret > bk[b].ret) bk[b] = p; }
  return { points: pts, frontier: Object.values(bk).sort((a, b) => a.vol - b.vol) };
}

function calcERC(assets, corr, excludeIndices) {
  const idx = assets.map((_, i) => i).filter((i) => !excludeIndices.includes(i));
  const n = idx.length;
  if (n === 0) return assets.map(() => 0);
  const vols = idx.map((i) => assets[i].annualizedVol / 100);
  const cm = idx.map((i) => idx.map((j) => corr[i][j]));
  let w = Array(n).fill(1 / n);
  for (let iter = 0; iter < 300; iter++) {
    let tv = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) tv += w[i] * w[j] * vols[i] * vols[j] * cm[i][j];
    const pv = Math.sqrt(Math.max(0, tv));
    const mrc = idx.map((_, i) => { let s = 0; for (let j = 0; j < n; j++) s += w[j] * vols[i] * vols[j] * cm[i][j]; return s / (pv + 1e-12); });
    const rc = w.map((wi, i) => wi * mrc[i]);
    const tgt = pv / n;
    const nw = w.map((wi, i) => wi * (tgt / (rc[i] + 1e-12)));
    const sw = nw.reduce((a, b) => a + b, 0);
    w = nw.map((wi) => wi / sw);
  }
  const full = Array(assets.length).fill(0);
  idx.forEach((ai, i) => { full[ai] = w[i]; });
  return full;
}

// ─── PRESETS (will be dynamically matched) ──────────────────
function makePresets(n) {
  const eq = Array(n).fill(+(100 / n).toFixed(1));
  return {
    equal_weight: { name: "Equal Weight", weights: eq, desc: "1/N ingenuo. Baseline de comparación." },
  };
}

// ─── COMPONENTS ─────────────────────────────────────────────
const NumField = ({ value, onChange, color, width, step, min, max }) => (
  <input type="number" value={value} onChange={onChange} step={step || 0.1} min={min} max={max}
    style={{ width: width || 58, padding: "4px 6px", background: "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: color || "#F0F6FC", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", textAlign: "right", outline: "none" }}
    onFocus={(e) => (e.target.style.borderColor = "#58A6FF")} onBlur={(e) => (e.target.style.borderColor = "#30363D")} />
);

// ═══════════════════════════════════════════════════════════
export default function PortfolioOptimizer() {
  const [assets, setAssets] = useState(INIT_ASSETS.map((a) => ({ ...a })));
  const [corr, setCorr] = useState(INIT_CORR.map((r) => [...r]));
  const [weights, setWeights] = useState([5, 15, 30, 10, 10, 10, 5, 15]);
  const [tab, setTab] = useState("allocation");
  const [hov, setHov] = useState(null);
  const [modified, setModified] = useState(false);
  const [selPt, setSelPt] = useState(null);
  const [showFrontier, setShowFrontier] = useState(false);
  // Leverage
  const [levOn, setLevOn] = useState(false);
  const [levIdx, setLevIdx] = useState(2);
  const [levRatio, setLevRatio] = useState(1.5);
  const [borrowCost, setBorrowCost] = useState(5.0);
  // Constraints
  const [locked, setLocked] = useState({});       // idx → fixed value
  const [maxIlliquid, setMaxIlliquid] = useState(50); // max % illiquid
  const [constraintsOn, setConstraintsOn] = useState(false);

  const toggleConstraints = (val) => { setConstraintsOn(val); setShowFrontier(false); };

  const svgRef = useRef(null);
  const n = assets.length;
  const tw = weights.reduce((a, b) => a + b, 0);
  const nw = weights.map((w) => w / (tw || 1));

  // Stats
  const stats = useMemo(() => {
    if (!levOn) return { ...portfolioStats(nw, assets, corr), totalExposure: 1 };
    return portfolioStatsLev(nw, assets, corr, Math.min(levIdx, n - 1), levRatio, borrowCost);
  }, [weights, assets, corr, levOn, levIdx, levRatio, borrowCost]);

  // Risk budget
  const riskBudget = useMemo(() => {
    const aw = levOn ? nw.map((w, i) => i === Math.min(levIdx, n - 1) ? w * levRatio : w) : nw;
    let tv = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) tv += aw[i] * aw[j] * assets[i].annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
    const pv = Math.sqrt(Math.max(0, tv));
    return assets.map((ac, i) => {
      let mrc = 0;
      for (let j = 0; j < n; j++) mrc += aw[j] * ac.annualizedVol * assets[j].annualizedVol * corr[i][j] / 10000;
      mrc = mrc / (pv + 1e-12);
      const rc = aw[i] * mrc;
      return { ...ac, idx: i, mrc, rc, pctRisk: (rc / (pv + 1e-12)) * 100, weight: nw[i] * 100, adjW: aw[i] * 100 };
    });
  }, [weights, assets, corr, levOn, levIdx, levRatio]);

  // ERC (exclude zero-vol assets like cash)
  const ercExclude = useMemo(() => assets.map((a, i) => a.annualizedVol <= 0.01 ? i : -1).filter((i) => i >= 0), [assets]);
  const ercW = useMemo(() => calcERC(assets, corr, ercExclude), [assets, corr, ercExclude]);
  const ercStats = useMemo(() => portfolioStats(ercW, assets, corr), [ercW, assets, corr]);
  const frontierConstraints = useMemo(() => constraintsOn ? { locked, maxIlliquid, active: true } : { active: false }, [constraintsOn, locked, maxIlliquid]);
  const frontier = useMemo(() => (showFrontier ? genFrontier(assets, corr, constraintsOn ? 20000 : 10000, frontierConstraints) : null), [showFrontier, assets, corr, frontierConstraints]);

  // Liquidity calc
  const illiquidPct = useMemo(() => assets.reduce((sum, a, i) => sum + (a.liquid ? 0 : nw[i] * 100), 0), [assets, weights]);
  const liquidPct = 100 - illiquidPct;

  // ─── HANDLERS ─────────────────────────────────────────────
  const setW = (idx, val) => { const nws = [...weights]; nws[idx] = Math.max(0, Math.min(100, Number(val))); setWeights(nws); };
  const updAsset = (idx, field, val) => { setAssets((p) => p.map((a, i) => (i === idx ? { ...a, [field]: typeof val === 'boolean' ? val : Number(val) } : a))); setModified(true); setShowFrontier(false); };
  const updCorr = (i, j, val) => { const v = Math.max(-1, Math.min(1, Number(val))); setCorr((p) => { const nc = p.map((r) => [...r]); nc[i][j] = v; nc[j][i] = v; return nc; }); setModified(true); setShowFrontier(false); };

  const resetAssumptions = () => {
    setAssets(INIT_ASSETS.map((a) => ({ ...a })));
    setCorr(INIT_CORR.map((r) => [...r]));
    setWeights([5, 15, 30, 10, 10, 10, 5, 15]);
    setModified(false);
    setShowFrontier(false);
    setLocked({});
  };

  const addAsset = () => {
    const id = nextId();
    const ci = assets.length % PALETTE.length;
    setAssets((p) => [...p, { id, name: "New Asset", color: PALETTE[ci], expectedReturn: 8.0, annualizedVol: 15.0, description: "Custom", liquid: true }]);
    setWeights((p) => [...p, 5]);
    setCorr((p) => {
      const newN = p.length + 1;
      const nc = p.map((r) => [...r, 0.1]);
      nc.push(Array(newN).fill(0.1));
      nc[newN - 1][newN - 1] = 1.0;
      return nc;
    });
  };

  const removeAsset = (idx) => {
    if (assets.length <= 2) return;
    setAssets((p) => p.filter((_, i) => i !== idx));
    setWeights((p) => p.filter((_, i) => i !== idx));
    setCorr((p) => {
      const nc = p.filter((_, i) => i !== idx).map((r) => r.filter((_, j) => j !== idx));
      return nc;
    });
    setLocked((p) => { const nl = {}; Object.keys(p).forEach((k) => { const ki = Number(k); if (ki < idx) nl[ki] = p[k]; else if (ki > idx) nl[ki - 1] = p[k]; }); return nl; });
    if (levIdx >= idx && levIdx > 0) setLevIdx((p) => Math.max(0, p - (idx <= p ? 1 : 0)));
    setShowFrontier(false);
  };

  const applyERC = () => setWeights(ercW.map((w) => Math.round(w * 1000) / 10));
  const applyEqual = () => setWeights(Array(n).fill(+(100 / n).toFixed(1)));

  const toggleLock = (idx) => {
    setLocked((p) => {
      const nl = { ...p };
      if (nl[idx] !== undefined) delete nl[idx]; else nl[idx] = weights[idx];
      return nl;
    });
    setShowFrontier(false);
  };

  // Frontier click
  const handleFrontierClick = (e) => {
    if (!frontier || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = 700 / rect.width, sy = 400 / rect.height;
    const cx = (e.clientX - rect.left) * sx, cy = (e.clientY - rect.top) * sy;
    const cv = ((cx - 60) / 620) * 30, cr = ((370 - cy) / 340) * 22;
    if (cv < 0 || cv > 30 || cr < 0 || cr > 22) return;
    let best = null, bd = Infinity;
    for (const p of frontier.frontier) { const d = Math.sqrt(((p.vol - cv) / 30) ** 2 + ((p.ret - cr) / 22) ** 2); if (d < bd) { bd = d; best = p; } }
    if (best && bd < 0.08) { setSelPt(best); setWeights(best.weights.map((w) => Math.round(w * 1000) / 10)); }
  };

  // ─── STYLES ───────────────────────────────────────────────
  const box = { background: "#161B22", border: "1px solid #21262D", borderRadius: 10, padding: 20 };
  const micro = { fontSize: 10, color: "#484F58", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: 1 };
  const pill = (active, color) => ({ padding: "6px 14px", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", fontWeight: active ? 600 : 400, color: active ? "#F0F6FC" : "#6E7681", background: active ? "#21262D" : "transparent", border: `1px solid ${active ? "#30363D" : "transparent"}`, borderRadius: 6, cursor: "pointer" });

  return (
    <div style={{ fontFamily: "'DM Sans','Helvetica Neue',sans-serif", background: "linear-gradient(145deg,#0D1117 0%,#161B22 50%,#0D1117 100%)", color: "#C9D1D9", minHeight: "100vh", padding: 24 }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        {/* HEADER */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
          <h1 style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 22, fontWeight: 700, color: "#F0F6FC", margin: 0 }}>Portfolio Optimizer</h1>
          <span style={{ fontSize: 11, color: "#484F58", fontFamily: "'JetBrains Mono',monospace" }}>v3.0 — {n} assets</span>
          {modified && <span style={{ fontSize: 10, color: "#D29922", background: "#2D2200", padding: "2px 8px", borderRadius: 4, fontFamily: "'JetBrains Mono',monospace" }}>● modified</span>}
          {levOn && <span style={{ fontSize: 10, color: "#F85149", background: "#3D1117", padding: "2px 8px", borderRadius: 4, fontFamily: "'JetBrains Mono',monospace" }}>⚡{levRatio}x {assets[Math.min(levIdx, n - 1)]?.name}</span>}
          {constraintsOn && <span style={{ fontSize: 10, color: "#58A6FF", background: "#0D2240", padding: "2px 8px", borderRadius: 4, fontFamily: "'JetBrains Mono',monospace" }}>🔒 constraints</span>}
        </div>
        <p style={{ fontSize: 13, color: "#6E7681", margin: "4px 0 20px" }}>Dynamic assets, constraints, ERC (ex zero-vol), leverage, clickable frontier.</p>

        {/* TABS */}
        <div style={{ display: "flex", gap: 2, marginBottom: 20, flexWrap: "wrap" }}>
          {[{id:"allocation",l:"Allocation"},{id:"constraints",l:"🔒 Constraints"},{id:"risk",l:"Risk Budget"},{id:"frontier",l:"Frontier"},{id:"leverage",l:"⚡ Leverage"},{id:"data",l:"⚙ Assumptions"}].map((t) => (
            <button key={t.id} onClick={() => { setTab(t.id); if (t.id === "frontier") setShowFrontier(true); }} style={pill(tab === t.id)}>{t.l}</button>
          ))}
        </div>

        {/* STATS BAR */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8, marginBottom: 20 }}>
          {[
            { l: "E[Return]", v: `${stats.ret.toFixed(1)}%`, c: "#3FB950" },
            { l: "Vol", v: `${stats.vol.toFixed(1)}%`, c: "#D29922" },
            { l: "VaR 5%", v: `${stats.var5.toFixed(1)}%`, c: stats.var5 < 0 ? "#F85149" : "#3FB950" },
            { l: "Sharpe(rf=3.5%)", v: ((stats.ret - 3.5) / (stats.vol + 1e-12)).toFixed(2), c: "#58A6FF" },
            { l: "Liquid", v: `${liquidPct.toFixed(0)}%`, c: liquidPct >= (100 - maxIlliquid) ? "#3FB950" : "#F85149" },
            { l: "Exposure", v: levOn ? `${(stats.totalExposure * 100).toFixed(0)}%` : "100%", c: levOn && stats.totalExposure > 1 ? "#F85149" : "#8B949E" },
          ].map((s) => (
            <div key={s.l} style={{ background: "#161B22", border: "1px solid #21262D", borderRadius: 8, padding: "12px 10px" }}>
              <div style={{ ...micro, marginBottom: 4, fontSize: 9 }}>{s.l}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: s.c, fontFamily: "'JetBrains Mono',monospace" }}>{s.v}</div>
            </div>
          ))}
        </div>

        {/* ═══════════ ALLOCATION ═══════════ */}
        {tab === "allocation" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20 }}>
            <div style={box}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Asset Weights</h3>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {constraintsOn && illiquidPct > maxIlliquid && <span style={{ fontSize: 10, color: "#F85149", fontFamily: "'JetBrains Mono',monospace" }}>⚠ Illiquid {illiquidPct.toFixed(0)}% &gt; {maxIlliquid}%</span>}
                  <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: Math.abs(tw - 100) < 0.5 ? "#3FB950" : "#F85149" }}>Σ {tw.toFixed(1)}%</span>
                </div>
              </div>
              {assets.map((ac, i) => (
                <div key={ac.id} style={{ marginBottom: 12 }} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 3, background: ac.color }} />
                      <span style={{ fontSize: 12, fontWeight: 500, color: hov === i ? "#F0F6FC" : "#C9D1D9" }}>{ac.name}</span>
                      {!ac.liquid && <span style={{ fontSize: 8, color: "#D29922", background: "#2D2200", padding: "1px 4px", borderRadius: 3 }}>ILLIQ</span>}
                      {locked[i] !== undefined && <span style={{ fontSize: 8, color: "#58A6FF", background: "#0D2240", padding: "1px 4px", borderRadius: 3 }}>LOCKED</span>}
                      {levOn && i === Math.min(levIdx, n - 1) && <span style={{ fontSize: 8, color: "#F85149", background: "#3D1117", padding: "1px 4px", borderRadius: 3 }}>{levRatio}x</span>}
                    </div>
                    <input type="number" value={weights[i]} onChange={(e) => setW(i, e.target.value)} disabled={locked[i] !== undefined}
                      style={{ width: 52, padding: "3px 6px", background: locked[i] !== undefined ? "#21262D" : "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: locked[i] !== undefined ? "#484F58" : "#F0F6FC", fontSize: 12, fontFamily: "'JetBrains Mono',monospace", textAlign: "right" }} />
                  </div>
                  <input type="range" min="0" max="60" step="0.5" value={weights[i]} onChange={(e) => setW(i, e.target.value)} disabled={locked[i] !== undefined}
                    style={{ width: "100%", height: 4, appearance: "none", background: `linear-gradient(to right, ${ac.color} ${(weights[i] / 60) * 100}%, #21262D ${(weights[i] / 60) * 100}%)`, borderRadius: 2, outline: "none", cursor: locked[i] !== undefined ? "not-allowed" : "pointer", opacity: locked[i] !== undefined ? 0.5 : 1 }} />
                </div>
              ))}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #21262D", display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button onClick={applyEqual} style={{ padding: "5px 10px", fontSize: 11, background: "#21262D", border: "1px solid #30363D", borderRadius: 5, color: "#C9D1D9", cursor: "pointer" }}>Equal Weight</button>
                <button onClick={applyERC} style={{ padding: "5px 10px", fontSize: 11, background: "#1F3A2D", border: "1px solid #238636", borderRadius: 5, color: "#3FB950", cursor: "pointer", fontWeight: 600 }}>ERC (ex zero-vol)</button>
              </div>
            </div>
            {/* PIE */}
            <div style={{ ...box, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color: "#F0F6FC", alignSelf: "flex-start" }}>Allocation</h3>
              <svg viewBox="0 0 200 200" style={{ width: 200, height: 200 }}>
                {(() => { let cum = -90; return assets.map((ac, i) => { const pct = nw[i] * 100; if (pct < 0.5) return null; const angle = (pct / 100) * 360; const s = cum; cum += angle; const sr = (s * Math.PI) / 180, er = (cum * Math.PI) / 180; return <path key={ac.id} d={`M 100 100 L ${100 + 85 * Math.cos(sr)} ${100 + 85 * Math.sin(sr)} A 85 85 0 ${angle > 180 ? 1 : 0} 1 ${100 + 85 * Math.cos(er)} ${100 + 85 * Math.sin(er)} Z`} fill={ac.color} stroke="#161B22" strokeWidth="1.5" opacity={hov === null || hov === i ? 1 : 0.35} style={{ transition: "opacity 0.2s" }} />; }); })()}
                <circle cx="100" cy="100" r="38" fill="#161B22" />
                <text x="100" y="96" textAnchor="middle" fill="#F0F6FC" fontSize="15" fontWeight="700" fontFamily="JetBrains Mono">{stats.ret.toFixed(1)}%</text>
                <text x="100" y="110" textAnchor="middle" fill="#6E7681" fontSize="7" fontFamily="JetBrains Mono">E[Return]</text>
              </svg>
              <div style={{ marginTop: 12, width: "100%" }}>
                {assets.map((ac, i) => { const pct = nw[i] * 100; if (pct < 0.3) return null; return (
                  <div key={ac.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", opacity: hov === null || hov === i ? 1 : 0.4 }} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 7, height: 7, borderRadius: 2, background: ac.color }} /><span style={{ fontSize: 11 }}>{ac.name}</span></div>
                    <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#8B949E" }}>{pct.toFixed(1)}%</span>
                  </div>); })}
              </div>
              {/* Liquidity bar */}
              <div style={{ width: "100%", marginTop: 14, paddingTop: 12, borderTop: "1px solid #21262D" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: "#3FB950" }}>Líquido {liquidPct.toFixed(0)}%</span>
                  <span style={{ fontSize: 10, color: "#D29922" }}>Ilíquido {illiquidPct.toFixed(0)}%</span>
                </div>
                <div style={{ height: 6, background: "#21262D", borderRadius: 3, overflow: "hidden", display: "flex" }}>
                  <div style={{ width: `${liquidPct}%`, background: "#3FB950", transition: "width 0.3s" }} />
                  <div style={{ width: `${illiquidPct}%`, background: "#D29922", transition: "width 0.3s" }} />
                </div>
                {constraintsOn && <div style={{ fontSize: 9, color: "#484F58", marginTop: 3 }}>Max illiquid: {maxIlliquid}%</div>}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════ CONSTRAINTS ═══════════ */}
        {tab === "constraints" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={box}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Constraints del Portfolio</h3>
                <button onClick={() => toggleConstraints(!constraintsOn)} style={{ padding: "6px 14px", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", background: constraintsOn ? "#0D2240" : "#21262D", border: `1px solid ${constraintsOn ? "#58A6FF" : "#30363D"}`, color: constraintsOn ? "#58A6FF" : "#C9D1D9", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                  {constraintsOn ? "Constraints ON" : "Activar Constraints"}
                </button>
              </div>

              {/* Lock assets */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ ...micro, marginBottom: 8 }}>Fijar Assets a Valor Fijo</div>
                <p style={{ fontSize: 12, color: "#6E7681", margin: "0 0 12px" }}>Clickeá el candado para fijar un asset. El slider se bloquea en ese valor.</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
                  {assets.map((ac, i) => (
                    <div key={ac.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: locked[i] !== undefined ? "#0D2240" : "#0D1117", border: `1px solid ${locked[i] !== undefined ? "#58A6FF" : "#21262D"}`, borderRadius: 6 }}>
                      <button onClick={() => toggleLock(i)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, padding: 0 }}>
                        {locked[i] !== undefined ? "🔒" : "🔓"}
                      </button>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: ac.color }} />
                      <span style={{ fontSize: 12, color: "#C9D1D9", flex: 1 }}>{ac.name}</span>
                      {locked[i] !== undefined ? (
                        <NumField value={locked[i]} width={50} onChange={(e) => {
                          const v = Math.max(0, Math.min(100, Number(e.target.value)));
                          setLocked((p) => ({ ...p, [i]: v }));
                          setW(i, v);
                        }} color="#58A6FF" />
                      ) : (
                        <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#484F58" }}>{weights[i].toFixed(1)}%</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Liquidity constraint */}
              <div>
                <div style={{ ...micro, marginBottom: 8 }}>Constraint de Liquidez</div>
                <p style={{ fontSize: 12, color: "#6E7681", margin: "0 0 12px" }}>
                  Ilíquido = {assets.filter((a) => !a.liquid).map((a) => a.name).join(" + ")}.<br />
                  Líquido = {assets.filter((a) => a.liquid).map((a) => a.name).join(" + ")}.
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
                  <span style={{ fontSize: 12, color: "#C9D1D9" }}>Max Ilíquido:</span>
                  <input type="range" min="0" max="100" step="5" value={maxIlliquid} onChange={(e) => { setMaxIlliquid(Number(e.target.value)); setShowFrontier(false); }} style={{ flex: 1 }} />
                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: "#D29922", minWidth: 40 }}>{maxIlliquid}%</span>
                </div>
                <div style={{ display: "flex", gap: 16, padding: "12px 16px", background: "#0D1117", borderRadius: 8, border: "1px solid #21262D" }}>
                  <div>
                    <div style={{ fontSize: 10, color: "#484F58" }}>Actual Ilíquido</div>
                    <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: constraintsOn && illiquidPct > maxIlliquid ? "#F85149" : "#D29922" }}>{illiquidPct.toFixed(1)}%</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#484F58" }}>Actual Líquido</div>
                    <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: "#3FB950" }}>{liquidPct.toFixed(1)}%</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#484F58" }}>Status</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: !constraintsOn ? "#484F58" : illiquidPct <= maxIlliquid ? "#3FB950" : "#F85149" }}>
                      {!constraintsOn ? "OFF" : illiquidPct <= maxIlliquid ? "✓ OK" : "✗ BREACH"}
                    </div>
                  </div>
                </div>

                {/* Toggle liquid/illiquid per asset */}
                <div style={{ marginTop: 16 }}>
                  <div style={{ ...micro, marginBottom: 8 }}>Clasificación Líquido/Ilíquido</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {assets.map((ac, i) => (
                      <button key={ac.id} onClick={() => updAsset(i, "liquid", !ac.liquid)}
                        style={{ padding: "5px 10px", fontSize: 11, background: ac.liquid ? "#1F3A2D" : "#2D2200", border: `1px solid ${ac.liquid ? "#238636" : "#D29922"}`, borderRadius: 5, color: ac.liquid ? "#3FB950" : "#D29922", cursor: "pointer" }}>
                        <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: ac.color, marginRight: 6 }} />
                        {ac.name}: {ac.liquid ? "LIQ" : "ILLIQ"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════ RISK BUDGET ═══════════ */}
        {tab === "risk" && (
          <div style={box}>
            <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Risk Budget</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div>
                <div style={{ ...micro, marginBottom: 10 }}>% Contribución al Riesgo</div>
                {riskBudget.filter((r) => r.weight > 0.3).sort((a, b) => b.pctRisk - a.pctRisk).map((rb) => (
                  <div key={rb.id} style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                      <span style={{ fontSize: 11 }}>{rb.name}</span>
                      <div style={{ display: "flex", gap: 10 }}>
                        <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#6E7681" }}>w:{rb.weight.toFixed(1)}%</span>
                        <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: rb.pctRisk > rb.weight * 1.5 ? "#F85149" : rb.pctRisk < rb.weight * 0.5 ? "#3FB950" : "#D29922" }}>risk:{rb.pctRisk.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div style={{ height: 5, background: "#21262D", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, rb.pctRisk))}%`, background: rb.color, borderRadius: 3, transition: "width 0.3s" }} />
                    </div>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ ...micro, marginBottom: 10 }}>ERC Optimal (ex zero-vol)</div>
                {assets.map((ac, i) => ercW[i] > 0.005 ? (<div key={ac.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}><span style={{ fontSize: 11 }}>{ac.name}</span><span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#3FB950" }}>{(ercW[i] * 100).toFixed(1)}%</span></div>) : null)}
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #21262D", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#58A6FF" }}>
                  E[R]:{ercStats.ret.toFixed(1)}% | Vol:{ercStats.vol.toFixed(1)}% | VaR5:{ercStats.var5.toFixed(1)}%
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════ FRONTIER ═══════════ */}
        {tab === "frontier" && (
          <div style={box}>
            <h3 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Clickeá la frontera para seleccionar un portfolio óptimo</h3>
            {selPt && (
              <div style={{ display: "flex", gap: 12, padding: "8px 12px", background: "#0D1117", borderRadius: 6, border: "1px solid #58A6FF", margin: "8px 0 12px", flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#58A6FF", fontWeight: 600 }}>Selected:</span>
                <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#3FB950" }}>Ret {selPt.ret.toFixed(1)}%</span>
                <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#D29922" }}>Vol {selPt.vol.toFixed(1)}%</span>
                <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#8B949E" }}>
                  {assets.map((ac, i) => selPt.weights[i] > 0.03 ? `${ac.name.slice(0, 5)}:${(selPt.weights[i] * 100).toFixed(0)}%` : null).filter(Boolean).join(" · ")}
                </span>
              </div>
            )}
            {frontier && (
              <svg ref={svgRef} viewBox="0 0 700 400" style={{ width: "100%", background: "#0D1117", borderRadius: 8, border: "1px solid #21262D", cursor: "crosshair" }} onClick={handleFrontierClick}>
                {[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((v) => { const y = 370 - (v / 22) * 340; return <g key={`gy${v}`}><line x1="60" y1={y} x2="680" y2={y} stroke="#21262D" strokeWidth="0.5" /><text x="52" y={y + 4} textAnchor="end" fill="#484F58" fontSize="8" fontFamily="JetBrains Mono">{v}%</text></g>; })}
                {[0, 5, 10, 15, 20, 25, 30].map((v) => { const x = 60 + (v / 30) * 620; return <g key={`gx${v}`}><line x1={x} y1="30" x2={x} y2="370" stroke="#21262D" strokeWidth="0.5" /><text x={x} y="386" textAnchor="middle" fill="#484F58" fontSize="8" fontFamily="JetBrains Mono">{v}%</text></g>; })}
                <text x="370" y="399" textAnchor="middle" fill="#6E7681" fontSize="9" fontFamily="JetBrains Mono">Volatility</text>
                <text x="12" y="200" textAnchor="middle" fill="#6E7681" fontSize="9" fontFamily="JetBrains Mono" transform="rotate(-90,12,200)">Return</text>
                {frontier.points.map((p, i) => { const x = 60 + (p.vol / 30) * 620, y = 370 - (p.ret / 22) * 340; return (x >= 60 && x <= 680 && y >= 30 && y <= 370) ? <circle key={i} cx={x} cy={y} r="1.2" fill="#30363D" opacity="0.2" /> : null; })}
                {frontier.frontier.length > 2 && <polyline points={frontier.frontier.filter((p) => p.vol <= 30 && p.ret <= 22).map((p) => `${60 + (p.vol / 30) * 620},${370 - (p.ret / 22) * 340}`).join(" ")} fill="none" stroke="#D29922" strokeWidth="2.5" />}
                {frontier.frontier.filter((p) => p.vol <= 30 && p.ret <= 22).map((p, i) => <circle key={`fd${i}`} cx={60 + (p.vol / 30) * 620} cy={370 - (p.ret / 22) * 340} r="3" fill="#D29922" opacity="0.4" />)}
                <circle cx={60 + (stats.vol / 30) * 620} cy={370 - (stats.ret / 22) * 340} r="7" fill="#F85149" stroke="#F0F6FC" strokeWidth="2" />
                <text x={Math.min(640, 60 + (stats.vol / 30) * 620 + 12)} y={370 - (stats.ret / 22) * 340 + 4} fill="#F85149" fontSize="9" fontWeight="600" fontFamily="JetBrains Mono">Tu Portfolio</text>
                <circle cx={60 + (ercStats.vol / 30) * 620} cy={370 - (ercStats.ret / 22) * 340} r="5" fill="#3FB950" stroke="#F0F6FC" strokeWidth="1.5" />
                <text x={60 + (ercStats.vol / 30) * 620 + 9} y={370 - (ercStats.ret / 22) * 340 + 4} fill="#3FB950" fontSize="8" fontWeight="600" fontFamily="JetBrains Mono">ERC</text>
                {assets.map((ac) => { const x = 60 + (ac.annualizedVol / 30) * 620, y = 370 - (ac.expectedReturn / 22) * 340; return (x <= 680 && y >= 30) ? <g key={ac.id}><circle cx={x} cy={y} r="4" fill={ac.color} opacity="0.8" /><text x={x + 7} y={y + 3} fill={ac.color} fontSize="7" fontFamily="JetBrains Mono">{ac.name}</text></g> : null; })}
                {selPt && <circle cx={60 + (selPt.vol / 30) * 620} cy={370 - (selPt.ret / 22) * 340} r="8" fill="none" stroke="#58A6FF" strokeWidth="2.5" strokeDasharray="4 2" />}
                {levOn && (() => { const rf = borrowCost; const bs = portfolioStats(nw, assets, corr); const slope = (bs.ret - rf) / (bs.vol + 1e-12); const x1 = 60, y1 = 370 - (rf / 22) * 340; const endRet = Math.min(22, rf + slope * 30); const x2 = 680, y2 = 370 - (endRet / 22) * 340; return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#F85149" strokeWidth="1.5" strokeDasharray="6 3" opacity="0.5" />; })()}
              </svg>
            )}
          </div>
        )}

        {/* ═══════════ LEVERAGE ═══════════ */}
        {tab === "leverage" && (
          <div style={box}>
            <h3 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>⚡ Apalancamiento</h3>
            <p style={{ fontSize: 12, color: "#6E7681", margin: "0 0 16px", lineHeight: 1.6 }}>Apalancar escala la exposición más allá del 100%. La CML se dibuja en la frontier.</p>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <button onClick={() => setLevOn(!levOn)} style={{ padding: "8px 16px", fontSize: 12, fontFamily: "'JetBrains Mono',monospace", background: levOn ? "#3D1117" : "#21262D", border: `1px solid ${levOn ? "#F85149" : "#30363D"}`, color: levOn ? "#F85149" : "#C9D1D9", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                {levOn ? "Desactivar" : "Activar"} Leverage
              </button>
            </div>
            {levOn && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                <div>
                  <div style={{ ...micro, marginBottom: 8 }}>Asset a Apalancar</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {assets.map((ac, i) => (
                      <button key={ac.id} onClick={() => setLevIdx(i)} style={{ padding: "6px 10px", fontSize: 11, textAlign: "left", background: i === levIdx ? "#21262D" : "transparent", border: `1px solid ${i === levIdx ? ac.color : "transparent"}`, borderRadius: 5, color: i === levIdx ? "#F0F6FC" : "#6E7681", cursor: "pointer" }}>
                        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: ac.color, marginRight: 8 }} />{ac.name} <span style={{ color: "#484F58", fontSize: 10 }}>σ={ac.annualizedVol}%</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ ...micro, marginBottom: 8 }}>Ratio: {levRatio}x</div>
                  <input type="range" min="1" max="3" step="0.1" value={levRatio} onChange={(e) => setLevRatio(Number(e.target.value))} style={{ width: "100%", marginBottom: 16 }} />
                  <div style={{ ...micro, marginBottom: 8 }}>Costo Fondeo: {borrowCost}%</div>
                  <input type="range" min="2" max="8" step="0.25" value={borrowCost} onChange={(e) => setBorrowCost(Number(e.target.value))} style={{ width: "100%", marginBottom: 16 }} />
                  <div style={{ padding: 12, background: "#0D1117", borderRadius: 6, border: "1px solid #21262D", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {[{ l: "E[R]", v: `${stats.ret.toFixed(1)}%`, c: "#3FB950" }, { l: "Vol", v: `${stats.vol.toFixed(1)}%`, c: "#D29922" }, { l: "VaR5", v: `${stats.var5.toFixed(1)}%`, c: stats.var5 < 0 ? "#F85149" : "#3FB950" }, { l: "Exposure", v: `${(stats.totalExposure * 100).toFixed(0)}%`, c: "#F85149" }].map((m) => (
                      <div key={m.l}><div style={{ fontSize: 9, color: "#484F58" }}>{m.l}</div><div style={{ fontSize: 14, fontWeight: 700, color: m.c, fontFamily: "'JetBrains Mono',monospace" }}>{m.v}</div></div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div style={{ marginTop: 20, padding: 14, background: "#0D1117", borderRadius: 8, border: "1px solid #21262D", fontSize: 12, color: "#8B949E", lineHeight: 1.6 }}>
              <strong style={{ color: "#D29922" }}>¿Tiene sentido?</strong> Lo teóricamente correcto es apalancar el portfolio tangente (max Sharpe), no un solo asset. Pero en la práctica se apalanca lo que tiene instrumentos líquidos: equity via futuros, bonds via repos, oro via COMEX. Si Sharpe post-funding &gt; 0, agrega valor. Leverage moderado (1.2-1.5x) sobre equity es razonable a largo plazo si tolerás drawdowns.
            </div>
          </div>
        )}

        {/* ═══════════ ASSUMPTIONS ═══════════ */}
        {tab === "data" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={box}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Retornos & Volatilidad</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={addAsset} style={{ padding: "4px 12px", fontSize: 11, background: "#1F3A2D", border: "1px solid #238636", borderRadius: 5, color: "#3FB950", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>+ Asset</button>
                  <button onClick={resetAssumptions} style={{ padding: "4px 12px", fontSize: 11, background: "#21262D", border: "1px solid #30363D", borderRadius: 5, color: "#C9D1D9", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace" }}>↺ Reset</button>
                </div>
              </div>
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginTop: 12 }}>
                <thead><tr style={{ borderBottom: "1px solid #30363D" }}>
                  {["", "Asset", "E[R] %", "Vol %", "VaR5%", "Liq", ""].map((h, hi) => (
                    <th key={hi} style={{ textAlign: hi <= 1 ? "left" : "center", padding: "6px 4px", ...micro }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>{assets.map((ac, i) => {
                  const v5 = ac.expectedReturn - 1.645 * ac.annualizedVol;
                  return (
                    <tr key={ac.id} style={{ borderBottom: "1px solid #21262D" }}>
                      <td style={{ padding: "8px 4px", width: 16 }}><div style={{ width: 10, height: 10, borderRadius: 3, background: ac.color }} /></td>
                      <td style={{ padding: "8px 4px" }}>
                        <input value={ac.name} onChange={(e) => { setAssets((p) => p.map((a, j) => j === i ? { ...a, name: e.target.value } : a)); setModified(true); }}
                          style={{ background: "transparent", border: "none", color: "#F0F6FC", fontSize: 12, fontWeight: 500, outline: "none", width: 120, fontFamily: "'DM Sans',sans-serif" }} />
                      </td>
                      <td style={{ textAlign: "center", padding: "8px 4px" }}><NumField value={ac.expectedReturn} onChange={(e) => updAsset(i, "expectedReturn", e.target.value)} color="#3FB950" /></td>
                      <td style={{ textAlign: "center", padding: "8px 4px" }}><NumField value={ac.annualizedVol} onChange={(e) => updAsset(i, "annualizedVol", e.target.value)} color="#D29922" /></td>
                      <td style={{ textAlign: "center", padding: "8px 4px", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: v5 < 0 ? "#F85149" : "#3FB950" }}>{v5.toFixed(1)}%</td>
                      <td style={{ textAlign: "center", padding: "8px 4px" }}>
                        <button onClick={() => updAsset(i, "liquid", !ac.liquid)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: ac.liquid ? "#3FB950" : "#D29922" }}>{ac.liquid ? "LIQ" : "ILL"}</button>
                      </td>
                      <td style={{ textAlign: "center", padding: "8px 4px" }}>
                        {assets.length > 2 && <button onClick={() => removeAsset(i)} style={{ background: "none", border: "none", cursor: "pointer", color: "#F85149", fontSize: 14, padding: 0 }}>×</button>}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>

            {/* Correlation */}
            <div style={box}>
              <h3 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "#58A6FF" }}>Matriz de Correlaciones</h3>
              <p style={{ fontSize: 12, color: "#6E7681", margin: "0 0 12px" }}>Triángulo superior editable. Se expande automáticamente al agregar assets (default 0.10).</p>
              <div style={{ overflowX: "auto" }}>
                <table style={{ fontSize: 9, borderCollapse: "collapse", fontFamily: "'JetBrains Mono',monospace" }}>
                  <thead><tr><th style={{ padding: "4px 6px" }}></th>{assets.map((ac, i) => <th key={i} style={{ padding: "4px 3px", color: ac.color, fontWeight: 500, minWidth: 52, textAlign: "center" }}>{ac.name.length > 6 ? ac.name.slice(0, 5) + "…" : ac.name}</th>)}</tr></thead>
                  <tbody>{assets.map((ac, i) => (
                    <tr key={i}>
                      <td style={{ padding: "3px 6px", color: ac.color, fontWeight: 500 }}>{ac.name.length > 6 ? ac.name.slice(0, 5) + "…" : ac.name}</td>
                      {(corr[i] || []).map((c, j) => (
                        <td key={j} style={{ padding: "2px 1px", textAlign: "center", background: i === j ? "#161B22" : `rgba(${c > 0 ? "248,81,73" : "63,185,80"},${Math.abs(c) * 0.15})` }}>
                          {i === j ? <span style={{ color: "#484F58" }}>1.00</span> : i < j ? (
                            <input type="number" value={c} step="0.05" min="-1" max="1" onChange={(e) => updCorr(i, j, e.target.value)}
                              style={{ width: 44, padding: "2px 1px", background: "transparent", border: "1px solid transparent", borderRadius: 3, color: c > 0.5 ? "#F85149" : c < 0 ? "#3FB950" : "#8B949E", fontSize: 9, fontFamily: "'JetBrains Mono',monospace", textAlign: "center", outline: "none" }}
                              onFocus={(e) => (e.target.style.borderColor = "#58A6FF")} onBlur={(e) => (e.target.style.borderColor = "transparent")} />
                          ) : <span style={{ color: c > 0.5 ? "#F85149" : c < 0 ? "#3FB950" : "#6E7681" }}>{(c ?? 0).toFixed(2)}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* FOOTER */}
        <div style={{ marginTop: 20, padding: 12, background: "#0D1117", borderRadius: 8, fontSize: 10, color: "#484F58", fontFamily: "'JetBrains Mono',monospace" }}>
          VaR 5% = E[R] − 1.645×σ | ERC Newton (ex zero-vol) | Leverage: E[R_lev] = Σ(w_adj×r) − (exp−1)×bc | No es asesoramiento financiero.
        </div>
      </div>
    </div>
  );
}
