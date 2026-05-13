const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
const SIGNALS_FILE = path.join(__dirname, 'data', 'signals.json');

// 시그널 파일 초기화
function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(SIGNALS_FILE)) fs.writeFileSync(SIGNALS_FILE, JSON.stringify({ signals: [] }));
}
function readSignals() { ensureDataDir(); return JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); }
function writeSignals(data) { ensureDataDir(); fs.writeFileSync(SIGNALS_FILE, JSON.stringify(data, null, 2)); }

// 날짜 포맷
function fmtDate(d) { return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }

// 네이버 금융 차트 데이터
app.get('/api/chart/:code', async (req, res) => {
  const { code } = req.params;
  const months = parseInt(req.query.months) || 6;
  const end = new Date(), start = new Date();
  start.setMonth(start.getMonth() - months);
  const url = `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${fmtDate(start)}&endTime=${fmtDate(end)}&timeframe=day`;
  try {
    const r = await fetch(url, { headers: UA });
    const text = await r.text();
    const lines = text.match(/\["(\d{8})"[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/g);
    if (!lines) return res.json({ success: false, data: [] });
    const data = lines.map(line => {
      const m = line.match(/\["(\d{8})"[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
      return m ? { date: m[1], open: +m[2], high: +m[3], low: +m[4], close: +m[5], volume: +m[6] } : null;
    }).filter(Boolean);
    res.json({ success: true, data, source: '네이버금융' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 배치 차트
app.get('/api/batch', async (req, res) => {
  const codes = (req.query.codes || '').split(',').filter(Boolean);
  const months = parseInt(req.query.months) || 6;
  const end = new Date(), start = new Date();
  start.setMonth(start.getMonth() - months);
  const s = fmtDate(start), e = fmtDate(end);
  const results = await Promise.allSettled(codes.map(async code => {
    const url = `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${s}&endTime=${e}&timeframe=day`;
    const r = await fetch(url, { headers: UA });
    const text = await r.text();
    const lines = text.match(/\["(\d{8})"[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/g);
    if (!lines) return { code, data: [] };
    const data = lines.map(line => {
      const m = line.match(/\["(\d{8})"[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
      return m ? { date: m[1], open: +m[2], high: +m[3], low: +m[4], close: +m[5], volume: +m[6] } : null;
    }).filter(Boolean);
    return { code, data };
  }));
  res.json(results.filter(r => r.status === 'fulfilled').map(r => r.value));
});

// KOSPI/KOSDAQ 거래량 상위 종목 스크래핑 (EUC-KR 디코딩!)
app.get('/api/stocklist', async (req, res) => {
  try {
    const all = [];
    for (const sosok of [0, 1]) {
      for (let page = 1; page <= 5; page++) {
        const url = `https://finance.naver.com/sise/sise_quant.naver?sosok=${sosok}&page=${page}`;
        const r = await fetch(url, { headers: { ...UA, 'Accept-Language': 'ko' } });
        const buf = await r.arrayBuffer();
        const html = new TextDecoder('euc-kr').decode(buf);
        const regex = /href="\/item\/main\.naver\?code=(\d{6})"[^>]*>([^<]+)<\/a>/g;
        let m;
        while ((m = regex.exec(html)) !== null) {
          const code = m[1], name = m[2].trim();
          if (name && !all.find(s => s.code === code)) {
            all.push({ code, name, market: sosok === 0 ? 'KOSPI' : 'KOSDAQ' });
          }
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
    console.log(`✅ 종목 ${all.length}개 로딩 완료`);
    res.json({ success: true, count: all.length, stocks: all });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ===== 성과 추적 API =====

// 시그널 저장
app.post('/api/signals/save', (req, res) => {
  try {
    const { signals } = req.body;
    if (!signals || !signals.length) return res.json({ success: false, msg: 'No signals' });
    const db = readSignals();
    const today = new Date().toISOString().split('T')[0];
    // 오늘 이미 저장된 종목은 중복 방지
    const todayCodes = db.signals.filter(s => s.savedAt === today).map(s => s.code);
    let added = 0;
    for (const sig of signals) {
      if (todayCodes.includes(sig.code)) continue;
      db.signals.push({ ...sig, savedAt: today, id: Date.now() + '_' + Math.random().toString(36).slice(2,8) });
      added++;
    }
    writeSignals(db);
    console.log(`💾 ${added}건 시그널 저장 (총 ${db.signals.length}건)`);
    res.json({ success: true, added, total: db.signals.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 히스토리 조회
app.get('/api/signals/history', (req, res) => {
  try {
    const db = readSignals();
    res.json({ success: true, signals: db.signals });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 현재가 일괄 조회 (성과 계산용)
app.post('/api/signals/prices', async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !codes.length) return res.json({ success: true, prices: {} });
    const prices = {};
    // 배치로 현재가 가져오기
    for (let i = 0; i < codes.length; i += 10) {
      const batch = codes.slice(i, i + 10);
      await Promise.allSettled(batch.map(async code => {
        const url = `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${fmtDate(new Date())}&endTime=${fmtDate(new Date())}&timeframe=day`;
        const r = await fetch(url, { headers: UA });
        const text = await r.text();
        const m = text.match(/\["(\d{8})"[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
        if (m) prices[code] = { date: m[1], close: +m[5], high: +m[3], low: +m[4] };
      }));
      await new Promise(r => setTimeout(r, 100));
    }
    res.json({ success: true, prices });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 시그널 삭제
app.delete('/api/signals/:id', (req, res) => {
  try {
    const db = readSignals();
    db.signals = db.signals.filter(s => s.id !== req.params.id);
    writeSignals(db);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ===== 신규 조건검색 (Market Cap) =====
app.get('/api/new-scanner/stocklist', async (req, res) => {
  try {
    const all = [];
    for (const sosok of [0, 1]) { // 0: KOSPI, 1: KOSDAQ
      for (let page = 1; page <= 30; page++) { // 시총 500억 이하를 포함하기 위해 30페이지 정도 탐색 (약 1500종목)
        const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`;
        const r = await fetch(url, { headers: { ...UA, 'Accept-Language': 'ko' } });
        const buf = await r.arrayBuffer();
        const html = new TextDecoder('euc-kr').decode(buf);
        
        const rows = html.split('onMouseOver="mouseOver(this)"');
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const codeMatch = row.match(/code=(\d{6})/);
          const nameMatch = row.match(/class="tltle">([^<]+)<\/a>/);
          const tds = [...row.matchAll(/<td class="number">([\d,\.\-N/A\s]+)<\/td>/g)].map(m => m[1].trim());
          if (codeMatch && nameMatch && tds.length >= 4) {
            const mcapStr = tds[2].replace(/,/g, '');
            const mcap = parseInt(mcapStr, 10);
            if (!isNaN(mcap)) {
              all.push({ code: codeMatch[1], name: nameMatch[1], mcap: mcap, market: sosok === 0 ? 'KOSPI' : 'KOSDAQ' });
            }
          }
        }
        await new Promise(r => setTimeout(r, 50));
      }
    }
    console.log(`✅ 신규조건검색 종목 ${all.length}개 로딩 완료 (시가총액 포함)`);
    res.json({ success: true, count: all.length, stocks: all });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ===== 신규 조건검색: 기관 수급 데이터 조회 =====
app.get('/api/new-scanner/investor/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const url = `https://finance.naver.com/item/frgn.naver?code=${code}`;
    const r = await fetch(url, { headers: { ...UA, 'Accept-Language': 'ko' } });
    const buf = await r.arrayBuffer();
    const html = new TextDecoder('euc-kr').decode(buf);
    
    // 기관순매매 데이터 추출 (대략적인 정규식 사용)
    const regex = /<td class="num">.*?(<span class="tah p11[^>]*>([\+\-,\d]+)<\/span>|<\/td>)/g;
    const matches = [...html.matchAll(regex)];
    // 매치되는 항목 중 기관 매매동향은 일별 데이터 행의 특정 열에 존재
    // 간단한 파싱을 위해 텍스트 기반 추출
    const trRegex = /<tr[^>]*onmouseover="mouseOver[^>]*>([\s\S]*?)<\/tr>/g;
    const trMatches = [...html.matchAll(trRegex)];
    
    const investorData = [];
    for (let i = 0; i < Math.min(5, trMatches.length); i++) {
      const tdRegex = /<td[^>]*>(?:<span[^>]*>)?(.*?)(?:<\/span>)?<\/td>/g;
      const tds = [...trMatches[i][1].matchAll(tdRegex)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
      if (tds.length >= 7) {
        // 외국인: tds[5], 기관: tds[6] (표 구조에 따라 변동 가능, 통상적으로 기관순매매는 6번째 위치)
        const instNet = parseInt(tds[6].replace(/,/g, ''), 10);
        const foreignNet = parseInt(tds[5].replace(/,/g, ''), 10);
        investorData.push({ 
          date: tds[0], 
          close: parseInt(tds[1].replace(/,/g, ''), 10),
          instNet: isNaN(instNet) ? 0 : instNet,
          foreignNet: isNaN(foreignNet) ? 0 : foreignNet
        });
      }
    }
    
    res.json({ success: true, data: investorData });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.listen(PORT, () => {
  ensureDataDir();
  console.log(`\n🚀 VPA 매수급소 스캐너 v5 (성과추적 탑재)`);
  console.log(`📊 http://localhost:${PORT}\n`);
});
