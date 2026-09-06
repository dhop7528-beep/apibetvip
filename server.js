const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API Lịch sử gốc mới
const EXTERNAL_API_URL = 'https://wtxmd52.macminim6.online/v1/txmd5/sessions';

/**
 * Thuật toán phân tích lịch sử và đưa ra dự đoán SMART
 * @param {Array} historyList - Danh sách lịch sử phiên
 * @returns {Object} Kết quả phân tích và dự đoán
 */
function analyzeAndPredict(historyList) {
    if (!historyList || historyList.length === 0) {
        return {
            phienHienTai: 0,
            phienDuDoan: 1,
            ketQuaGanNhat: "N/A",
            dicesGanNhat: [],
            diemGanNhat: 0,
            chuoiHienTai: "N/A",
            duDoan: "TAI",
            tyLeWin: "50%",
            phuongPhap: "Mặc định (Không có dữ liệu)"
        };
    }

    // Sắp xếp lịch sử theo ID tăng dần để phân tích đúng thứ tự thời gian
    const sortedList = [...historyList].sort((a, b) => a.id - b.id);
    const totalSessions = sortedList.length;
    const latestSession = sortedList[totalSessions - 1];

    // Lấy chuỗi kết quả (T hoặc X)
    const results = sortedList.map(item => item.resultTruyenThong === 'TAI' ? 'T' : 'X');

    // 1. Phân tích chuỗi lặp hiện tại (Streak) từ phiên gần nhất trở về trước
    let currentStreakType = results[results.length - 1];
    let currentStreakCount = 0;
    for (let i = results.length - 1; i >= 0; i--) {
        if (results[i] === currentStreakType) {
            currentStreakCount++;
        } else {
            break;
        }
    }

    // 2. Phân tích xu hướng 10 phiên gần nhất
    const last10 = results.slice(-10);
    const countT10 = last10.filter(r => r === 'T').length;
    const countX10 = last10.filter(r => r === 'X').length;

    let prediction = "";
    let method = "SMART Hybrid";
    let baseConfidence = 60;

    // === QUY LUẬT 1: ĐẢO CHIỀU KHỦNG (Tín hiệu mạnh nhất) ===
    if (currentStreakCount >= 4) {
        prediction = currentStreakType === 'T' ? 'XIU' : 'TAI';
        method = "Thuật toán Bệt Cầu (Đảo chiều chuỗi dài ≥4)";
        baseConfidence = 80;
    } 
    else if (currentStreakCount === 3) {
        prediction = currentStreakType === 'T' ? 'XIU' : 'TAI';
        method = "Thuật toán Đảo chiều (Cầu 3)";
        baseConfidence = 72;
    }
    // === QUY LUẬT 2: CHU KỲ NHỊP 1-1 (TX / XT) ===
    else if (totalSessions >= 3 && results[results.length - 1] !== results[results.length - 2] && results[results.length - 2] !== results[results.length - 3]) {
        // Đang đi cầu 1-1 (Ví dụ: T-X-T -> dự đoán X)
        prediction = currentStreakType === 'T' ? 'XIU' : 'TAI';
        method = "Thuật toán Chu kỳ (Cầu Nhịp 1-1)";
        baseConfidence = 65;
    }
    // === QUY LUẬT 3: DỰ ĐOÁN THEO XU HƯỚNG 10 PHIÊN GẦN NHẤT ===
    else {
        if (countT10 > countX10) {
            prediction = 'TAI';
            method = "Thuật toán Xu hướng (Đa số 10 phiên)";
            baseConfidence = 58;
        } else if (countX10 > countT10) {
            prediction = 'XIU';
            method = "Thuật toán Xu hướng (Đa số 10 phiên)";
            baseConfidence = 58;
        } else {
            // Cân bằng 5-5
            prediction = currentStreakType === 'T' ? 'XIU' : 'TAI';
            method = "Thuật toán Cân Bằng (Bắt cầu đảo)";
            baseConfidence = 55;
        }
    }

    // Tạo tỷ lệ ngẫu nhiên dao động từ 50% - 90%
    const randomOffset = Math.floor(Math.random() * 15) - 5; // -5% đến +10%
    let winRate = Math.min(90, Math.max(50, baseConfidence + randomOffset));

    return {
        phienHienTai: latestSession.id,
        phienDuDoan: latestSession.id + 1,
        ketQuaGanNhat: latestSession.resultTruyenThong,
        dicesGanNhat: latestSession.dices,
        diemGanNhat: latestSession.point,
        chuoiHienTai: `${currentStreakType === 'T' ? 'TÀI' : 'XỈU'} x${currentStreakCount}`,
        duDoan: prediction,
        tyLeWin: `${winRate}%`,
        phuongPhap: method
    };
}

// Endpoint chính: Dự đoán phiên tiếp theo
app.get('/api/du-doan', async (req, res) => {
    try {
        const response = await axios.get(EXTERNAL_API_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json'
            },
            timeout: 5000
        });

        const data = response.data;

        if (!data || !data.list || !Array.isArray(data.list)) {
            return res.status(500).json({
                status: "error",
                message: "Không lấy được dữ liệu từ API lịch sử gốc"
            });
        }

        const analysis = analyzeAndPredict(data.list);

        // Trả về duy nhất dữ liệu dự đoán dưới dạng JSON thô
        return res.json({
            status: "success",
            data: {
                phien_hien_tai: analysis.phienHienTai,
                phien_du_doan: analysis.phienDuDoan,
                ket_qua_gan_nhat: analysis.ketQuaGanNhat,
                dices: analysis.dicesGanNhat,
                diem: analysis.diemGanNhat,
                chuoi_hien_tai: analysis.chuoiHienTai,
                du_doan: analysis.duDoan,
                ty_le_thang: analysis.tyLeWin,
                thuat_toan: analysis.phuongPhap,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error("Lỗi khi kết nối API gốc:", error.message);
        return res.status(500).json({
            status: "error",
            message: "Không thể kết nối đến máy chủ lịch sử",
            error: error.message
        });
    }
});

// Endpoint phụ: Xem lịch sử dữ liệu thô từ API gốc
app.get('/api/lich-su', async (req, res) => {
    try {
        const response = await axios.get(EXTERNAL_API_URL);
        return res.json(response.data);
    } catch (error) {
        return res.status(500).json({ error: "Lỗi kết nối API lịch sử" });
    }
});

// Trang chủ hiển thị thông tin API
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: Arial; padding: 20px; line-height: 1.6;">
            <h2>🤖 API DỰ ĐOÁN TÀI XỈU MD5 - SMART ENGINE</h2>
            <p>Trạng thái: <b style="color: green;">ĐANG HOẠT ĐỘNG</b></p>
            <p>API Lịch sử gốc: <code>${EXTERNAL_API_URL}</code></p>
            <ul>
                <li><b>Endpoint dự đoán:</b> <a href="/api/du-doan" target="_blank">/api/du-doan</a></li>
                <li><b>Endpoint lịch sử gốc:</b> <a href="/api/lich-su" target="_blank">/api/lich-su</a></li>
            </ul>
        </div>
    `);
});

app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Server dự đoán đang chạy tại port: ${PORT}`);
    console.log(`API Endpoint: http://localhost:${PORT}/api/du-doan`);
    console.log(`=================================`);
});
