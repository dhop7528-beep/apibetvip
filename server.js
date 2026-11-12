const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

/* =========================================================
   CẤU HÌNH
   ========================================================= */
const API_URL = process.env.API_URL || 'https://wtxmd52.macminim6.online/v1/txmd5/sessions';
const CACHE_TTL = 4000;          // cache 4s
const FORCE_REFRESH_MS = 10000;  // nếu cache cũ > 10s → fetch lại

let cache = { list: [], t: 0 };

/* =========================================================
   ADAPTER: chuẩn hoá dữ liệu từ API gốc
   Chấp nhận nhiều format field khác nhau
   ========================================================= */
function normalizeItem(raw) {
  if (!raw) return null;

  // ID phiên
  const id = Number(raw.id ?? raw.sessionId ?? raw.phien ?? raw.session_id ?? 0);
  if (!id) return null;

  // Kết quả T/X
  let kq = raw.resultTruyenThong ?? raw.result ?? raw.ketQua ?? raw.outcome ?? raw.result_tx ?? '';
  kq = String(kq).toUpperCase().trim();
  if (['T', 'TAI', 'BIG', '1', 'TÀI'].includes(kq)) kq = 'TAI';
  else if (['X', 'XIU', 'SMALL', '0', 'XỈU'].includes(kq)) kq = 'XIU';

  // Dice
  let dices = raw.dices ?? raw.dice ?? raw.xucXac ?? raw.diceValues ?? raw.dice_values ?? [];
  if (typeof dices === 'string') {
    dices = dices.split(/[,\-\s]+/).map(Number).filter(n => !isNaN(n));
  }
  if (!Array.isArray(dices)) dices = [];
  dices = dices.map(Number).filter(n => !isNaN(n));

  // Point
  let point = Number(raw.point ?? raw.diem ?? raw.total ?? raw.score ?? 0);
  if (!point && dices.length) point = dices.reduce((a, b) => a + b, 0);

  // Nếu không có kq → suy ra từ point
  if (!kq && point) kq = point >= 11 ? 'TAI' : 'XIU';

  if (!kq) return null;
  return { id, result: kq, dices, point };
}

/* =========================================================
   FETCH dữ liệu từ API gốc
   ========================================================= */
async function fetchHistory() {
  const now = Date.now();
  if (cache.list.length && now - cache.t < CACHE_TTL) return cache.list;

  try {
    const res = await axios.get(API_URL, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'vi,en;q=0.9'
      }
    });

    let raw = res.data?.list || (Array.isArray(res.data) ? res.data : []);
    const list = raw.map(normalizeItem).filter(Boolean);
    list.sort((a, b) => b.id - a.id); // mới nhất trước

    if (list.length) cache = { list, t: now };
    return list;
  } catch (e) {
    console.error('[fetch err]', e.message);
    return cache.list;
  }
}

/* =========================================================
   HELPERS (deterministic)
   ========================================================= */
const flip = s => (s === 'TAI' ? 'XIU' : 'TAI');

function runLength(R, start = 0) {
  const t = R[start];
  let n = 1;
  for (let i = start + 1; i < R.length; i++) {
    if (R[i] === t) n++; else break;
  }
  return { type: t, len: n };
}

function zigzagLength(R) {
  if (R.length < 2) return 1;
  let n = 1;
  for (let i = 1; i < R.length; i++) {
    if (R[i] !== R[i - 1]) n++; else break;
  }
  return n;
}

function repeatUniformBlocks(R, k) {
  if (R.length < k * 2) return 0;
  let blocks = 0, prev = null;
  for (let i = 0; i + k <= R.length; i += k) {
    const block = R.slice(i, i + k);
    if (!block.every(x => x === block[0])) break;
    if (prev !== null && block[0] === prev) break;
    prev = block[0];
    blocks++;
  }
  return blocks;
}

function repeatPattern(R, p1, p2) {
  let i = 0, phase = 0, cycles = 0;
  while (i < R.length) {
    const len = phase === 0 ? p1 : p2;
    if (i + len > R.length) break;
    const block = R.slice(i, i + len);
    if (!block.every(x => x === block[0])) break;
    i += len;
    if (phase === 1) cycles++;
    phase = 1 - phase;
  }
  return { cycles, consumed: i, nextPhase: phase };
}

function countN(R, n) {
  const arr = R.slice(0, n);
  const t = arr.filter(x => x === 'TAI').length;
  return { TAI: t, XIU: arr.length - t, total: arr.length };
}

/* =========================================================
   NHẬN DIỆN CẦU — 12 loại pattern
   ========================================================= */
function detectPatterns(R) {
  const out = [];
  if (R.length < 3) return out;

  // 1) BỆT
  const b = runLength(R);
  if (b.len >= 2) {
    if (b.len >= 6) {
      out.push({
        loai: 'bet_dai', name: `Bệt ${b.type} dài`, doDai: b.len,
        duDoan: flip(b.type),
        baseTin: 62 + Math.min(b.len - 6, 6) * 3,
        ghiChu: `Bệt ${b.type} đã ${b.len} phiên — quá dài, ưu tiên BẺ.`
      });
    } else {
      out.push({
        loai: 'bet', name: `Bệt ${b.type}`, doDai: b.len,
        duDoan: b.type,
        baseTin: 58 + b.len * 5,
        ghiChu: `Bệt ${b.type} ${b.len} phiên — còn THEO.`
      });
    }
  }

  // 2) SO LE 1-1
  const z = zigzagLength(R);
  if (z >= 3) {
    out.push({
      loai: 'sole', name: 'So le 1-1', doDai: z,
      duDoan: flip(R[0]),
      baseTin: 56 + Math.min(z, 8) * 3,
      ghiChu: `So le ${z} phiên — phiên tới đảo.`
    });
  }

  // 3) KÉP 2-2
  const k2 = repeatUniformBlocks(R, 2);
  if (k2 >= 2) {
    const same = R[0] === R[1];
    out.push({
      loai: 'kep22', name: 'Kép 2-2', doDai: k2,
      duDoan: same ? flip(R[0]) : R[0],
      baseTin: 60 + Math.min(k2, 4) * 4,
      ghiChu: same
        ? `2-2 (${k2} nhịp) — cặp đủ 2, dự kiến BẺ.`
        : `2-2 (${k2} nhịp) — cặp mới 1, dự kiến lặp.`
    });
  }

  // 4) KÉP 3-3
  const k3 = repeatUniformBlocks(R, 3);
  if (k3 >= 2) {
    const rn = runLength(R);
    out.push({
      loai: 'kep33', name: 'Kép 3-3', doDai: k3,
      duDoan: rn.len >= 3 ? flip(R[0]) : R[0],
      baseTin: 63 + Math.min(k3, 3) * 4,
      ghiChu: rn.len >= 3 ? `3-3 — đủ 3, dự kiến BẺ.` : `3-3 — mới ${rn.len}, dự kiến lặp.`
    });
  }

  // 5) KÉP 4-4
  const k4 = repeatUniformBlocks(R, 4);
  if (k4 >= 2) {
    const rn = runLength(R);
    out.push({
      loai: 'kep44', name: 'Kép 4-4', doDai: k4,
      duDoan: rn.len >= 4 ? flip(R[0]) : R[0],
      baseTin: 66,
      ghiChu: rn.len >= 4 ? `4-4 — đủ 4, dự kiến BẺ.` : `4-4 — mới ${rn.len}, dự kiến lặp.`
    });
  }

  // 6) CẦU 1-2 / 2-1
  for (const [p1, p2, ten] of [[1, 2, '1-2'], [2, 1, '2-1']]) {
    const p = repeatPattern(R, p1, p2);
    if (p.cycles >= 2 && p.consumed >= 3) {
      const lastType = R[p.consumed - 1];
      out.push({
        loai: 'kep12', name: `Cầu ${ten}`, doDai: p.cycles,
        duDoan: lastType,
        baseTin: 58 + Math.min(p.cycles, 4) * 3,
        ghiChu: `Cầu ${ten} (${p.cycles} chu kỳ) — theo nhịp ${lastType}.`
      });
    }
  }

  // 7) CẦU NGHIÊNG 20 phiên
  const c20 = countN(R, 20);
  if (c20.total >= 15) {
    const lech = Math.abs(c20.TAI - c20.XIU);
    if (lech >= 6) {
      const thieu = c20.TAI < c20.XIU ? 'TAI' : 'XIU';
      out.push({
        loai: 'nghieng', name: 'Nghiêng 20 phiên', doDai: 20,
        duDoan: thieu,
        baseTin: 55 + Math.min(lech, 10) * 2,
        ghiChu: `20 phiên lệch ${lech} (${c20.TAI}T/${c20.XIU}X) — cân bằng về ${thieu}.`
      });
    }
  }

  // 8) CẦU NGẮN
  let changes = 0;
  const lim = Math.min(8, R.length);
  for (let i = 1; i < lim; i++) if (R[i] !== R[i - 1]) changes++;
  if (changes >= 4) {
    out.push({
      loai: 'ngan', name: 'Cầu ngắn', doDai: changes,
      duDoan: flip(R[0]),
      baseTin: 55 + Math.min(changes, 6) * 2,
      ghiChu: `${changes}/7 phiên đổi — cầu ngắn, ưu tiên đảo.`
    });
  }

  // 9) CẦU GÃY
  if (R.length >= 5 && R[0] === R[1] && R[1] !== R[2] && R[2] !== R[3] && R[3] !== R[4]) {
    out.push({
      loai: 'gay', name: 'Cầu gãy', doDai: 5,
      duDoan: R[0],
      baseTin: 57,
      ghiChu: `Bệt vừa gãy → so le, dự kiến tiếp ${R[0]}.`
    });
  }

  // 10) CẦU 1-3 / 3-1
  for (const [p1, p2, ten] of [[1, 3, '1-3'], [3, 1, '3-1']]) {
    const p = repeatPattern(R, p1, p2);
    if (p.cycles >= 2 && p.consumed >= 4) {
      const lastType = R[p.consumed - 1];
      out.push({
        loai: 'kep13', name: `Cầu ${ten}`, doDai: p.cycles,
        duDoan: lastType,
        baseTin: 60 + Math.min(p.cycles, 3) * 3,
        ghiChu: `Cầu ${ten} (${p.cycles} chu kỳ) — theo nhịp ${lastType}.`
      });
    }
  }

  return out;
}

/* =========================================================
   BACKTEST từng loại cầu trên lịch sử
   ========================================================= */
function backtest(list, R) {
  const stats = {};
  const maxCheck = Math.min(50, list.length - 1);
  for (let i = 0; i < maxCheck; i++) {
    const pastR = R.slice(i + 1);
    if (pastR.length < 4) continue;
    const pats = detectPatterns(pastR);
    const actual = R[i];
    for (const p of pats) {
      if (!stats[p.loai]) stats[p.loai] = { dung: 0, sai: 0 };
      if (p.duDoan === actual) stats[p.loai].dung++;
      else stats[p.loai].sai++;
    }
  }
  for (const k of Object.keys(stats)) {
    const s = stats[k];
    s.total = s.dung + s.sai;
    s.winrate = s.total ? +(s.dung / s.total * 100).toFixed(1) : 50;
  }
  return stats;
}

/* =========================================================
   DỰ ĐOÁN — vote trọng số, KHÔNG random
   ========================================================= */
function predict(list) {
  if (!list || list.length < 5) {
    return {
      duDoan: 'TAI', doTinCay: 51, loaiCauChinh: 'Chưa đủ dữ liệu',
      phanTich: 'Cần thêm phiên để phân tích.', nenTheoHayBe: 'Theo',
      chiTietCau: [], vote: { TAI: 0, XIU: 0 }, backtestTheoLoaiCau: {}
    };
  }

  const R = list.map(x => x.result);
  const pats = detectPatterns(R);
  const bt = backtest(list, R);

  let vTAI = 0, vXIU = 0;
  const chiTiet = [];

  for (const p of pats) {
    const b = bt[p.loai] || { winrate: 50, total: 0, dung: 0, sai: 0 };
    const wr = b.total >= 5 ? b.winrate / 100 : 0.5;
    const base = Math.min(p.baseTin, 90) / 100;
    const lenBoost = 1 + Math.min(p.doDai, 10) / 25;
    const w = base * wr * lenBoost * 10;

    if (p.duDoan === 'TAI') vTAI += w; else vXIU += w;

    chiTiet.push({
      cau: p.name, loai: p.loai, duDoan: p.duDoan,
      doTinCayGoc: Math.round(p.baseTin), doDai: p.doDai,
      ghiChu: p.ghiChu, trongSo: +w.toFixed(2),
      backtest: { mau: b.total, dung: b.dung, sai: b.sai, winrate: b.winrate }
    });
  }

  const duDoan = vTAI >= vXIU ? 'TAI' : 'XIU';
  const tong = vTAI + vXIU || 1;
  const lech = Math.abs(vTAI - vXIU) / tong;

  let doTinCay = Math.round(50 + lech * 40);
  const strong = chiTiet.slice().sort((a, b) => b.trongSo - a.trongSo)[0];
  if (strong && strong.duDoan !== duDoan) doTinCay -= 6;
  doTinCay = Math.max(50, Math.min(90, doTinCay));

  const cungHuong = chiTiet.filter(c => c.duDoan === duDoan).sort((a, b) => b.trongSo - a.trongSo);
  const chinh = cungHuong[0] || strong;

  return {
    duDoan, doTinCay,
    loaiCauChinh: chinh ? chinh.cau : 'Không rõ',
    phanTich: chinh ? chinh.ghiChu : 'Không có pattern rõ.',
    nenTheoHayBe: strong && strong.duDoan !== duDoan ? 'Cầu mạnh nhất NGƯỢC — cân nhắc BẺ' : 'Theo',
    chiTietCau: chiTiet.sort((a, b) => b.trongSo - a.trongSo),
    vote: { TAI: +vTAI.toFixed(2), XIU: +vXIU.toFixed(2) },
    backtestTheoLoaiCau: bt
  };
}

/* =========================================================
   API /dunphi — JSON GỌN cho phiên kế tiếp
   ========================================================= */
app.get('/dunphi', async (req, res) => {
  try {
    if (req.query.fresh === '1' || Date.now() - cache.t > FORCE_REFRESH_MS) {
      cache.t = 0;
    }
    const list = await fetchHistory();
    if (!list.length) {
      return res.status(503).json({
        error: 'Không lấy được dữ liệu từ API gốc',
        apiGoc: API_URL,
        goiY: 'Kiểm tra API gốc còn sống không, hoặc thử lại sau vài giây.'
      });
    }

    const latest = list[0];
    const nextId = latest.id + 1;
    const p = predict(list);
    const R = list.map(x => x.result);
    const rl = runLength(R);
    const c20 = countN(R, 20);

    res.json({
      phienDuDoan: nextId,
      duDoan: p.duDoan,
      doTinCay: p.doTinCay,
      loaiCauChinh: p.loaiCauChinh,
      phanTich: p.phanTich,
      nenTheoHayBe: p.nenTheoHayBe,
      phienTruoc: {
        id: latest.id,
        ketQua: latest.result,
        dice: latest.dices,
        point: latest.point
      },
      chiTietCau: p.chiTietCau,
      vote: p.vote,
      thongKe20: {
        tai: c20.TAI,
        xiu: c20.XIU,
        betHienTai: `${rl.type} x${rl.len}`
      },
      thoiGian: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================================================
   API /dun — HTML: 1 khung dự đoán lớn + bảng check thu gọn
   ========================================================= */
app.get('/dun', async (req, res) => {
  try {
    if (req.query.fresh === '1' || Date.now() - cache.t > FORCE_REFRESH_MS) {
      cache.t = 0;
    }
    const list = await fetchHistory();
    if (!list.length) {
      return res.status(503).send('<h1 style="color:red">Không có dữ liệu từ API gốc</h1>');
    }

    const latest = list[0];
    const nextId = latest.id + 1;
    const next = predict(list);

    // Backtest check 40 phiên
    const rows = [];
    let dung = 0, sai = 0;
    const maxCheck = Math.min(40, list.length - 1);
    for (let i = 0; i < maxCheck; i++) {
      const actual = list[i];
      const past = list.slice(i + 1);
      if (past.length < 6) continue;
      const p = predict(past);
      const ok = p.duDoan === actual.result;
      if (ok) dung++; else sai++;
      rows.push({
        id: actual.id,
        dice: actual.dices.join('-'),
        point: actual.point,
        ketQua: actual.result,
        duDoan: p.duDoan,
        doTinCay: p.doTinCay,
        loaiCau: p.loaiCauChinh,
        check: ok ? 'ĐÚNG' : 'SAI'
      });
    }
    const tong = dung + sai;
    const tyLe = tong ? (dung / tong * 100).toFixed(1) : 0;

    const voteTotal = next.vote.TAI + next.vote.XIU || 1;
    const taiPct = Math.round(next.vote.TAI / voteTotal * 100);
    const xiuPct = 100 - taiPct;

    const html = `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>Dự đoán LC79 — Phiên ${nextId}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e2e8f0;margin:0;padding:16px;max-width:720px;margin:0 auto}
h1{font-size:18px;text-align:center;color:#38bdf8;margin:4px 0 16px}
.hero{background:linear-gradient(135deg,#16213a,#1e2b4a);border-radius:16px;padding:24px;margin-bottom:16px;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.4);border:1px solid #243354}
.hero .lbl{font-size:14px;color:#94a3b8;letter-spacing:.5px}
.hero .phien{font-size:13px;color:#64748b;margin-top:2px}
.hero .val{font-size:64px;font-weight:900;margin:12px 0;letter-spacing:2px;text-shadow:0 0 20px currentColor}
.tai{color:#ef4444}.xiu{color:#22c55e}
.hero .conf{font-size:22px;font-weight:800;color:#facc15;margin-top:4px}
.hero .confBar{height:8px;background:#0f172a;border-radius:4px;margin:10px auto 0;max-width:280px;overflow:hidden}
.hero .confFill{height:100%;background:linear-gradient(90deg,#facc15,#f97316);border-radius:4px}
.hero .row{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;font-size:13px;margin-top:14px;color:#cbd5e1;text-align:left}
.hero .row b{color:#38bdf8}
.hero .note{font-size:12px;color:#94a3b8;margin-top:10px;font-style:italic;line-height:1.5}
.hero .prev{font-size:12px;color:#64748b;margin-top:12px;border-top:1px solid #243354;padding-top:10px}
.card{background:#16213a;border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 4px 12px rgba(0,0,0,.3)}
.card h3{font-size:13px;color:#38bdf8;margin:0 0 10px;text-transform:uppercase;letter-spacing:.5px}
.detail{font-size:12px;color:#cbd5e1;line-height:1.7}
.detail b{color:#38bdf8}
.vote{display:flex;gap:10px;margin-top:8px}
.vote .bar{flex:1;background:#0f172a;border-radius:6px;overflow:hidden;height:28px;position:relative}
.vote .bar .fill{height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;transition:width .4s}
.vote .tai .fill{background:linear-gradient(90deg,#dc2626,#ef4444)}
.vote .xiu .fill{background:linear-gradient(90deg,#16a34a,#22c55e)}
details{background:#16213a;border-radius:12px;padding:0;margin-bottom:12px;box-shadow:0 4px 12px rgba(0,0,0,.3)}
details summary{cursor:pointer;padding:14px;font-size:14px;color:#38bdf8;font-weight:600;list-style:none}
details summary::-webkit-details-marker{display:none}
details summary::before{content:'▸ ';transition:.2s;display:inline-block}
details[open] summary::before{content:'▾ '}
details .body{padding:0 14px 14px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:7px 5px;text-align:center;border-bottom:1px solid #243354}
th{color:#94a3b8;font-weight:600;font-size:11px}
.dung{color:#22c55e;font-weight:700}.sai{color:#ef4444;font-weight:700}
.badge{padding:2px 7px;border-radius:5px;font-weight:700;font-size:11px}
.badge.tai{background:rgba(239,68,68,.22)}
.badge.xiu{background:rgba(34,197,94,.22)}
.summaryBox{display:flex;gap:14px;justify-content:center;font-size:14px;flex-wrap:wrap;margin-bottom:10px}
.summaryBox b{color:#facc15}
.small{font-size:11px;color:#64748b;text-align:center;margin-top:8px;line-height:1.6}
.small a{color:#38bdf8;text-decoration:none}
</style></head>
<body>

<h1>🎲 Dự đoán LC79 — Phiên kế tiếp</h1>

<!-- KHUNG DỰ ĐOÁN CHÍNH -->
<div class="hero">
  <div class="lbl">PHIÊN CẦN DỰ ĐOÁN</div>
  <div class="phien">#${nextId}</div>
  <div class="val ${next.duDoan === 'TAI' ? 'tai' : 'xiu'}">${next.duDoan}</div>
  <div class="conf">Độ tin cậy: ${next.doTinCay}%</div>
  <div class="confBar"><div class="confFill" style="width:${next.doTinCay}%"></div></div>
  <div class="row">
    <div><b>Cầu chính:</b> ${next.loaiCauChinh}</div>
    <div><b>Nên:</b> ${next.nenTheoHayBe}</div>
  </div>
  <div class="note">${next.phanTich}</div>
  <div class="prev">
    Phiên trước #${latest.id} → <b class="${latest.result === 'TAI' ? 'tai' : 'xiu'}">${latest.result}</b>
    (${latest.dices.join('-')} = ${latest.point} điểm)
  </div>
</div>

<!-- VOTE T/X -->
<div class="card">
  <h3>⚖️ Tổng hợp vote các cầu</h3>
  <div class="vote">
    <div class="bar tai"><div class="fill" style="width:${taiPct}%">TAI ${taiPct}%</div></div>
    <div class="bar xiu"><div class="fill" style="width:${xiuPct}%">XIU ${xiuPct}%</div></div>
  </div>
  <div class="detail" style="margin-top:10px">
    ${next.chiTietCau.map(c => `<div>• <b>${c.cau}</b> → ${c.duDoan} (${c.doTinCayGoc}% | w=${c.trongSo}) | BT: ${c.backtest.dung}/${c.backtest.mau} = ${c.backtest.winrate}% — <i>${c.ghiChu}</i></div>`).join('')}
  </div>
</div>

<!-- BẢNG CHECK THU GỌN -->
<details>
  <summary>📊 Kiểm tra đúng/sai 40 phiên gần nhất (${dung} đúng / ${sai} sai = ${tyLe}%)</summary>
  <div class="body">
    <div class="summaryBox">
      <div>Tổng: <b>${tong}</b></div>
      <div>Đúng: <b class="dung">${dung}</b></div>
      <div>Sai: <b class="sai">${sai}</b></div>
      <div>Tỷ lệ: <b>${tyLe}%</b></div>
    </div>
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Phiên</th><th>Dice</th><th>Điểm</th><th>KQ</th><th>Dự đoán</th><th>Tin cậy</th><th>Cầu</th><th>Check</th></tr></thead>
      <tbody>
        ${rows.map(r => `<tr>
          <td>${r.id}</td><td>${r.dice}</td><td>${r.point}</td>
          <td><span class="badge ${r.ketQua === 'TAI' ? 'tai' : 'xiu'}">${r.ketQua}</span></td>
          <td><span class="badge ${r.duDoan === 'TAI' ? 'tai' : 'xiu'}">${r.duDoan}</span></td>
          <td>${r.doTinCay}%</td>
          <td style="font-size:10px;color:#94a3b8">${r.loaiCau}</td>
          <td class="${r.check === 'ĐÚNG' ? 'dung' : 'sai'}">${r.check}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>
  </div>
</details>

<div class="small">
  Tự làm mới 20s • <a href="/dunphi?fresh=1" target="_blank">/dunphi</a> (JSON) • <a href="/dun?fresh=1">Làm mới ngay</a><br>
  API gốc: ${API_URL}
</div>

</body></html>`;
    res.send(html);
  } catch (e) {
    res.status(500).send('<h1>Lỗi: ' + e.message + '</h1>');
  }
});

/* =========================================================
   ROOT — info
   ========================================================= */
app.get('/', (req, res) => {
  res.json({
    api: 'LC79 Predictor v3 (deterministic, no random)',
    apiGoc: API_URL,
    endpoints: {
      '/dunphi': 'JSON dự đoán phiên kế tiếp (thêm ?fresh=1 để force refresh)',
      '/dun': 'HTML: khung dự đoán + bảng check đúng/sai (thêm ?fresh=1)'
    }
  });
});

/* =========================================================
   START SERVER
   ========================================================= */
app.listen(PORT, () => {
  console.log('=========================================');
  console.log(`  LC79 Predictor v3`);
  console.log(`  Port: ${PORT}`);
  console.log(`  API gốc: ${API_URL}`);
  console.log(`  Endpoints: /dunphi (JSON) | /dun (HTML)`);
  console.log('=========================================');
});
