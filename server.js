// ============================================================
//  TXMD5 PREDICTOR - AUTO TREO RENDER 24/7
//  Node.js + Express - fetch API mỗi 10s, phân tích cầu,
//  dự đoán, check win/lose, dashboard HTML realtime.
// ============================================================

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_URL = "https://wtxmd52.macminim6.online/v1/txmd5/sessions";
const FETCH_INTERVAL = 10_000; // 10s

// ================== STATE ==================
const STATE = {
  sessions: [],          // mới → cũ
  prediction: null,      // { id, pick, confidence, reasons, cau, scoreTai, scoreXiu }
  history: [],           // [{ id, pick, confidence, actual, win }]
  winrate: { total: 0, win: 0, rate: 0 },
  lastUpdate: null,
  error: null,
  totalFetches: 0,
};

// ================== HELPERS ==================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSessions() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(API_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.list)) throw new Error("Invalid JSON");
    return data.list;
  } catch (e) {
    STATE.error = `Fetch error: ${e.message}`;
    console.error("[FETCH]", e.message);
    return null;
  }
}

// ================== ANALYZE CẦU ==================
function analyzeCau(sessions) {
  const results = sessions.map((s) => s.resultTruyenThong); // TAI/XIU
  const points = sessions.map((s) => s.point);

  // streak hiện tại
  const cur = results[0];
  let streak = 0;
  for (const r of results) {
    if (r === cur) streak++;
    else break;
  }

  const totalTai = results.filter((r) => r === "TAI").length;
  const totalXiu = results.filter((r) => r === "XIU").length;
  const total = results.length;

  // cầu 1-1 trong 6 phiên gần
  const last6 = results.slice(0, 6);
  let is11 = last6.length >= 6;
  for (let i = 0; i < last6.length - 1; i++) {
    if (last6[i] === last6[i + 1]) {
      is11 = false;
      break;
    }
  }

  // cầu bẻ (3 phiên đổi liên tục)
  let isBreak = false;
  if (results.length >= 4) {
    isBreak =
      results[0] !== results[1] &&
      results[1] !== results[2] &&
      results[2] !== results[3];
  }

  // streak dài nhất 20 phiên
  const recent = results.slice(0, 20);
  let maxTai = 0,
    maxXiu = 0,
    cTai = 0,
    cXiu = 0;
  for (const r of recent) {
    if (r === "TAI") {
      cTai++;
      cXiu = 0;
      maxTai = Math.max(maxTai, cTai);
    } else {
      cXiu++;
      cTai = 0;
      maxXiu = Math.max(maxXiu, cXiu);
    }
  }

  const avgPoint =
    points.slice(0, 10).reduce((a, b) => a + b, 0) /
    Math.min(10, points.length);

  return {
    streakType: cur,
    streakCount: streak,
    totalTai,
    totalXiu,
    total,
    rateTai: total ? totalTai / total : 0.5,
    maxStreakTai: maxTai,
    maxStreakXiu: maxXiu,
    is11,
    isBreak,
    avgPoint: Math.round(avgPoint * 10) / 10,
    lastResults: results.slice(0, 10),
    lastPoints: points.slice(0, 10),
    lastIds: sessions.slice(0, 10).map((s) => s.id),
  };
}

// ================== PREDICT ==================
function predict(sessions) {
  const cau = analyzeCau(sessions);
  const nextId = sessions[0].id + 1;

  const reasons = [];
  let sTai = 0;
  let sXiu = 0;

  // 1. Tỷ lệ tổng
  if (cau.rateTai > 0.53) {
    sTai += 2;
    reasons.push(
      `Tỷ lệ TÀI tổng ${(cau.rateTai * 100).toFixed(1)}% (>53%) → nghiêng TÀI`
    );
  } else if (cau.rateTai < 0.47) {
    sXiu += 2;
    reasons.push(
      `Tỷ lệ XỈU tổng ${((1 - cau.rateTai) * 100).toFixed(1)}% (>53%) → nghiêng XỈU`
    );
  }

  // 2. Cầu bệt
  if (cau.streakCount >= 3) {
    if (cau.streakType === "TAI") {
      sTai += 3;
      reasons.push(`Cầu bệt TÀI ${cau.streakCount} phiên → bám TÀI`);
    } else {
      sXiu += 3;
      reasons.push(`Cầu bệt XỈU ${cau.streakCount} phiên → bám XỈU`);
    }
  }

  // 3. Cầu 1-1
  if (cau.is11) {
    if (cau.lastResults[0] === "TAI") {
      sXiu += 2;
      reasons.push("Cầu 1-1 (so le) → đảo sang XỈU");
    } else {
      sTai += 2;
      reasons.push("Cầu 1-1 (so le) → đảo sang TÀI");
    }
  }

  // 4. Cầu bẻ
  if (cau.isBreak) {
    if (cau.lastResults[0] === "TAI") {
      sXiu += 1;
      reasons.push("Cầu bẻ liên tục → ưu tiên đảo XỈU");
    } else {
      sTai += 1;
      reasons.push("Cầu bẻ liên tục → ưu tiên đảo TÀI");
    }
  }

  // 5. Điểm TB
  if (cau.avgPoint >= 11) {
    sTai += 1;
    reasons.push(`Điểm TB 10 phiên ${cau.avgPoint} (≥11) → TÀI`);
  } else if (cau.avgPoint <= 9) {
    sXiu += 1;
    reasons.push(`Điểm TB 10 phiên ${cau.avgPoint} (≤9) → XỈU`);
  }

  // 6. Né bệt quá dài
  if (cau.streakCount >= 6) {
    if (cau.streakType === "TAI") {
      sXiu += 2;
      reasons.push("Bệt TÀI ≥6 phiên → cảnh báo bẻ XỈU");
    } else {
      sTai += 2;
      reasons.push("Bệt XỈU ≥6 phiên → cảnh báo bẻ TÀI");
    }
  }

  // Quyết định
  let pick, conf;
  if (sTai >= sXiu) {
    pick = "TAI";
    conf = Math.min(95, 55 + (sTai - sXiu) * 4);
  } else {
    pick = "XIU";
    conf = Math.min(95, 55 + (sXiu - sTai) * 4);
  }

  return {
    id: nextId,
    pick,
    confidence: conf,
    scoreTai: sTai,
    scoreXiu: sXiu,
    reasons,
    cau,
    createdAt: new Date().toISOString(),
  };
}

// ================== CHECK WIN/LOSE ==================
function checkPrevious(sessions) {
  const map = {};
  for (const s of sessions) map[s.id] = s.resultTruyenThong;

  let changed = false;
  for (const h of STATE.history) {
    if (h.actual == null && map[h.id] != null) {
      h.actual = map[h.id];
      h.win = h.pick === h.actual;
      changed = true;
    }
  }

  if (changed) {
    const done = STATE.history.filter((h) => h.actual != null);
    const wins = done.filter((h) => h.win).length;
    STATE.winrate = {
      total: done.length,
      win: wins,
      rate: done.length ? +((wins / done.length) * 100).toFixed(1) : 0,
    };
  }
}

// ================== MAIN LOOP ==================
let isRunning = false;

async function mainLoop() {
  if (isRunning) return;
  isRunning = true;
  console.log("[LOOP] Started — interval", FETCH_INTERVAL, "ms");

  while (true) {
    try {
      const sessions = await fetchSessions();
      if (sessions && sessions.length) {
        STATE.sessions = sessions;
        STATE.error = null;
        STATE.lastUpdate = new Date().toLocaleString("vi-VN", {
          timeZone: "Asia/Ho_Chi_Minh",
        });
        STATE.totalFetches++;

        // check win/lose cho các dự đoán cũ
        checkPrevious(sessions);

        // tạo dự đoán mới cho phiên kế tiếp
        const nextId = sessions[0].id + 1;
        const existing = STATE.history.find((h) => h.id === nextId);

        const pred = predict(sessions);
        STATE.prediction = pred;

        if (!existing) {
          STATE.history.push({
            id: pred.id,
            pick: pred.pick,
            confidence: pred.confidence,
            actual: null,
            win: null,
          });
          // giữ tối đa 200 phiên
          if (STATE.history.length > 200) {
            STATE.history = STATE.history.slice(-200);
          }
          console.log(
            `[PREDICT] #${pred.id} → ${pred.pick} (${pred.confidence}%)`
          );
        }
      }
    } catch (e) {
      console.error("[LOOP ERROR]", e.message);
    }

    await sleep(FETCH_INTERVAL);
  }
}

// ================== HTML RENDER ==================
function renderHTML() {
  const p = STATE.prediction;
  const cau = p?.cau || {};
  const hist = [...STATE.history].reverse().slice(0, 20);
  const wr = STATE.winrate;

  const pickClass = p?.pick === "TAI" ? "tai" : "xiu";
  const pickText = p ? p.pick : "—";

  const cauTags = [];
  if (cau.streakCount >= 3)
    cauTags.push(
      `<span class="tag bfet">Bệt ${cau.streakType} ${cau.streakCount}</span>`
    );
  if (cau.is11) cauTags.push(`<span class="tag">1-1 so le</span>`);
  if (cau.isBreak) cauTags.push(`<span class="tag">Bẻ liên tục</span>`);
  if (cau.maxStreakTai >= 4)
    cauTags.push(`<span class="tag">Max bệt TÀI ${cau.maxStreakTai}</span>`);
  if (cau.maxStreakXiu >= 4)
    cauTags.push(`<span class="tag">Max bệt XỈU ${cau.maxStreakXiu}</span>`);

  const reasonsHtml = (p?.reasons || [])
    .map((r) => `<li>${r}</li>`)
    .join("");

  const histRows = hist
    .map((h) => {
      const status =
        h.actual == null
          ? `<span class="pending">⏳ chờ</span>`
          : h.win
          ? `<span class="win">✅ THẮNG</span>`
          : `<span class="lose">❌ THUA</span>`;
      const pickCls = h.pick === "TAI" ? "tai-text" : "xiu-text";
      const actCls = h.actual === "TAI" ? "tai-text" : "xiu-text";
      return `<tr>
        <td>#${h.id}</td>
        <td class="${pickCls}">${h.pick}</td>
        <td>${h.confidence}%</td>
        <td class="${h.actual ? actCls : ""}">${h.actual || "—"}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join("");

  const last10 = (cau.lastResults || [])
    .map(
      (r) =>
        `<span class="dot ${r === "TAI" ? "d-tai" : "d-xiu"}">${
          r === "TAI" ? "T" : "X"
        }</span>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>TXMD5 Predictor — Render</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e2e8f0;margin:0;padding:16px}
  .wrap{max-width:960px;margin:auto}
  .card{background:#111a2e;border-radius:14px;padding:18px;margin-bottom:14px;box-shadow:0 6px 24px rgba(0,0,0,.4);border:1px solid #1e293b}
  h1{text-align:center;font-size:20px;color:#38bdf8;margin:0 0 6px}
  .sub{text-align:center;font-size:12px;color:#64748b}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:600px){.grid{grid-template-columns:1fr}}
  .info{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #1e293b;font-size:14px}
  .info:last-child{border:none}
  .info span:first-child{color:#94a3b8}
  .pred{font-size:56px;font-weight:800;text-align:center;padding:18px;border-radius:14px;margin:12px 0;letter-spacing:2px}
  .tai{background:linear-gradient(135deg,#dc2626,#991b1b);color:#fff;text-shadow:0 0 20px rgba(255,255,255,.3)}
  .xiu{background:linear-gradient(135deg,#2563eb,#1e3a8a);color:#fff;text-shadow:0 0 20px rgba(255,255,255,.3)}
  .conf{text-align:center;font-size:16px;color:#facc15;font-weight:600}
  .tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;justify-content:center}
  .tag{background:#1e293b;color:#38bdf8;padding:4px 10px;border-radius:20px;font-size:12px;border:1px solid #334155}
  .tag.bfet{background:#3f1d1d;color:#f87171;border-color:#7f1d1d}
  .dots{display:flex;gap:6px;justify-content:center;margin:10px 0;flex-wrap:wrap}
  .dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;color:#fff}
  .d-tai{background:#dc2626}
  .d-xiu{background:#2563eb}
  ul{margin:8px 0;padding-left:20px;font-size:13px;color:#cbd5e1}
  li{margin:4px 0}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:8px 6px;text-align:center;border-bottom:1px solid #1e293b}
  th{color:#38bdf8;font-weight:600}
  .tai-text{color:#f87171;font-weight:700}
  .xiu-text{color:#60a5fa;font-weight:700}
  .win{color:#4ade80;font-weight:700}
  .lose{color:#f87171;font-weight:700}
  .pending{color:#94a3b8}
  .wr{display:flex;justify-content:space-around;text-align:center;margin-top:8px}
  .wr div{font-size:13px;color:#94a3b8}
  .wr b{display:block;font-size:22px;color:#38bdf8}
  .footer{text-align:center;font-size:11px;color:#475569;margin-top:10px}
  .err{background:#7f1d1d;color:#fecaca;padding:8px;border-radius:8px;font-size:12px;margin-bottom:10px}
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <h1>🎲 TXMD5 PREDICTOR — AUTO RENDER</h1>
    <div class="sub">Cập nhật: ${STATE.lastUpdate || "—"} · Lần fetch: ${STATE.totalFetches} · Refresh 15s</div>
    ${STATE.error ? `<div class="err">⚠️ ${STATE.error}</div>` : ""}
  </div>

  ${
    p
      ? `
  <div class="card">
    <div class="info"><span>Phiên dự đoán</span><span><b>#${p.id}</b></span></div>
    <div class="info"><span>Phiên gần nhất</span><span>#${
      STATE.sessions[0]?.id
    } — ${STATE.sessions[0]?.resultTruyenThong} (${
          STATE.sessions[0]?.point
        } điểm)</span></div>
    <div class="pred ${pickClass}">${pickText}</div>
    <div class="conf">Độ tin cậy: ${p.confidence}% · Score TÀI ${p.scoreTai} : ${p.scoreXiu} XỈU</div>
    <div class="tags">${cauTags.join("")}</div>
    <div class="dots">${last10}</div>
    <ul>${reasonsHtml}</ul>
  </div>

  <div class="card">
    <div class="wr">
      <div>Tổng dự đoán<b>${wr.total}</b></div>
      <div>Thắng<b>${wr.win}</b></div>
      <div>Winrate<b>${wr.rate}%</b></div>
    </div>
  </div>

  <div class="card">
    <h2 style="color:#38bdf8;font-size:16px;margin:0 0 10px">📜 Lịch sử 20 phiên dự đoán gần nhất</h2>
    <table>
      <tr><th>ID</th><th>Dự đoán</th><th>Conf</th><th>Kết quả</th><th>Check</th></tr>
      ${histRows || '<tr><td colspan="5">Chưa có dữ liệu</td></tr>'}
    </table>
  </div>
  `
      : `<div class="card"><p style="text-align:center;color:#94a3b8">⏳ Đang chờ dữ liệu API...</p></div>`
  }

  <div class="footer">⚠️ Dự đoán tham khảo — quản lý vốn hợp lý. Server tự chạy 24/7 trên Render.</div>
</div>
</body>
</html>`;
}

// ================== ROUTES ==================
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderHTML());
});

app.get("/api/state", (req, res) => {
  res.json({
    prediction: STATE.prediction,
    winrate: STATE.winrate,
    lastUpdate: STATE.lastUpdate,
    totalFetches: STATE.totalFetches,
    error: STATE.error,
    history: STATE.history.slice(-30),
    sessions: STATE.sessions.slice(0, 20),
  });
});

app.get("/health", (req, res) => res.send("OK"));

// ================== START ==================
app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
  mainLoop();
});

// Render free tier sleep 15p nếu không traffic → giữ ấm bằng self-ping
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/health`).catch(() => {});
  }, 5 * 60 * 1000); // 5 phút ping 1 lần
                                       }
