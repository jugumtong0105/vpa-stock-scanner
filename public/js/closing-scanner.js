// 종가베팅(신고가) 조건검색 스캐너
let C = {
  stocks: [],
  stock: null,
  data: [],
  chart: null,
  candle: null,
  vol: null,
  ma5: null,
  ma20: null,
  months: 12
};

function fmtD(d) { return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`; }
function calcMA(data, i, p) { if (i < p - 1) return null; let s = 0; for (let j = i - p + 1; j <= i; j++) s += data[j].close; return s / p; }
function buildMA(data, p) { const r = []; for (let i = 0; i < data.length; i++) { if (i < p - 1) continue; let s = 0; for (let j = i - p + 1; j <= i; j++) s += data[j].close; r.push({ time: fmtD(data[i].date), value: s / p }); } return r; }

async function fetchClosingStockList() {
  try {
    const r = await fetch('/api/stocklist');
    const j = await r.json();
    if (j.success && j.stocks.length > 50) { C.stocks = j.stocks; return; }
  } catch (e) { console.error("Stock list fetch failed", e); }
}

async function fetchInvestorData(code) {
  try {
    const r = await fetch(`/api/new-scanner/investor/${code}`);
    const j = await r.json();
    return j;
  } catch (e) {
    console.error("Investor data fetch failed", e);
    return null;
  }
}

async function analyzeClosingPattern(data, stock) {
  const lastIdx = data.length - 1;
  // 1년치 데이터가 필요하므로 대략 200봉 이상 필요 (신고가 판별 완화)
  if (lastIdx < 200) return null;

  const evalIdx = lastIdx;
  const today = data[evalIdx];
  const yesterday = data[evalIdx - 1];

  // UI 파라미터 가져오기 (없으면 기본값 사용)
  const paramBullishRate = document.getElementById('paramBullishRate') ? parseFloat(document.getElementById('paramBullishRate').value) / 100 : 0.04;
  const paramVolMultiple = document.getElementById('paramVolMultiple') ? parseFloat(document.getElementById('paramVolMultiple').value) : 1.5;
  const paramVolDecline = document.getElementById('paramVolDecline') ? parseFloat(document.getElementById('paramVolDecline').value) / 100 : 0.65;
  const paramBearishMax = document.getElementById('paramBearishMax') ? Math.abs(parseFloat(document.getElementById('paramBearishMax').value)) / 100 : 0.07;
  const paramRecentDays = document.getElementById('paramRecentDays') ? parseInt(document.getElementById('paramRecentDays').value) : 5;

  // 1. 신고가 + 평소 큰 거래량 + 장대양봉 돌파
  let targetCandleIdx = -1;
  let targetCandle = null;
  let maxHigh240 = 0;

  for (let i = evalIdx - paramRecentDays; i <= evalIdx; i++) {
    let localMax = 0;
    const startJ = Math.max(0, i - 240);
    for (let j = startJ; j < i; j++) {
      if (data[j].high > localMax) localMax = data[j].high;
    }
    
    // 장대양봉 판별: 지정된 등락률 이상 상승, 이전 20일 평균 거래량 대비 배수 이상
    const bodyPct = (data[i].close - data[i].open) / data[i].open;
    
    let volSum = 0;
    const volStart = Math.max(0, i - 20);
    for (let j = volStart; j < i; j++) volSum += data[j].volume;
    const avgVol = volSum / Math.max(1, i - volStart);

    const isBullish = bodyPct >= paramBullishRate && data[i].volume >= avgVol * paramVolMultiple;

    if (data[i].high >= localMax && isBullish) {
      targetCandleIdx = i;
      targetCandle = data[i];
      maxHigh240 = localMax;
    }
  }

  // 기준봉이 없거나 오늘이 기준봉이면 눌림목이 아님
  if (targetCandleIdx === -1 || targetCandleIdx === evalIdx) return null;

  const baseSignal = {
    evalDate: fmtD(today.date),
    entryPrice: today.close,
    targetDate: fmtD(targetCandle.date),
    targetPrice: targetCandle.close,
    targetVolume: targetCandle.volume,
    todayVolume: today.volume,
    ma5: 0,
    instNet: 0
  };

  // 2. 상승 음봉 매수 (짧은 음봉, 거래량 마름)
  const isTodayYin = today.close < today.open || (today.close === today.open && today.close < yesterday.close);
  // 거래량이 기준봉 대비 지정된 감소율(예: 65% 감소 -> 35% 이하) 이내인지 확인
  const volDried = today.volume <= targetCandle.volume * (1 - paramVolDecline);
  
  // 3. 5일선 지지
  const ma5 = calcMA(data, evalIdx, 5);
  baseSignal.ma5 = ma5 ? ma5.toFixed(2) : 0;

  if (!isTodayYin || !volDried || !ma5 || today.close < ma5) {
    return { stage: 1, signal: baseSignal };
  }

  // 짧은 음봉 (시가 대비 종가 하락폭 제한)
  const todayBodyPct = Math.abs(today.close - today.open) / today.open;
  if (todayBodyPct > paramBearishMax) {
    return { stage: 1, signal: baseSignal };
  }

  // 4. 수급 (기관 매수세)
  const investorData = await fetchInvestorData(stock.code);
  if (!investorData || !investorData.success) {
    return { stage: 2, signal: baseSignal };
  }

  let instBuy = false;
  let instNet = 0;
  if (investorData.data && investorData.data.length > 0) {
    instNet = investorData.data[0].instNet; // 서버에서 파싱된 기관 순매매량
    baseSignal.instNet = instNet;
    if (instNet > 0) {
      instBuy = true;
    }
  }

  if (!instBuy) {
    return { stage: 2, signal: baseSignal };
  }

  return { stage: 3, signal: baseSignal };
}

// === CHART ===
function initClosingChart() {
  const el = document.getElementById('closingChartContainer'); 
  if (!el) return;
  el.innerHTML = '';
  const c = LightweightCharts.createChart(el, {
    layout: { background: { type: 'solid', color: '#080b12' }, textColor: '#8492a6', fontFamily: "'Inter','Noto Sans KR',sans-serif", fontSize: 11 },
    grid: { vertLines: { color: '#141c28' }, horzLines: { color: '#141c28' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1e293b', scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: '#1e293b', timeVisible: false, rightOffset: 3, barSpacing: 8 },
  });
  C.candle = c.addCandlestickSeries({ upColor: '#ff4757', downColor: '#3b82f6', borderDownColor: '#3b82f6', borderUpColor: '#ff4757', wickDownColor: '#3b82f6', wickUpColor: '#ff4757' });
  C.ma5 = c.addLineSeries({ color: '#f0c040', lineWidth: 2, title: 'MA5', priceLineVisible: false, lastValueVisible: false });
  C.ma20 = c.addLineSeries({ color: '#00d4ff', lineWidth: 2, title: 'MA20', priceLineVisible: false, lastValueVisible: false });
  
  C.vol = c.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
  c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });
  C.chart = c;
  new ResizeObserver(() => c.applyOptions({ width: el.clientWidth, height: el.clientHeight })).observe(el);
}

function showClosingChart(data, signal) {
  if (!C.chart) initClosingChart();
  C.candle.setData(data.map(d => ({ time: fmtD(d.date), open: d.open, high: d.high, low: d.low, close: d.close })));
  C.ma5.setData(buildMA(data, 5)); 
  C.ma20.setData(buildMA(data, 20)); 
  
  C.vol.setData(data.map(d => ({ time: fmtD(d.date), value: d.volume, color: d.close >= d.open ? 'rgba(255,71,87,0.3)' : 'rgba(59,130,246,0.3)' })));
  
  const mk = [];
  if (signal) {
    mk.push({ time: signal.targetDate, position: 'aboveBar', color: '#ff4757', shape: 'arrowDown', text: '🔥신고가 돌파' });
    mk.push({ time: signal.evalDate, position: 'belowBar', color: '#f0932b', shape: 'arrowUp', text: '💎음봉타점' });
  }
  C.candle.setMarkers(mk);
  C.chart.timeScale().fitContent();
}

// === SCAN ===
async function runClosingScan() {
  const btn = document.getElementById('btnClosingScan');
  const btnText = document.getElementById('btnClosingScanText');
  const statusDot = document.querySelector('.closing-status-dot');
  const statusText = document.getElementById('closingStatusText');
  const progWrap = document.getElementById('closingScanProgressWrap');
  const progFill = document.getElementById('closingProgressFill');
  const progText = document.getElementById('closingProgressText');
  const results = document.getElementById('closingMatchResults');
  
  if (!btn || !results) return;

  btn.classList.add('scanning'); btnText.textContent = '스캔 중...';
  if(statusDot) statusDot.className = 'status-dot closing-status-dot scanning'; 
  if(statusText) statusText.textContent = '종목 리스트 로딩 중...';
  if(progWrap) progWrap.style.display = 'flex';
  results.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">⏳ 종가베팅(신고가) 스캔 중...</div>`;
  
  if (C.stocks.length === 0) {
    await fetchClosingStockList();
  }
  const stockList = C.stocks;
  if(statusText) statusText.textContent = `${stockList.length}개 종목 스캔 중...`;
  
  const allMatches = [];
  let scanned = 0;
  const batchSize = 10;
  
  for (let i = 0; i < stockList.length; i += batchSize) {
    const batch = stockList.slice(i, i + batchSize);
    const codes = batch.map(s => s.code).join(',');
    try {
      const r = await fetch(`/api/batch?codes=${codes}&months=${C.months}`);
      const bd = await r.json();
      for (const item of bd) {
        const stock = stockList.find(s => s.code === item.code);
        if (!stock || !item.data || item.data.length < 240) continue; // 1년 데이터 필요
        const res = await analyzeClosingPattern(item.data, stock);
        if (res) {
          allMatches.push({ stock, data: item.data, stage: res.stage, signal: res.signal });
        }
        scanned++;
      }
    } catch (e) { console.error(e); }
    const pct = Math.min(((i + batchSize) / stockList.length) * 100, 100);
    if(progFill) progFill.style.width = pct + '%';
    if(progText) progText.textContent = `${Math.min(i + batchSize, stockList.length)} / ${stockList.length}`;
    if(statusText) statusText.textContent = `스캔 중... (${allMatches.length}건 발견)`;
  }
  
  btn.classList.remove('scanning'); btnText.textContent = '다시 스캔';
  if(statusDot) statusDot.className = 'status-dot closing-status-dot done';
  if(statusText) statusText.textContent = allMatches.length > 0 ? `✅ ${allMatches.length}건 포착!` : '매칭 없음';
  if(progWrap) progWrap.style.display = 'none'; 
  
  if (allMatches.length === 0) {
    results.innerHTML = `<div class="no-match-msg">매칭 종목 없음 😅<div class="tip">💡 시장 상황에 따라 조건에 맞는 종목이 없을 수 있습니다.</div></div>`;
    return;
  }
  
  allMatches.forEach((m, idx) => m.globalIdx = idx);

  const stage3 = allMatches.filter(m => m.stage === 3);
  const stage2 = allMatches.filter(m => m.stage === 2);
  const stage1 = allMatches.filter(m => m.stage === 1);

  let html = `<div class="mode-badge live" style="background:rgba(240, 147, 43, 0.15); color:#f0932b; border: 1px solid rgba(240,147,43,0.3)">🚀 종가베팅 — 단계별 검색결과</div>`;

  function renderGroup(group, title, color, badgeText) {
    if (group.length === 0) return '';
    return `<div style="margin:15px 0 5px 0; font-size:12px; font-weight:700; color:${color}; border-bottom:1px solid #1e293b; padding-bottom:5px;">${title} (${group.length})</div>` + 
    group.map((m) => {
      const s = m.signal;
      return `<div class="match-item closing-match-item" data-idx="${m.globalIdx}" style="border-left: 2px solid ${color};">
        <div class="match-header">
          <span class="match-name">${m.stock.name}</span>
          <span class="match-reliability reliability-high" style="color:${color}; border-color:${color};">${badgeText}</span>
        </div>
        <div class="match-signal-date">기준봉: ${s.targetDate}</div>
        <div class="match-detail">
          현재가 ${s.entryPrice.toLocaleString()}원
        </div>
      </div>`;
    }).join('');
  }

  html += renderGroup(stage3, '전체 조건 만족 (3단계)', '#ff4757', '매수타점');
  html += renderGroup(stage2, '2단계 만족 (눌림목 지지)', '#f0932b', '관심종목');
  html += renderGroup(stage1, '1단계 만족 (신고가 돌파)', '#8492a6', '추적시작');

  results.innerHTML = html;
  
  results.querySelectorAll('.closing-match-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      results.querySelectorAll('.closing-match-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active'); 
      loadClosingMatch(allMatches[idx]);
    });
  });
  if (allMatches.length > 0) {
    results.querySelector('.closing-match-item').classList.add('active');
    loadClosingMatch(allMatches[0]);
  }
}

function loadClosingMatch(match) {
  C.stock = match.stock; 
  C.data = match.data; 
  
  const titleEl = document.getElementById('currentStockName');
  if(titleEl) titleEl.textContent = match.stock.name;
  
  const codeEl = document.getElementById('currentStockCode');
  if(codeEl) codeEl.textContent = match.stock.code;
  
  const priceEl = document.getElementById('currentPrice');
  if(priceEl) priceEl.textContent = match.signal.entryPrice.toLocaleString() + '원';
  
  const chEl = document.getElementById('priceChange');
  if(chEl) {
    chEl.textContent = ''; // 종가베팅이므로 당일 변화율은 생략하거나 별도 처리
    chEl.className = 'price-change';
  }
  
  if (!C.chart) initClosingChart(); 
  else { document.getElementById('closingChartContainer').innerHTML = ''; initClosingChart(); }
  
  showClosingChart(match.data, match.signal);
  renderClosingSignalDetails(match.signal, match.stage);
}

function renderClosingSignalDetails(s, stage) {
  const el = document.getElementById('closingSignalsList');
  if (!el) return;
  
  let stageText = '';
  let color = '';
  if (stage === 3) { stageText = '🔥 3단계 전체 만족 (매수타점)'; color = '#ff4757'; }
  else if (stage === 2) { stageText = '💎 2단계 만족 (눌림목 지지, 기관 수급 대기)'; color = '#f0932b'; }
  else { stageText = '👀 1단계 만족 (신고가 돌파, 눌림 대기)'; color = '#8492a6'; }

  el.innerHTML = `<div class="signal-item" style="border-left: 3px solid ${color}">
    <div class="signal-date" style="font-size:13px;font-weight:700;color:${color}">${stageText}</div>
    <div class="signal-detail" style="font-size:11px;line-height:1.7;margin-top:8px;">
      <b>🚀 1단계 기준봉:</b> ${s.targetDate} (52주 신고가 돌파 장대양봉)<br>
      <b>📉 2단계 눌림목:</b> ${stage >= 2 ? '조건 만족 (거래량 급감 & 5일선 지지)' : '조건 미달 혹은 진행 중'}<br>
      <b>💼 3단계 수급:</b> ${stage >= 3 ? '조건 만족 (기관 매수세 유입)' : (stage === 2 ? `수급 확인 필요 (최근 기관: ${s.instNet.toLocaleString()})` : '대기 중')}<br>
      <br>
      <b style="color:#ff4757">⚠️ 매도 원칙:</b> 5일선 이탈 시 무조건 매도 (손절)<br>
      ──────────<br>
      현재가: <b>${s.entryPrice.toLocaleString()}원</b> (5일선: ${s.ma5})
    </div>
  </div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnClosingScan');
  if(btn) btn.addEventListener('click', runClosingScan);
});
