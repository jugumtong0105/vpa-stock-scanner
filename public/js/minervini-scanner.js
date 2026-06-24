// 마크 미너비니 추세 눌림목 스캐너 (Minervini Trend Pullback Scanner)
let M = {
  stocks: [],
  stock: null,
  data: [],
  chart: null,
  candle: null,
  vol: null,
  ema20: null,
  ema50: null,
  ema150: null,
  ema200: null,
  months: 12 // 200일선을 봐야 하므로 데이터는 1년치가 필요
};

function fmtD(d) { return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`; }

// EMA(지수 이동평균) 계산 - 전체 데이터를 돌면서 EMA 배열 생성
function buildEMA(data, p) {
  const r = [];
  const multiplier = 2 / (p + 1);
  let prevEMA = null;

  for (let i = 0; i < data.length; i++) {
    if (i < p - 1) {
      continue;
    } else if (i === p - 1) {
      // 첫 EMA는 SMA로 초기화
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += data[j].close;
      prevEMA = sum / p;
      r.push({ time: fmtD(data[i].date), value: prevEMA, idx: i });
    } else {
      const ema = (data[i].close - prevEMA) * multiplier + prevEMA;
      r.push({ time: fmtD(data[i].date), value: ema, idx: i });
      prevEMA = ema;
    }
  }
  return r;
}

// 특정 인덱스의 EMA 값을 찾는 헬퍼 함수
function getEmaValue(emaArr, idx) {
  const item = emaArr.find(e => e.idx === idx);
  return item ? item.value : null;
}

async function fetchMinerviniStockList() {
  try {
    const r = await fetch('/api/stocklist');
    const j = await r.json();
    if (j.success && j.stocks.length > 50) { M.stocks = j.stocks; return; }
  } catch (e) { console.error("Stock list fetch failed", e); }
}

async function analyzeMinerviniPattern(data, stock) {
  const lastIdx = data.length - 1;
  if (lastIdx < 220) return null; // 200일선 + 추세 확인을 위해 넉넉히 220일 이상 데이터 필요

  const evalIdx = lastIdx;
  const today = data[evalIdx];
  const yesterday = data[evalIdx - 1];

  // 1. 모든 EMA 계산
  const ema20Arr = buildEMA(data, 20);
  const ema50Arr = buildEMA(data, 50);
  const ema150Arr = buildEMA(data, 150);
  const ema200Arr = buildEMA(data, 200);

  const e20 = getEmaValue(ema20Arr, evalIdx);
  const e50 = getEmaValue(ema50Arr, evalIdx);
  const e150 = getEmaValue(ema150Arr, evalIdx);
  const e200 = getEmaValue(ema200Arr, evalIdx);

  // 10일 전 이평선 값 (기울기 우상향 확인용)
  const e150_past = getEmaValue(ema150Arr, evalIdx - 10);
  const e200_past = getEmaValue(ema200Arr, evalIdx - 10);

  if (!e20 || !e50 || !e150 || !e200 || !e150_past || !e200_past) return null;

  // 2. 장기 추세 (Long-term Trend) 확인
  // 150일 지수이평이 200일 지수이평 위에 있어야 함 (정배열)
  if (e150 <= e200) return null;
  // 두 이평선 모두 우상향 (기울기 > 0)
  if (e150 <= e150_past || e200 <= e200_past) return null;
  // 주가 자체가 150일선 위에 있어야 함 (확실한 상승 추세)
  if (today.close < e150) return null;

  // 3. 단기 눌림목 지지 (Pullback)
  // 최근 3일 동안 주가의 저점이 20일선 혹은 50일선 근처(오차범위 2.5% 이내)로 내려왔었는지 확인
  let hitMA20 = false;
  let hitMA50 = false;
  
  for (let i = evalIdx - 3; i <= evalIdx; i++) {
    const pastE20 = getEmaValue(ema20Arr, i);
    const pastE50 = getEmaValue(ema50Arr, i);
    const pastCandle = data[i];
    
    // 저점이 20일선 근처로 왔을 때 (20일선의 1.025배 이하로 내려오고, 너무 크게 깨지 않았을 때)
    if (pastCandle.low <= pastE20 * 1.025 && pastCandle.low >= pastE20 * 0.95) hitMA20 = true;
    if (pastCandle.low <= pastE50 * 1.025 && pastCandle.low >= pastE50 * 0.95) hitMA50 = true;
  }

  // 둘 다 해당 안되면 눌림목이 아니라고 판단
  if (!hitMA20 && !hitMA50) return null;

  // 4. 반등 컨펌 (Rebound Confirmation) - 영상 핵심: 예측 매수 금지, 반등 확인 후 매수
  // 오늘 캔들이 뚜렷한 양봉이어야 함 (종가 > 시가, 변동폭 1.5% 이상)
  const isBullishToday = today.close > today.open && ((today.close - today.open) / today.open >= 0.015);
  
  // 어제 캔들이 음봉이었다면, 어제 시가를 먹어치우거나(양음양) 어제 종가보다 확실히 높게 끝나야 함
  let engulfsYesterday = false;
  if (yesterday.close <= yesterday.open) {
      if (today.close > yesterday.open) engulfsYesterday = true; // 음봉 시가 돌파 (강한 반등)
      else if (today.close > yesterday.close * 1.02) engulfsYesterday = true; // 음봉 안에서 반등하지만 상승폭이 큼
  } else {
      // 어제도 양봉이었다면, 오늘이 어제 고가를 뚫어야 함
      if (today.close > yesterday.high) engulfsYesterday = true;
  }

  if (!isBullishToday || !engulfsYesterday) return null;

  // 5. 시그널 정보 포맷팅
  const targetMA = hitMA20 ? 'EMA20' : 'EMA50';

  const signal = {
    evalDate: fmtD(today.date),
    entryPrice: today.close,
    ema20: e20.toFixed(2),
    ema50: e50.toFixed(2),
    ema150: e150.toFixed(2),
    ema200: e200.toFixed(2),
    supportLine: targetMA
  };

  return { stage: 2, signal: signal }; 
}

// === CHART ===
function initMinerviniChart() {
  const el = document.getElementById('minerviniChartContainer'); 
  if (!el) return;
  el.innerHTML = '';
  const c = LightweightCharts.createChart(el, {
    layout: { background: { type: 'solid', color: '#0f172a' }, textColor: '#8492a6', fontFamily: "'Inter','Noto Sans KR',sans-serif", fontSize: 11 },
    grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1e293b', scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: '#1e293b', timeVisible: false, rightOffset: 3, barSpacing: 8 },
  });
  
  M.candle = c.addCandlestickSeries({ upColor: '#ff4757', downColor: '#3b82f6', borderDownColor: '#3b82f6', borderUpColor: '#ff4757', wickDownColor: '#3b82f6', wickUpColor: '#ff4757' });
  
  // 미너비니 영상에 나온 이평선 세팅 (EMA 20, 50, 150(회색), 200(보라색))
  M.ema20 = c.addLineSeries({ color: '#f0c040', lineWidth: 2, title: 'EMA20', priceLineVisible: false, lastValueVisible: false });
  M.ema50 = c.addLineSeries({ color: '#00d4ff', lineWidth: 2, title: 'EMA50', priceLineVisible: false, lastValueVisible: false });
  M.ema150 = c.addLineSeries({ color: '#9ca3af', lineWidth: 2, title: 'EMA150', priceLineVisible: false, lastValueVisible: false }); // 회색
  M.ema200 = c.addLineSeries({ color: '#e056fd', lineWidth: 2, title: 'EMA200', priceLineVisible: false, lastValueVisible: false }); // 보라색
  
  M.vol = c.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
  c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });

  M.chart = c;
  new ResizeObserver(() => c.applyOptions({ width: el.clientWidth, height: el.clientHeight })).observe(el);
}

function showMinerviniChart(data, signal) {
  if (!M.chart) initMinerviniChart();
  
  M.candle.setData(data.map(d => ({ time: fmtD(d.date), open: d.open, high: d.high, low: d.low, close: d.close })));
  
  // 차트에 그릴 때는 시간 포맷 맞춰서 반환된 배열 통째로 전달
  M.ema20.setData(buildEMA(data, 20).map(e => ({ time: e.time, value: e.value }))); 
  M.ema50.setData(buildEMA(data, 50).map(e => ({ time: e.time, value: e.value }))); 
  M.ema150.setData(buildEMA(data, 150).map(e => ({ time: e.time, value: e.value }))); 
  M.ema200.setData(buildEMA(data, 200).map(e => ({ time: e.time, value: e.value }))); 
  
  M.vol.setData(data.map(d => ({ time: fmtD(d.date), value: d.volume, color: d.close >= d.open ? 'rgba(255,71,87,0.3)' : 'rgba(59,130,246,0.3)' })));
  
  const mk = [];
  if (signal) {
    mk.push({ time: signal.evalDate, position: 'belowBar', color: '#10b981', shape: 'arrowUp', text: '반등 컨펌' });
  }
  M.candle.setMarkers(mk);
  M.chart.timeScale().fitContent();
}

// === SCAN ===
async function runMinerviniScan() {
  const btn = document.getElementById('btnMinerviniScan');
  const btnText = document.getElementById('btnMinerviniScanText');
  const statusDot = document.querySelector('.minervini-status-dot');
  const statusText = document.getElementById('minerviniStatusText');
  const progWrap = document.getElementById('minerviniScanProgressWrap');
  const progFill = document.getElementById('minerviniProgressFill');
  const progText = document.getElementById('minerviniProgressText');
  const results = document.getElementById('minerviniMatchResults');
  
  if (!btn || !results) return;

  btn.classList.add('scanning'); btnText.textContent = '스캔 중...';
  if(statusDot) statusDot.className = 'status-dot minervini-status-dot scanning'; 
  if(statusText) statusText.textContent = '종목 리스트 로딩 중...';
  if(progWrap) progWrap.style.display = 'flex';
  results.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">⏳ 마크 미너비니 스윙 셋업 스캔 중...</div>`;
  
  if (M.stocks.length === 0) {
    await fetchMinerviniStockList();
  }
  const stockList = M.stocks;
  if(statusText) statusText.textContent = `${stockList.length}개 종목 스캔 중...`;
  
  const allMatches = [];
  const batchSize = 10;
  
  for (let i = 0; i < stockList.length; i += batchSize) {
    const batch = stockList.slice(i, i + batchSize);
    const codes = batch.map(s => s.code).join(',');
    try {
      const res = await fetch(`/api/batch?codes=${codes}&months=${M.months}`);
      const bd = await res.json();
      for (const item of bd) {
        const stock = stockList.find(s => s.code === item.code);
        if (!stock || !item.data || item.data.length < 220) continue;
        const analysis = await analyzeMinerviniPattern(item.data, stock);
        if (analysis) {
          allMatches.push({ stock, data: item.data, signal: analysis.signal });
        }
      }
    } catch (e) { console.error(e); }
    const pct = Math.min(((i + batchSize) / stockList.length) * 100, 100);
    if(progFill) progFill.style.width = pct + '%';
    if(progText) progText.textContent = `${Math.min(i + batchSize, stockList.length)} / ${stockList.length}`;
    if(statusText) statusText.textContent = `스캔 중... (${allMatches.length}건 발견)`;
  }
  
  btn.classList.remove('scanning'); btnText.textContent = '다시 스캔';
  if(statusDot) statusDot.className = 'status-dot minervini-status-dot done';
  if(statusText) statusText.textContent = allMatches.length > 0 ? `✅ ${allMatches.length}건 포착!` : '매칭 없음';
  if(progWrap) progWrap.style.display = 'none'; 
  
  if (allMatches.length === 0) {
    results.innerHTML = `<div class="no-match-msg">매칭 종목 없음 😅<div class="tip">💡 현재 장기 상승 추세에서 완벽한 눌림 반등을 보여주는 종목이 없습니다.</div></div>`;
    return;
  }
  
  allMatches.forEach((m, idx) => m.globalIdx = idx);

  let html = `<div class="mode-badge live" style="background:rgba(236, 72, 153, 0.15); color:#ec4899; border: 1px solid rgba(236,72,153,0.3)">📈 미너비니 스윙 — 검색결과</div>`;
  html += `<div style="margin:15px 0 5px 0; font-size:12px; font-weight:700; color:#ec4899; border-bottom:1px solid #1e293b; padding-bottom:5px;">눌림목 반등 확정 (${allMatches.length})</div>` + 
    allMatches.map((m) => {
      const s = m.signal;
      return `<div class="match-item minervini-match-item" data-idx="${m.globalIdx}" style="border-left: 2px solid #ec4899;">
        <div class="match-header">
          <span class="match-name">${m.stock.name}</span>
          <span class="match-reliability reliability-high" style="color:#ec4899; border-color:#ec4899;">${s.supportLine} 지지</span>
        </div>
        <div class="match-signal-date">반등 컨펌 양봉 발생</div>
        <div class="match-detail">
          현재가 ${s.entryPrice.toLocaleString()}원
        </div>
      </div>`;
    }).join('');

  results.innerHTML = html;
  
  results.querySelectorAll('.minervini-match-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      results.querySelectorAll('.minervini-match-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active'); 
      loadMinerviniMatch(allMatches[idx]);
    });
  });
  if (allMatches.length > 0) {
    results.querySelector('.minervini-match-item').classList.add('active');
    loadMinerviniMatch(allMatches[0]);
  }
}

function loadMinerviniMatch(match) {
  M.stock = match.stock; 
  M.data = match.data; 
  
  const titleEl = document.getElementById('currentStockName');
  if(titleEl) titleEl.textContent = match.stock.name;
  
  const codeEl = document.getElementById('currentStockCode');
  if(codeEl) codeEl.textContent = match.stock.code;
  
  const priceEl = document.getElementById('currentPrice');
  if(priceEl) priceEl.textContent = match.signal.entryPrice.toLocaleString() + '원';
  
  const chEl = document.getElementById('priceChange');
  if(chEl) {
    chEl.textContent = ''; 
    chEl.className = 'price-change';
  }
  
  if (!M.chart) initMinerviniChart(); 
  else { document.getElementById('minerviniChartContainer').innerHTML = ''; initMinerviniChart(); }
  
  showMinerviniChart(match.data, match.signal);
  renderMinerviniSignalDetails(match.signal);
}

function renderMinerviniSignalDetails(s) {
  const el = document.getElementById('minerviniSignalsList');
  if (!el) return;

  el.innerHTML = `<div class="signal-item" style="border-left: 3px solid #ec4899">
    <div class="signal-date" style="font-size:13px;font-weight:700;color:#ec4899">📈 마크 미너비니 추세 눌림목 포착</div>
    <div class="signal-detail" style="font-size:11px;line-height:1.7;margin-top:8px;">
      <b>🔥 1. 장기 상승 추세:</b> 150일/200일 지수이평 정배열 및 우상향 중<br>
      <b>🌊 2. 단기 눌림목:</b> 주가가 단기 조정으로 <b>${s.supportLine}</b> 부근까지 하락 후 지지 확보<br>
      <b>📈 3. 반등 컨펌:</b> 이평선을 딛고 전일 캔들을 압도하는 뚜렷한 양봉이 확인되어 타점으로 승인<br>
      <br>
      ──────────<br>
      현재가: <b>${s.entryPrice.toLocaleString()}원</b><br>
      EMA20: ${s.ema20} | EMA50: ${s.ema50}<br>
      EMA150: ${s.ema150} | EMA200: ${s.ema200}
    </div>
  </div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnMinerviniScan');
  if(btn) btn.addEventListener('click', runMinerviniScan);
});
