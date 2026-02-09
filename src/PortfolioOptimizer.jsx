import { useState, useMemo, useRef } from "react";

const DEFAULT_ASSETS = [
  { id: "cash", name: "Cash", color: "#4A90A4", expectedReturn: 4.0, annualizedVol: 1.0, description: "T-Bills, Money Market", varNote: "Prácticamente sin riesgo de mercado" },
  { id: "fixed_income", name: "Fixed Income", color: "#2E7D6B", expectedReturn: 5.0, annualizedVol: 7.0, description: "US Agg / IG Bonds", varNote: "Vol histórica ~5-8% anualizada" },
  { id: "equity", name: "Equity", color: "#C75B39", expectedReturn: 9.5, annualizedVol: 16.0, description: "Global Equities (MSCI ACWI)", varNote: "Vol histórica ~15-18% anualizada" },
  { id: "hedge_funds", name: "Hedge Funds", color: "#8B6DAF", expectedReturn: 7.0, annualizedVol: 7.5, description: "HFRI FW Composite (proxy)", varNote: "⚠️ Vol reportada ~6-7%, de-smoothed ~10-12%" },
  { id: "commodities_crypto", name: "Comm & Crypto", color: "#D4A843", expectedReturn: 10.0, annualizedVol: 22.0, description: "Oro + Mineras + BTC (blend)", varNote: "Oro ~15%, BTC ~54%, blend depende del mix" },
  { id: "private_equity", name: "Private Equity", color: "#3D4F7C", expectedReturn: 12.0, annualizedVol: 17.0, description: "Cambridge Assoc. (de-smoothed)", varNote: "⚠️ Reportada ~10%, de-smoothed ~16-17%" },
  { id: "real_estate", name: "Real Estate", color: "#A0522D", expectedReturn: 7.5, annualizedVol: 19.0, description: "REITs / REOCs (mark-to-market)", varNote: "REITs listados vol ~18-22%" },
];

const DEFAULT_CORR = [
  [1.0,  0.15, -0.02, 0.05,  0.0,  -0.02, -0.05],
  [0.15, 1.0,   0.15, 0.10, -0.10,  0.10,  0.20],
  [-0.02,0.15,  1.0,  0.75,  0.15,  0.85,  0.65],
  [0.05, 0.10,  0.75, 1.0,   0.20,  0.70,  0.50],
  [0.0, -0.10,  0.15, 0.20,  1.0,   0.15,  0.10],
  [-0.02,0.10,  0.85, 0.70,  0.15,  1.0,   0.55],
  [-0.05,0.20,  0.65, 0.50,  0.10,  0.55,  1.0],
];

function portfolioStats(weights, assets, corrMatrix) {
  const n = weights.length;
  let ret = 0;
  for (let i = 0; i < n; i++) ret += weights[i] * assets[i].expectedReturn;
  let variance = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) variance += weights[i] * weights[j] * assets[i].annualizedVol * assets[j].annualizedVol * corrMatrix[i][j] / 10000;
  const vol = Math.sqrt(Math.max(0, variance)) * 100;
  return { ret, vol, var5: ret - 1.645 * vol };
}

function portfolioStatsWithLeverage(weights, assets, corrMatrix, leverageIdx, leverageRatio, borrowCost) {
  const n = weights.length;
  const adjWeights = weights.map((w, i) => i === leverageIdx ? w * leverageRatio : w);
  const totalExposure = adjWeights.reduce((a, b) => a + b, 0);
  const extraExposure = totalExposure - 1;
  let ret = 0;
  for (let i = 0; i < n; i++) ret += adjWeights[i] * assets[i].expectedReturn;
  ret -= extraExposure * borrowCost;
  let variance = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) variance += adjWeights[i] * adjWeights[j] * assets[i].annualizedVol * assets[j].annualizedVol * corrMatrix[i][j] / 10000;
  const vol = Math.sqrt(Math.max(0, variance)) * 100;
  return { ret, vol, var5: ret - 1.645 * vol, totalExposure };
}

function generateFrontierWithPoints(assets, corrMatrix, count) {
  const points = [];
  const n = assets.length;
  for (let k = 0; k < count; k++) {
    const raw = Array.from({ length: n }, () => Math.random());
    const sum = raw.reduce((a, b) => a + b, 0);
    const w = raw.map((x) => x / sum);
    const { ret, vol } = portfolioStats(w, assets, corrMatrix);
    points.push({ ret, vol, weights: w });
  }
  const volBuckets = {};
  for (const p of points) {
    const bucket = Math.round(p.vol * 2) / 2;
    if (!volBuckets[bucket] || p.ret > volBuckets[bucket].ret) volBuckets[bucket] = p;
  }
  const frontier = Object.values(volBuckets).sort((a, b) => a.vol - b.vol);
  return { points, frontier };
}

function equalRiskContribution(assets, corrMatrix, excludeCashIdx) {
  const indices = assets.map((_, i) => i).filter((i) => i !== excludeCashIdx);
  const n = indices.length;
  const vols = indices.map((i) => assets[i].annualizedVol / 100);
  const corr = indices.map((i) => indices.map((j) => corrMatrix[i][j]));
  let w = Array(n).fill(1 / n);
  for (let iter = 0; iter < 300; iter++) {
    let tv = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) tv += w[i] * w[j] * vols[i] * vols[j] * corr[i][j];
    const pv = Math.sqrt(Math.max(0, tv));
    const mrc = [];
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += w[j] * vols[i] * vols[j] * corr[i][j]; mrc.push(s / (pv + 1e-12)); }
    const rc = w.map((wi, i) => wi * mrc[i]);
    const target = pv / n;
    const nw = w.map((wi, i) => wi * (target / (rc[i] + 1e-12)));
    const sumW = nw.reduce((a, b) => a + b, 0);
    w = nw.map((wi) => wi / sumW);
  }
  const full = Array(assets.length).fill(0);
  indices.forEach((ai, i) => { full[ai] = w[i]; });
  return full;
}

const PRESETS = {
  classic_6040: { name: "60/40 Adaptado", weights: [5, 35, 40, 5, 5, 5, 5], desc: "Modelo clásico con 60% riesgo (equity+alts) y 40% defensivo (bonds+cash). Base conservadora con exposición satelital a alternativas." },
  aggressive: { name: "Agresivo LP", weights: [2, 8, 40, 10, 15, 15, 10], desc: "Para inversor de largo plazo con alta tolerancia al riesgo. Fuerte en equity y PE, con commodities como hedge inflacionario." },
  endowment: { name: "Endowment Model", weights: [3, 10, 25, 15, 7, 25, 15], desc: "Inspirado en endowments tipo Yale/Harvard. Alta exposición a PE y HF buscando alpha e iliquidez premium." },
  equal_weight: { name: "Equal Weight", weights: Array(7).fill(100 / 7), desc: "1/N ingenuo. Baseline de comparación. Sorprendentemente difícil de batir en risk-adjusted terms a largo plazo." },
  max_sharpe: { name: "Max Diversification", weights: [5, 15, 25, 15, 15, 10, 15], desc: "Busca maximizar diversificación distribuyendo riesgo entre assets con baja correlación cruzada." },
};

const NumField = ({ value, onChange, color, width, step }) => (
  <input type="number" value={value} onChange={onChange} step={step || 0.1}
    style={{ width: width || 58, padding: "4px 6px", background: "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: color || "#F0F6FC", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", textAlign: "right", outline: "none" }}
    onFocus={(e) => (e.target.style.borderColor = "#58A6FF")} onBlur={(e) => (e.target.style.borderColor = "#30363D")} />
);

export default function PortfolioOptimizer() {
  const [assets, setAssets] = useState(DEFAULT_ASSETS.map((a) => ({ ...a })));
  const [corrMatrix, setCorrMatrix] = useState(DEFAULT_CORR.map((r) => [...r]));
  const [weights, setWeights] = useState(PRESETS.aggressive.weights);
  const [showFrontier, setShowFrontier] = useState(false);
  const [activeTab, setActiveTab] = useState("allocation");
  const [hovered, setHovered] = useState(null);
  const [assumptionsChanged, setAssumptionsChanged] = useState(false);
  const [selectedFrontierPoint, setSelectedFrontierPoint] = useState(null);
  // Leverage
  const [leverageEnabled, setLeverageEnabled] = useState(false);
  const [leverageIdx, setLeverageIdx] = useState(2); // default equity
  const [leverageRatio, setLeverageRatio] = useState(1.5);
  const [borrowCost, setBorrowCost] = useState(5.0);

  const svgRef = useRef(null);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const normalizedWeights = weights.map((w) => w / totalWeight);

  const stats = useMemo(() => {
    if (!leverageEnabled) return portfolioStats(normalizedWeights, assets, corrMatrix);
    return portfolioStatsWithLeverage(normalizedWeights, assets, corrMatrix, leverageIdx, leverageRatio, borrowCost);
  }, [weights, assets, corrMatrix, leverageEnabled, leverageIdx, leverageRatio, borrowCost]);

  const riskBudget = useMemo(() => {
    const n = assets.length;
    const aw = leverageEnabled ? normalizedWeights.map((w, i) => i === leverageIdx ? w * leverageRatio : w) : normalizedWeights;
    let tv = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) tv += aw[i] * aw[j] * assets[i].annualizedVol * assets[j].annualizedVol * corrMatrix[i][j] / 10000;
    const pv = Math.sqrt(Math.max(0, tv));
    return assets.map((ac, i) => {
      let mrc = 0;
      for (let j = 0; j < n; j++) mrc += aw[j] * ac.annualizedVol * assets[j].annualizedVol * corrMatrix[i][j] / 10000;
      mrc = mrc / (pv + 1e-12);
      const rc = aw[i] * mrc;
      return { ...ac, mrc, rc, pctRisk: (rc / (pv + 1e-12)) * 100, weight: normalizedWeights[i] * 100, adjWeight: aw[i] * 100 };
    });
  }, [weights, assets, corrMatrix, leverageEnabled, leverageIdx, leverageRatio]);

  const ercWeights = useMemo(() => equalRiskContribution(assets, corrMatrix, 0), [assets, corrMatrix]);
  const ercStats = useMemo(() => portfolioStats(ercWeights, assets, corrMatrix), [ercWeights, assets, corrMatrix]);
  const frontierData = useMemo(() => (showFrontier ? generateFrontierWithPoints(assets, corrMatrix, 10000) : null), [showFrontier, assets, corrMatrix]);

  const handleWeightChange = (idx, value) => { const nw = [...weights]; nw[idx] = Math.max(0, Math.min(100, Number(value))); setWeights(nw); };
  const updateAsset = (idx, field, value) => { setAssets((p) => p.map((a, i) => (i === idx ? { ...a, [field]: Number(value) } : a))); setAssumptionsChanged(true); setShowFrontier(false); };
  const updateCorr = (i, j, value) => { const v = Math.max(-1, Math.min(1, Number(value))); setCorrMatrix((p) => { const nc = p.map((r) => [...r]); nc[i][j] = v; nc[j][i] = v; return nc; }); setAssumptionsChanged(true); setShowFrontier(false); };
  const resetAssumptions = () => { setAssets(DEFAULT_ASSETS.map((a) => ({ ...a }))); setCorrMatrix(DEFAULT_CORR.map((r) => [...r])); setAssumptionsChanged(false); setShowFrontier(false); };
  const applyPreset = (key) => setWeights([...PRESETS[key].weights]);
  const applyERC = () => setWeights(ercWeights.map((w) => Math.round(w * 1000) / 10));

  // Click on frontier SVG
  const handleFrontierClick = (e) => {
    if (!frontierData || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = 700 / rect.width;
    const scaleY = 400 / rect.height;
    const svgX = (e.clientX - rect.left) * scaleX;
    const svgY = (e.clientY - rect.top) * scaleY;
    const clickVol = ((svgX - 60) / 620) * 25;
    const clickRet = ((370 - svgY) / 340) * 14;
    if (clickVol < 0 || clickVol > 25 || clickRet < 0 || clickRet > 14) return;
    // Find nearest frontier point
    let best = null, bestDist = Infinity;
    for (const p of frontierData.frontier) {
      const d = Math.sqrt(((p.vol - clickVol) / 25) ** 2 + ((p.ret - clickRet) / 14) ** 2);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    if (best && bestDist < 0.08) {
      setSelectedFrontierPoint(best);
      setWeights(best.weights.map((w) => Math.round(w * 1000) / 10));
    }
  };

  const box = { background: "#161B22", border: "1px solid #21262D", borderRadius: 10, padding: 20 };
  const micro = { fontSize: 10, color: "#484F58", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: 1 };

  return (
    <div style={{ fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif", background: "linear-gradient(145deg, #0D1117 0%, #161B22 50%, #0D1117 100%)", color: "#C9D1D9", minHeight: "100vh", padding: "24px" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
          <h1 style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: "#F0F6FC", margin: 0 }}>Portfolio Optimizer</h1>
          <span style={{ fontSize: 11, color: "#484F58", fontFamily: "'JetBrains Mono', monospace" }}>v2.0</span>
          {assumptionsChanged && <span style={{ fontSize: 10, color: "#D29922", fontFamily: "'JetBrains Mono', monospace", background: "#2D2200", padding: "2px 8px", borderRadius: 4 }}>● modified</span>}
          {leverageEnabled && <span style={{ fontSize: 10, color: "#F85149", fontFamily: "'JetBrains Mono', monospace", background: "#3D1117", padding: "2px 8px", borderRadius: 4 }}>⚡ {leverageRatio}x {assets[leverageIdx]?.name}</span>}
        </div>
        <p style={{ fontSize: 13, color: "#6E7681", margin: "4px 0 20px" }}>ERC (ex-Cash), frontera clickeable, y apalancamiento opcional.</p>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, marginBottom: 20, flexWrap: "wrap" }}>
          {[{ id: "allocation", label: "Allocation" }, { id: "risk", label: "Risk Budget" }, { id: "frontier", label: "Frontier" }, { id: "leverage", label: "⚡ Leverage" }, { id: "data", label: "⚙ Assumptions" }].map((tab) => (
            <button key={tab.id} onClick={() => { setActiveTab(tab.id); if (tab.id === "frontier") setShowFrontier(true); }}
              style={{ padding: "8px 16px", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: activeTab === tab.id ? 600 : 400, color: activeTab === tab.id ? "#F0F6FC" : "#6E7681", background: activeTab === tab.id ? "#21262D" : "transparent", border: `1px solid ${activeTab === tab.id ? "#30363D" : "transparent"}`, borderRadius: 6, cursor: "pointer" }}>{tab.label}</button>
          ))}
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 20 }}>
          {[
            { label: "Expected Return", value: `${stats.ret.toFixed(1)}%`, accent: "#3FB950" },
            { label: "Portfolio Vol", value: `${stats.vol.toFixed(1)}%`, accent: "#D29922" },
            { label: "VaR 5% (1yr)", value: `${stats.var5.toFixed(1)}%`, accent: stats.var5 < 0 ? "#F85149" : "#3FB950" },
            { label: "Sharpe (rf=4%)", value: ((stats.ret - 4) / (stats.vol + 1e-12)).toFixed(2), accent: "#58A6FF" },
            { label: "Gross Exposure", value: leverageEnabled ? `${(stats.totalExposure * 100).toFixed(0)}%` : "100%", accent: leverageEnabled && stats.totalExposure > 1 ? "#F85149" : "#8B949E" },
          ].map((s) => (
            <div key={s.label} style={{ background: "#161B22", border: "1px solid #21262D", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ ...micro, marginBottom: 5 }}>{s.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: s.accent, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* ========== ALLOCATION ========== */}
        {activeTab === "allocation" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 20 }}>
            <div style={box}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Asset Weights</h3>
                <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: Math.abs(totalWeight - 100) < 0.1 ? "#3FB950" : "#F85149" }}>Total: {totalWeight.toFixed(1)}%</span>
              </div>
              {assets.map((ac, i) => (
                <div key={ac.id} style={{ marginBottom: 14 }} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 3, background: ac.color }} />
                      <span style={{ fontSize: 13, fontWeight: 500, color: hovered === i ? "#F0F6FC" : "#C9D1D9" }}>{ac.name}</span>
                      {leverageEnabled && i === leverageIdx && <span style={{ fontSize: 9, color: "#F85149", background: "#3D1117", padding: "1px 5px", borderRadius: 3 }}>{leverageRatio}x</span>}
                    </div>
                    <input type="number" value={weights[i]} onChange={(e) => handleWeightChange(i, e.target.value)} style={{ width: 52, padding: "3px 6px", background: "#0D1117", border: "1px solid #30363D", borderRadius: 4, color: "#F0F6FC", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", textAlign: "right" }} />
                  </div>
                  <input type="range" min="0" max="60" step="0.5" value={weights[i]} onChange={(e) => handleWeightChange(i, e.target.value)} style={{ width: "100%", height: 4, appearance: "none", background: `linear-gradient(to right, ${ac.color} ${(weights[i] / 60) * 100}%, #21262D ${(weights[i] / 60) * 100}%)`, borderRadius: 2, outline: "none", cursor: "pointer" }} />
                </div>
              ))}
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #21262D" }}>
                <div style={{ ...micro, marginBottom: 8 }}>Presets</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {Object.entries(PRESETS).map(([key, preset]) => (
                    <button key={key} onClick={() => applyPreset(key)} style={{ padding: "8px 12px", fontSize: 11, background: "#21262D", border: "1px solid #30363D", borderRadius: 5, color: "#C9D1D9", cursor: "pointer", textAlign: "left", lineHeight: 1.4 }}>
                      <span style={{ fontWeight: 600, color: "#F0F6FC" }}>{preset.name}</span>
                      <span style={{ display: "block", fontSize: 10, color: "#6E7681", marginTop: 2 }}>{preset.desc}</span>
                    </button>
                  ))}
                  <button onClick={applyERC} style={{ padding: "8px 12px", fontSize: 11, background: "#1F3A2D", border: "1px solid #238636", borderRadius: 5, color: "#3FB950", cursor: "pointer", textAlign: "left", lineHeight: 1.4 }}>
                    <span style={{ fontWeight: 600 }}>ERC (ex-Cash)</span>
                    <span style={{ display: "block", fontSize: 10, color: "#2EA043", marginTop: 2 }}>Iguala contribución al riesgo de cada asset excluyendo Cash. Sobrepondera activos de baja vol.</span>
                  </button>
                </div>
              </div>
            </div>
            {/* Pie */}
            <div style={{ ...box, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <h3 style={{ margin: "0 0 16px", fontSize: 14, fontWeight: 600, color: "#F0F6FC", alignSelf: "flex-start" }}>Allocation</h3>
              <svg viewBox="0 0 200 200" style={{ width: 220, height: 220 }}>
                {(() => { let cum = -90; return assets.map((ac, i) => { const pct = normalizedWeights[i] * 100; if (pct < 0.5) return null; const angle = (pct / 100) * 360; const s = cum; cum += angle; const sr = (s * Math.PI) / 180, er = (cum * Math.PI) / 180; return <path key={ac.id} d={`M 100 100 L ${100 + 85 * Math.cos(sr)} ${100 + 85 * Math.sin(sr)} A 85 85 0 ${angle > 180 ? 1 : 0} 1 ${100 + 85 * Math.cos(er)} ${100 + 85 * Math.sin(er)} Z`} fill={ac.color} stroke="#161B22" strokeWidth="1.5" opacity={hovered === null || hovered === i ? 1 : 0.4} style={{ transition: "opacity 0.2s" }} />; }); })()}
                <circle cx="100" cy="100" r="42" fill="#161B22" />
                <text x="100" y="96" textAnchor="middle" fill="#F0F6FC" fontSize="16" fontWeight="700" fontFamily="JetBrains Mono">{stats.ret.toFixed(1)}%</text>
                <text x="100" y="112" textAnchor="middle" fill="#6E7681" fontSize="8" fontFamily="JetBrains Mono">E[Return]</text>
              </svg>
              <div style={{ marginTop: 16, width: "100%" }}>
                {assets.map((ac, i) => { const pct = normalizedWeights[i] * 100; if (pct < 0.5) return null; return (
                  <div key={ac.id} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", opacity: hovered === null || hovered === i ? 1 : 0.5 }} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: ac.color }} /><span style={{ fontSize: 11 }}>{ac.name}</span></div>
                    <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#8B949E" }}>{pct.toFixed(1)}%</span>
                  </div>); })}
              </div>
            </div>
          </div>
        )}

        {/* ========== RISK BUDGET ========== */}
        {activeTab === "risk" && (
          <div style={box}>
            <h3 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Risk Budget</h3>
            <p style={{ fontSize: 12, color: "#6E7681", margin: "0 0 16px" }}>Contribución al riesgo por asset. ERC busca barras iguales.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div>
                <div style={{ ...micro, marginBottom: 12 }}>% Contribución al Riesgo</div>
                {riskBudget.filter((r) => r.weight > 0.5).sort((a, b) => b.pctRisk - a.pctRisk).map((rb) => (
                  <div key={rb.id} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ fontSize: 12 }}>{rb.name}</span>
                      <div style={{ display: "flex", gap: 12 }}>
                        <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#6E7681" }}>w: {rb.weight.toFixed(1)}%{leverageEnabled && rb.adjWeight !== rb.weight ? ` (${rb.adjWeight.toFixed(0)}%)` : ""}</span>
                        <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: rb.pctRisk > rb.weight * 1.5 ? "#F85149" : rb.pctRisk < rb.weight * 0.5 ? "#3FB950" : "#D29922" }}>risk: {rb.pctRisk.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div style={{ height: 6, background: "#21262D", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, rb.pctRisk))}%`, background: rb.color, borderRadius: 3, transition: "width 0.3s" }} />
                    </div>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ ...micro, marginBottom: 12 }}>VaR 5% Standalone</div>
                <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                  <thead><tr style={{ borderBottom: "1px solid #30363D" }}>{["Asset", "VaR", "Weight", "MRC"].map((h, hi) => (<th key={h} style={{ textAlign: hi ? "right" : "left", padding: "4px 0", ...micro }}>{h}</th>))}</tr></thead>
                  <tbody>{assets.map((ac, i) => { const sv = ac.expectedReturn - 1.645 * ac.annualizedVol; return (
                    <tr key={ac.id} style={{ borderBottom: "1px solid #161B22" }}>
                      <td style={{ padding: "5px 0" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 6, height: 6, borderRadius: 2, background: ac.color }} />{ac.name}</div></td>
                      <td style={{ textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: sv < 0 ? "#F85149" : "#3FB950" }}>{sv.toFixed(1)}%</td>
                      <td style={{ textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#8B949E" }}>{(normalizedWeights[i] * 100).toFixed(1)}%</td>
                      <td style={{ textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#D29922" }}>{riskBudget[i].mrc.toFixed(2)}</td>
                    </tr>); })}</tbody>
                </table>
                <div style={{ marginTop: 16, padding: 12, background: "#0D1117", borderRadius: 6, border: "1px solid #21262D" }}>
                  <div style={{ ...micro, marginBottom: 4 }}>ERC Optimal (ex-Cash)</div>
                  {assets.map((ac, i) => ercWeights[i] > 0.005 ? (<div key={ac.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}><span style={{ fontSize: 11 }}>{ac.name}</span><span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#3FB950" }}>{(ercWeights[i] * 100).toFixed(1)}%</span></div>) : null)}
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #21262D", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#58A6FF" }}>
                    E[R]: {ercStats.ret.toFixed(1)}% | Vol: {ercStats.vol.toFixed(1)}% | VaR5: {ercStats.var5.toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========== FRONTIER (CLICKEABLE) ========== */}
        {activeTab === "frontier" && (
          <div style={box}>
            <h3 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Efficient Frontier — Clickeá un punto para seleccionar ese portfolio</h3>
            <p style={{ fontSize: 12, color: "#6E7681", margin: "0 0 6px" }}>10,000 portfolios Monte Carlo. La línea amarilla es la frontera eficiente. Clickeá sobre ella para adoptar ese portfolio.</p>
            {selectedFrontierPoint && (
              <div style={{ display: "flex", gap: 16, padding: "8px 12px", background: "#0D1117", borderRadius: 6, border: "1px solid #58A6FF", marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#58A6FF", fontWeight: 600 }}>Selected:</span>
                <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#3FB950" }}>Ret {selectedFrontierPoint.ret.toFixed(1)}%</span>
                <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#D29922" }}>Vol {selectedFrontierPoint.vol.toFixed(1)}%</span>
                <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#8B949E" }}>
                  {assets.map((ac, i) => selectedFrontierPoint.weights[i] > 0.03 ? `${ac.name.slice(0, 4)}: ${(selectedFrontierPoint.weights[i] * 100).toFixed(0)}%` : null).filter(Boolean).join(" · ")}
                </span>
              </div>
            )}
            {frontierData && (
              <svg ref={svgRef} viewBox="0 0 700 400" style={{ width: "100%", background: "#0D1117", borderRadius: 8, border: "1px solid #21262D", cursor: "crosshair" }} onClick={handleFrontierClick}>
                {[0, 2, 4, 6, 8, 10, 12, 14].map((v) => { const y = 370 - (v / 14) * 340; return <g key={`gy${v}`}><line x1="60" y1={y} x2="680" y2={y} stroke="#21262D" strokeWidth="0.5" /><text x="52" y={y + 4} textAnchor="end" fill="#484F58" fontSize="9" fontFamily="JetBrains Mono">{v}%</text></g>; })}
                {[0, 5, 10, 15, 20, 25].map((v) => { const x = 60 + (v / 25) * 620; return <g key={`gx${v}`}><line x1={x} y1="30" x2={x} y2="370" stroke="#21262D" strokeWidth="0.5" /><text x={x} y="386" textAnchor="middle" fill="#484F58" fontSize="9" fontFamily="JetBrains Mono">{v}%</text></g>; })}
                <text x="370" y="399" textAnchor="middle" fill="#6E7681" fontSize="10" fontFamily="JetBrains Mono">Volatility</text>
                <text x="15" y="200" textAnchor="middle" fill="#6E7681" fontSize="10" fontFamily="JetBrains Mono" transform="rotate(-90, 15, 200)">Return</text>
                {/* Scatter */}
                {frontierData.points.map((p, i) => { const x = 60 + (p.vol / 25) * 620, y = 370 - (p.ret / 14) * 340; return (x >= 60 && x <= 680 && y >= 30 && y <= 370) ? <circle key={i} cx={x} cy={y} r="1.3" fill="#30363D" opacity="0.25" /> : null; })}
                {/* Frontier line */}
                {frontierData.frontier.length > 2 && <polyline points={frontierData.frontier.filter((p) => p.vol <= 25 && p.ret <= 14).map((p) => `${60 + (p.vol / 25) * 620},${370 - (p.ret / 14) * 340}`).join(" ")} fill="none" stroke="#D29922" strokeWidth="2.5" opacity="0.9" />}
                {/* Frontier dots (clickable targets) */}
                {frontierData.frontier.filter((p) => p.vol <= 25 && p.ret <= 14).map((p, i) => (
                  <circle key={`fd${i}`} cx={60 + (p.vol / 25) * 620} cy={370 - (p.ret / 14) * 340} r="3" fill="#D29922" opacity="0.5" style={{ cursor: "pointer" }} />
                ))}
                {/* Current portfolio */}
                <circle cx={60 + (stats.vol / 25) * 620} cy={370 - (stats.ret / 14) * 340} r="7" fill="#F85149" stroke="#F0F6FC" strokeWidth="2" />
                <text x={60 + (stats.vol / 25) * 620 + 12} y={370 - (stats.ret / 14) * 340 + 4} fill="#F85149" fontSize="10" fontWeight="600" fontFamily="JetBrains Mono">Tu Portfolio</text>
                {/* ERC */}
                <circle cx={60 + (ercStats.vol / 25) * 620} cy={370 - (ercStats.ret / 14) * 340} r="5" fill="#3FB950" stroke="#F0F6FC" strokeWidth="1.5" />
                <text x={60 + (ercStats.vol / 25) * 620 + 10} y={370 - (ercStats.ret / 14) * 340 + 4} fill="#3FB950" fontSize="9" fontWeight="600" fontFamily="JetBrains Mono">ERC</text>
                {/* Individual assets */}
                {assets.map((ac) => { const x = 60 + (ac.annualizedVol / 25) * 620, y = 370 - (ac.expectedReturn / 14) * 340; return (x <= 680 && y >= 30) ? <g key={ac.id}><circle cx={x} cy={y} r="4" fill={ac.color} opacity="0.7" /><text x={x + 7} y={y + 3} fill={ac.color} fontSize="8" fontFamily="JetBrains Mono">{ac.name}</text></g> : null; })}
                {/* Selected point */}
                {selectedFrontierPoint && (
                  <circle cx={60 + (selectedFrontierPoint.vol / 25) * 620} cy={370 - (selectedFrontierPoint.ret / 14) * 340} r="8" fill="none" stroke="#58A6FF" strokeWidth="2.5" strokeDasharray="4 2" />
                )}
                {/* CML if leverage */}
                {leverageEnabled && (() => {
                  const rf = borrowCost;
                  const baseStats = portfolioStats(normalizedWeights, assets, corrMatrix);
                  const slope = (baseStats.ret - rf) / (baseStats.vol + 1e-12);
                  const x1 = 60, y1 = 370 - (rf / 14) * 340;
                  const endVol = 25, endRet = rf + slope * endVol;
                  const x2 = 60 + (endVol / 25) * 620, y2 = 370 - (Math.min(14, endRet) / 14) * 340;
                  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#F85149" strokeWidth="1.5" strokeDasharray="6 3" opacity="0.6" />;
                })()}
              </svg>
            )}
          </div>
        )}

        {/* ========== LEVERAGE ========== */}
        {activeTab === "leverage" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={box}>
              <h3 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>⚡ Apalancamiento</h3>
              <p style={{ fontSize: 12, color: "#6E7681", margin: "0 0 16px", lineHeight: 1.6 }}>
                Apalancar un asset permite escalar la exposición más allá del 100% del capital, financiando el exceso con deuda. 
                Esto mueve el portfolio a lo largo de la Capital Market Line (CML). Es más eficiente apalancar el portfolio entero o un asset 
                con buen Sharpe, típicamente via futuros, ETFs apalancados, o margin.
              </p>

              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                <button onClick={() => setLeverageEnabled(!leverageEnabled)} style={{
                  padding: "8px 16px", fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                  background: leverageEnabled ? "#3D1117" : "#21262D",
                  border: `1px solid ${leverageEnabled ? "#F85149" : "#30363D"}`,
                  color: leverageEnabled ? "#F85149" : "#C9D1D9",
                  borderRadius: 6, cursor: "pointer", fontWeight: 600,
                }}>{leverageEnabled ? "Desactivar Leverage" : "Activar Leverage"}</button>
              </div>

              {leverageEnabled && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                  <div>
                    <div style={{ ...micro, marginBottom: 8 }}>Asset a Apalancar</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {assets.map((ac, i) => (
                        <button key={ac.id} onClick={() => setLeverageIdx(i)} style={{
                          padding: "6px 10px", fontSize: 11, textAlign: "left",
                          background: i === leverageIdx ? "#21262D" : "transparent",
                          border: `1px solid ${i === leverageIdx ? ac.color : "transparent"}`,
                          borderRadius: 5, color: i === leverageIdx ? "#F0F6FC" : "#6E7681", cursor: "pointer",
                        }}>
                          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: ac.color, marginRight: 8 }} />
                          {ac.name} <span style={{ color: "#484F58", fontSize: 10 }}>σ={ac.annualizedVol}%</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ ...micro, marginBottom: 8 }}>Leverage Ratio: {leverageRatio}x</div>
                    <input type="range" min="1" max="3" step="0.1" value={leverageRatio} onChange={(e) => setLeverageRatio(Number(e.target.value))}
                      style={{ width: "100%", marginBottom: 16 }} />
                    <div style={{ ...micro, marginBottom: 8 }}>Costo de Fondeo: {borrowCost}%</div>
                    <input type="range" min="2" max="8" step="0.25" value={borrowCost} onChange={(e) => setBorrowCost(Number(e.target.value))}
                      style={{ width: "100%", marginBottom: 16 }} />
                    
                    <div style={{ padding: 12, background: "#0D1117", borderRadius: 6, border: "1px solid #21262D" }}>
                      <div style={{ fontSize: 11, color: "#8B949E", marginBottom: 8 }}>Con {leverageRatio}x en {assets[leverageIdx]?.name}:</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        {[
                          { l: "E[Return]", v: `${stats.ret.toFixed(1)}%`, c: "#3FB950" },
                          { l: "Vol", v: `${stats.vol.toFixed(1)}%`, c: "#D29922" },
                          { l: "VaR 5%", v: `${stats.var5.toFixed(1)}%`, c: stats.var5 < 0 ? "#F85149" : "#3FB950" },
                          { l: "Gross Exp", v: `${(stats.totalExposure * 100).toFixed(0)}%`, c: "#F85149" },
                        ].map((m) => (
                          <div key={m.l}><div style={{ fontSize: 9, color: "#484F58" }}>{m.l}</div><div style={{ fontSize: 14, fontWeight: 700, color: m.c, fontFamily: "'JetBrains Mono', monospace" }}>{m.v}</div></div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 20, padding: 14, background: "#0D1117", borderRadius: 8, border: "1px solid #21262D" }}>
                <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#D29922", fontWeight: 600 }}>¿Tiene sentido apalancar un solo asset?</h4>
                <div style={{ fontSize: 12, color: "#8B949E", lineHeight: 1.6 }}>
                  <p style={{ margin: "0 0 8px" }}>Depende. El approach teórico correcto es apalancar el <strong style={{ color: "#C9D1D9" }}>portfolio tangente</strong> (max Sharpe), no un solo asset. Apalancar un solo asset distorsiona la diversificación y concentra riesgo.</p>
                  <p style={{ margin: "0 0 8px" }}>Sin embargo, en la práctica se apalanca lo que tiene <strong style={{ color: "#C9D1D9" }}>instrumentos líquidos disponibles</strong>: equity via futuros de S&P/MSCI, bonds via repos/TRS, o incluso oro via futuros de COMEX. La clave es que el costo de fondeo sea menor que el retorno esperado del asset apalancado.</p>
                  <p style={{ margin: 0 }}>Si tu Sharpe del asset &gt; 0 después de costos de fondeo, el apalancamiento agrega valor. Pero incrementa el VaR proporcionalmente y el riesgo de margin call. Para un horizonte largo, un leverage moderado (1.2-1.5x) sobre equity es razonable si tolerás los drawdowns.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========== ASSUMPTIONS ========== */}
        {activeTab === "data" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={box}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#F0F6FC" }}>Retornos Esperados & Volatilidad</h3>
                <button onClick={resetAssumptions} style={{ padding: "4px 12px", fontSize: 11, background: "#21262D", border: "1px solid #30363D", borderRadius: 5, color: "#C9D1D9", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>↺ Reset</button>
              </div>
              <p style={{ fontSize: 12, color: "#6E7681", margin: "0 0 16px" }}>Editá directamente. Cambios en tiempo real.</p>
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <thead><tr style={{ borderBottom: "1px solid #30363D" }}>{["Asset Class", "E[Return] %", "Ann. Vol %", "VaR 5%", "Notas"].map((h, hi) => (<th key={h} style={{ textAlign: hi === 0 || hi === 4 ? "left" : "center", padding: "8px 4px", ...micro }}>{h}</th>))}</tr></thead>
                <tbody>{assets.map((ac, i) => { const v5 = ac.expectedReturn - 1.645 * ac.annualizedVol; return (
                  <tr key={ac.id} style={{ borderBottom: "1px solid #21262D" }}>
                    <td style={{ padding: "10px 4px" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: ac.color, flexShrink: 0 }} /><div><div style={{ color: "#C9D1D9", fontWeight: 500 }}>{ac.name}</div><div style={{ color: "#484F58", fontSize: 10 }}>{ac.description}</div></div></div></td>
                    <td style={{ textAlign: "center", padding: "10px 4px" }}><NumField value={ac.expectedReturn} onChange={(e) => updateAsset(i, "expectedReturn", e.target.value)} color="#3FB950" /></td>
                    <td style={{ textAlign: "center", padding: "10px 4px" }}><NumField value={ac.annualizedVol} onChange={(e) => updateAsset(i, "annualizedVol", e.target.value)} color="#D29922" /></td>
                    <td style={{ textAlign: "center", padding: "10px 4px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: v5 < 0 ? "#F85149" : "#3FB950" }}>{v5.toFixed(1)}%</td>
                    <td style={{ padding: "10px 4px", fontSize: 11, color: "#6E7681", maxWidth: 220 }}>{ac.varNote}</td>
                  </tr>); })}</tbody>
              </table>
            </div>
            <div style={box}>
              <h3 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "#58A6FF" }}>Matriz de Correlaciones</h3>
              <p style={{ fontSize: 12, color: "#6E7681", margin: "0 0 16px" }}>Editá triángulo superior. Inferior se sincroniza. Rango: -1 a 1.</p>
              <div style={{ overflowX: "auto" }}>
                <table style={{ fontSize: 10, borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace" }}>
                  <thead><tr><th style={{ padding: "6px 8px", minWidth: 70 }}></th>{assets.map((ac) => <th key={ac.id} style={{ padding: "6px 4px", color: ac.color, fontWeight: 500, fontSize: 9, minWidth: 62, textAlign: "center" }}>{ac.name.length > 8 ? ac.name.slice(0, 7) + "…" : ac.name}</th>)}</tr></thead>
                  <tbody>{assets.map((ac, i) => (
                    <tr key={ac.id}>
                      <td style={{ padding: "4px 8px", color: ac.color, fontWeight: 500, fontSize: 10 }}>{ac.name.length > 8 ? ac.name.slice(0, 7) + "…" : ac.name}</td>
                      {corrMatrix[i].map((corr, j) => (
                        <td key={j} style={{ padding: "3px 2px", textAlign: "center", background: i === j ? "#161B22" : `rgba(${corr > 0 ? "248,81,73" : "63,185,80"}, ${Math.abs(corr) * 0.15})` }}>
                          {i === j ? <span style={{ color: "#484F58" }}>1.00</span> : i < j ? (
                            <input type="number" value={corr} step="0.05" min="-1" max="1" onChange={(e) => updateCorr(i, j, e.target.value)}
                              style={{ width: 50, padding: "3px 2px", background: "transparent", border: "1px solid transparent", borderRadius: 3, color: corr > 0.5 ? "#F85149" : corr < 0 ? "#3FB950" : "#8B949E", fontSize: 10, fontFamily: "'JetBrains Mono', monospace", textAlign: "center", outline: "none" }}
                              onFocus={(e) => (e.target.style.borderColor = "#58A6FF")} onBlur={(e) => (e.target.style.borderColor = "transparent")} />
                          ) : <span style={{ color: corr > 0.5 ? "#F85149" : corr < 0 ? "#3FB950" : "#6E7681" }}>{corr.toFixed(2)}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: 20, padding: 12, background: "#0D1117", borderRadius: 8, fontSize: 10, color: "#484F58", fontFamily: "'JetBrains Mono', monospace" }}>
          VaR paramétrico 5% = E[R] − 1.645 × σ. ERC via Newton (ex-Cash). Leverage: E[R_lev] = Σ(w_adj × r_i) − (exposure−1) × borrow_cost. No es asesoramiento financiero.
        </div>
      </div>
    </div>
  );
}
