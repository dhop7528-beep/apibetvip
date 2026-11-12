const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

/* ============ CẤU HÌNH GAME MỚI ============ */
const API_URL = process.env.API_URL || 'https://wtxmd52.macminim6.online/v1/txmd5/sessions';
const CACHE_TTL = 4000;

let cache = { list: [], t: 0 };

/* ============ ADAPTER: chuẩn hoá mọi format ============ */
function normalizeItem(raw) {
  if (!raw) return null;
  const id = Number(raw.id ?? raw.sessionId ?? raw.phien ?? 0);
  // kết quả T/X — chấp nhận nhiều key
  let kq = raw.resultTruyenThong ?? raw.result ?? raw.ketQua ?? raw.outcome ?? '';
  kq = String(kq).toUpperCase().trim();
  if (kq === 'T' || kq === 'TAI' || kq === 'BIG' || kq === '1') kq = 'TAI';
  else if (kq === 'X' || kq === 'XIU' || kq === 'SMALL' || kq === '0') kq = 'XIU';

  // dice — chấp nhận dices / dice / xucXac
  let dices = raw.dices ?? raw.dice ?? raw.xucXac ?? raw.diceValues ?? [];
  if (typeof dices === 'string') {
    dices = dices.split(/[,\-\s]+/).map(Number).filter(n => !isNaN(n));
  }
  if (!Array.isArray(dices)) dices = [];
  dices = dices.map(Number).filter(n => !isNaN(n));

  // point
  let point = Number(raw.point ?? raw.diem ?? raw.total ?? 0);
  if (!point && dices.length) point = dices.reduce((a, b) => a + b, 0);

  // Nếu không có kq nhưng có dice → suy ra T/X (>=11 TAI)
  if (!kq && point) kq = point >= 11 ? 'TAI' : 'XIU';

  if (!id || !kq) return null;
  return { id, result: kq, dices, point };
}

async function fetchHistory() {
  const now = Date.now();
  if (cache.list.length && now - cache.t < CACHE_TTL) return cache.list;
  try {
    const res = await axios.get(API_URL, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    let raw = res.data?.list || (Array.isArray(res.data) ? res.data : []);
    const list = raw.map(normalizeItem).filter(Boolean);
    list.sort((a, b) => b.id - a.id); // mới nhất trước
    if (list.length) cache = { list, t: now };
    return list;
  } catch (e) {
    console.error('fetch err:', e.message);
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

// Lặp khối độ dài k: mỗi khối uniform, khối kề khác loại
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

// Pattern xen kẽ khối p1 / p2
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
   NHẬN DIỆN CẦU — deterministic
   Mỗi cầu trả: {loai, name, doDai, duDoan, baseTin, ghiChu}
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

  // 5) KÉP 4-4 (nếu có)
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
      // phần tử kế tiếp = phần tử cuối khối hiện tại (cùng phase)
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

  // 8) CẦU NGẮN (đảo liên tục 7 phiên)
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

  // 9) CẦU GÃY (bệt 2 vừa gãy sang so le)
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
    const pastR = R.slice(i + 1); // lịch sử TRƯỚC phiên i
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
   DỰ ĐOÁN — vote có trọng số, KHÔNG random
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
    // Trọng số deterministic:
    // base (0..1) × winrate backtest (nếu >=5 mẫu, ngược lại 0.5) × hệ số độ dài
    const wr = b.total >= 5 ? b.winrate / 100 : 0.5;
    const base = Math.min(p.baseTin, 90) / 100;
    const lenBoost = 1 + Math.min(p.doDai, 10) / 25;
    const w = base * wr * lenBoost * 10;

    if (p.duDoan === 'TAI') vTAI += w; else vXIU += w;

    chiTiet.push({
      cau: p.name,
      loai: p.loai,
      duDoan: p.duDoan,
      doTinCayGoc: Math.round(p.baseTin),
      doDai: p.doDai,
      ghiChu: p.ghiChu,
      trongSo: +w.toFixed(2),
      backtest: { mau: b.total, dung: b.dung, sai: b.sai, winrate: b.winrate }
    });
  }

  const duDoan = vTAI >= vXIU ? 'TAI' : 'XIU';
  const tong = vTAI + vXIU || 1;
  const lech = Math.abs(vTAI - vXIU) / tong;

  // Confidence 50..90 (không random, chỉ map từ lech)
  let doTinCay = Math.round(50 + lech * 40);

  // Nếu cầu mạnh nhất NGƯỢC với kết quả vote → trừ nhẹ
  const strong = chiTiet.slice().sort((a, b) => b.trongSo - a.trongSo)[0];
  if (strong && strong.duDoan !== duDoan) doTinCay -= 6;
  doTinCay = Math.max(50, Math.min(90, doTinCay));

  // Cầu chính hiển thị = cầu có trọng số cao nhất CÙNG hướng với duDoan
  const cungHuong = chiTiet.filter(c => c.duDoan === duDoan).sort((a, b) => b.trongSo - a.trongSo);
  const chinh = cungHuong[0] || strong;

  return {
    duDoan,
    doTinCay,
    loaiCauChinh: chinh ? chinh.cau : 'Không rõ',
    phanTich: chinh ? chinh.ghiChu : 'Không có pattern rõ.',
    nenTheoHayBe: strong && strong.duDoan !== duDoan ? 'Cầu mạnh nhất NGƯỢC — cân nhắc BẺ' : 'Theo',
    chiTietCau: chiTiet.sort((a, b) => b.trongSo - a.trongSo),
    vote: { TAI: +vTAI.toFixed(2), XIU: +vXIU.toFixed(2) },
    backtestTheoLoaiCau: bt
  };
}

/* =========================================================
   API
   ========================================================= */
app.get('/dunphi', async (req, res) => {
  try {
    const list = await fetchHistory();
    if (!list.length) return res.status(503).json({ error: 'Không lấy được dữ liệu', apiUrl: API_URL });

    const latest = list[0];
    const nextId = latest.id + 1;
    const p = predict(list);
    const R = list.map(x => x.result);
    const rl = runLength(R);
    const zz = zigzagLength(R);

    res.json({
      apiGoc: API_URL,
      phienTruoc: {
        id: latest.id,
        ketQua: latest.result,
        dice: latest.dices,
        point: latest.point
      },
      phienDuDoan: nextId,
      duDoan: p.duDoan,
      doTinCay: p.doTinCay,
      loaiCauChinh: p.loaiCauChinh,
      phanTich: p.phanTich,
      nenTheoHayBe: p.nenTheoHayBe,
      chiTietCau: p.chiTietCau,
      vote: p.vote,
      thongKe: {
        betHienTai: `${rl.type} x${rl.len}`,
        soLe: `x${zz}`,
        tai10: countN(R, 10).TAI, xiu10: countN(R, 10).XIU,
        tai20: countN(R, 20).TAI, xiu20: countN(R, 20).XIU,
        tai30: countN(R, 30).TAI, xiu30: countN(R, 30).XIU,
        tongPhienCoDuLieu: R.length
      },
      backtestTheoLoaiCau: p.backtestTheoLoaiCau,
      lichSuGanNhat: list.slice(0, 20).map(x => ({
        id: x.id, ketQua: x.result, dice: x.dices, point: x.point
      })),
      thoiGian: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/dun', async (req, res) => {
  try {
    const list = await fetchHistory();
    if (!list.length) return res.status(503).send('<h1>Không có dữ liệu</h1>');

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
    const next = predict(list);
    const latest = list[0];

    const html = `<!DOCTYPE html><html lang="vi"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Dự đoán LC79 v3</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e2e8f0;margin:0;padding:16px}
h1{font-size:20px;text-align:center;color:#38bdf8;margin:4px 0 16px}
.card{background:#16213a;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 4px 12px rgba(0,0,0,.35)}
.pred{text-align:center}.pred .lbl{font-size:13px;color:#94a3b8}
.pred .val{font-size:44px;font-weight:800;margin:6px 0}.tai{color:#ef4444}.xiu{color:#22c55e}
.conf{font-size:19px;font-weight:700;color:#facc15}
.row{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;font-size:13px;margin-top:8px;color:#cbd5e1}
.stat{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;margin-top:8px}
.stat span{background:#243354;padding:4px 9px;border-radius:7px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:7px 5px;text-align:center;border-bottom:1px solid #243354}
th{color:#94a3b8;font-weight:600}.dung{color:#22c55e;font-weight:700}.sai{color:#ef4444;font-weight:700}
.badge{padding:2px 7px;border-radius:5px;font-weight:700;font-size:11px}
.badge.tai{background:rgba(239,68,68,.22)}.badge.xiu{background:rgba(34,197,94,.22)}
.summary{display:flex;gap:14px;justify-content:center;font-size:15px;flex-wrap:wrap}
.summary b{color:#facc15}
.small{font-size:11px;color:#64748b;text-align:center;margin-top:6px}
.detail{font-size:12px;color:#cbd5e1;line-height:1.6}
.detail b{color:#38bdf8}
</style></head><body>
<h1>🎲 Dự đoán LC79 v3 — Phiên ${latest.id + 1}</h1>
<div class="card pred">
  <div class="lbl">Dự đoán phiên tới (${latest.id + 1})</div>
  <div class="val ${next.duDoan === 'TAI' ? 'tai' : 'xiu'}">${next.duDoan}</div>
  <div class="conf">Độ tin cậy: ${next.doTinCay}%</div>
  <div class="row">
    <div><b>Cầu chính:</b> ${next.loaiCauChinh}</div>
    <div><b>Nên:</b> ${next.nenTheoHayBe}</div>
  </div>
  <div class="small">${next.phanTich}</div>
</div>
<div class="card">
  <div class="summary">
    <div>Tổng check: <b>${tong}</b></div>
    <div>Đúng: <b class="dung">${dung}</b></div>
    <div>Sai: <b class="sai">${sai}</b></div>
    <div>Tỷ lệ: <b>${tyLe}%</b></div>
  </div>
</div>
<div class="card">
  <div class="detail">
    ${next.chiTietCau.map(c => `<div>• <b>${c.cau}</b> → ${c.duDoan} (${c.doTinCayGoc}% | w=${c.trongSo}) | BT: ${c.backtest.dung}/${c.backtest.mau} = ${c.backtest.winrate}% — <i>${c.ghiChu}</i></div>`).join('')}
  </div>
</div>
<div class="card" style="overflow-x:auto">
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
</tbody></table></div>
<div class="small">Tự làm mới 15s • /dunphi (JSON) • /dun (HTML)</div>
</body></html>`;
    res.send(html);
  } catch (e) {
    res.status(500).send('<h1>Lỗi: ' + e.message + '</h1>');
  }
});

app.get('/', (req, res) => res.json({
  api: 'LC79 Predictor v3 (deterministic, no random)',
  apiGoc: API_URL,
  endpoints: { '/dunphi': 'JSON chi tiết', '/dun': 'HTML check' }
}));

app.listen(PORT, () => console.log('Server port ' + PORT + ' — API: ' + API_URL));
