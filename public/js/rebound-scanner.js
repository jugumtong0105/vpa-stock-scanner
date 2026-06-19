// 60일선 N자 반등 스캐너 (60MA Rebound Scanner)
let R = {
  stocks: [],
  stock: null,
  data: [],
  chart: null,
  candle: null,
  vol: null,
  ma10: null,
  ma20: null,
  ma60: null,
  macdSeries: null,
  months: 6
};

function fmtD(d) { return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`; }

function calcSMA(data, i, p) { 
  if (i < p - 1) return null; 
  let s = 0; 
  for (let j = i - p + 1; j <= i; j++) s += data[j].close; 
  return s / p; 
}

function buildSMA(data, p) { 
  const r = []; 
  for (let i = 0; i < data.length; i++) { 
    if (i < p - 1) continue; 
    let s = 0; 
    for (let j = i - p + 1; j <= i; j++) s += data[j].close; 
    r.push({ time: fmtD(data[i].date), value: s / p }); 
  } 
  return r; 
}

// EMA(지수 이동평균) 계산
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
      r.push({ time: fmtD(data[i].date), value: prevEMA });
    } else {
      const ema = (data[i].close - prevEMA) * multiplier + prevEMA;
      r.push({ time: fmtD(data[i].date), value: ema });
      prevEMA = ema;
    }
  }
  return r;
}

// MACD (12, 26) 계산
function buildMACD(data) {
  const ema12 = buildEMA(data, 12);
  const ema26 = buildEMA(data, 26);
  const macd = [];
  
  // ema12와 ema26의 날짜를 매칭 (보통 ema26이 더 늦게 시작됨)
  const ema12Map = new Map();
  ema12.forEach(item => ema12Map.set(item.time, item.value));

  for (const item of ema26) {
    if (ema12Map.has(item.time)) {
      const val12 = ema12Map.get(item.time);
      macd.push({ time: item.time, value: val12 - item.value });
    }
  }
  return macd;
}

function getMACDAt(macdData, time) {
  const found = macdData.find(m => m.time === time);
  return found ? found.value : null;
}

async function fetchReboundStockList() {
  try {
    const r = await fetch('/api/stocklist');
    const j = await r.json();
    if (j.success && j.stocks.length > 50) { R.stocks = j.stocks; return; }
  } catch (e) { console.error("Stock list fetch failed", e); }
}

async function analyzeReboundPattern(data, stock) {
  const lastIdx = data.length - 1;
  if (lastIdx < 65) return null; // 60일선 기울기를 보려면 60일 이상 데이터 필요

  const evalIdx = lastIdx;
  const today = data[evalIdx];
  const evalDate = fmtD(today.date);

  // 1. MACD > 0 체크
  const macdData = buildMACD(data);
  const currentMACD = getMACDAt(macdData, evalDate);
  if (currentMACD === null || currentMACD <= 0) return null;

  // 2. 60일선 종이격(기울기) 상승 조건
  // 60일 전의 종가보다 현재의 종가가 커야 함. (우상향 60일선)
  const pastCandle = data[evalIdx - 60];
  if (today.close <= pastCandle.close) return null;

  // 3. 10/20일선의 60일선 N자 반등 (눌림목 후 돌파)
  // 조건: 최근 15거래일 이내에 10일선이나 20일선이 60일선 아래로 데드크로스 했고,
  // 현재 다시 60일선 위로 돌파(골든크로스) 하였거나 뚫기 직전이어야 함.
  
  let dipFound = false;
  let crossUpFound = false;

  for (let i = evalIdx - 15; i <= evalIdx; i++) {
    const m10 = calcSMA(data, i, 10);
    const m20 = calcSMA(data, i, 20);
    const m60 = calcSMA(data, i, 60);

    if (!m10 || !m20 || !m60) continue;

    // 60일선 아래로 내려간 적이 있는지 확인 (눌림)
    if (m10 < m60 || m20 < m60) {
      dipFound = true;
    }

    // 최근(오늘 혹은 어제) 다시 60일선 위로 올라왔는지 확인 (돌파)
    if (i >= evalIdx - 1 && (m10 >= m60 || m20 >= m60)) {
      crossUpFound = true;
    }
  }

  // 내려갔다가 다시 올라오는 패턴이 아니면 제외
  if (!dipFound || !crossUpFound) return null;

  const m10 = calcSMA(data, evalIdx, 10);
  const m20 = calcSMA(data, evalIdx, 20);
  const m60 = calcSMA(data, evalIdx, 60);

  const signal = {
    evalDate: evalDate,
    entryPrice: today.close,
    macd: currentMACD.toFixed(2),
    ma10: m10.toFixed(2),
    ma20: m20.toFixed(2),
    ma60: m60.toFixed(2),
    past60Close: pastCandle.close
  };

  return { stage: 2, signal: signal }; 
}

// === CHART ===
function initReboundChart() {
  const el = document.getElementById('reboundChartContainer'); 
  if (!el) return;
  el.innerHTML = '';
  const c = LightweightCharts.createChart(el, {
    layout: { background: { type: 'solid', color: '#0f172a' }, textColor: '#8492a6', fontFamily: "'Inter','Noto Sans KR',sans-serif", fontSize: 11 },
    grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1e293b', scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: '#1e293b', timeVisible: false, rightOffset: 3, barSpacing: 8 },
  });
  
  R.candle = c.addCandlestickSeries({ upColor: '#ff4757', downColor: '#3b82f6', borderDownColor: '#3b82f6', borderUpColor: '#ff4757', wickDownColor: '#3b82f6', wickUpColor: '#ff4757' });
  R.ma10 = c.addLineSeries({ color: '#f0c040', lineWidth: 2, title: 'MA10', priceLineVisible: false, lastValueVisible: false });
  R.ma20 = c.addLineSeries({ color: '#00d4ff', lineWidth: 2, title: 'MA20', priceLineVisible: false, lastValueVisible: false });
  R.ma60 = c.addLineSeries({ color: '#e056fd', lineWidth: 2, title: 'MA60', priceLineVisible: false, lastValueVisible: false });
  
  R.vol = c.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
  c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });

  // MACD Line Series (별도 영역)
  R.macdSeries = c.addHistogramSeries({ 
    color: '#10b981', 
    priceScaleId: 'macdScale', 
    title: 'MACD' 
  });
  c.priceScale('macdScale').applyOptions({ scaleMargins: { top: 0.65, bottom: 0.2 }, borderVisible: false });

  R.chart = c;
  new ResizeObserver(() => c.applyOptions({ width: el.clientWidth, height: el.clientHeight })).observe(el);
}

function showReboundChart(data, signal) {
  if (!R.chart) initReboundChart();
  R.candle.setData(data.map(d => ({ time: fmtD(d.date), open: d.open, high: d.high, low: d.low, close: d.close })));
  R.ma10.setData(buildSMA(data, 10)); 
  R.ma20.setData(buildSMA(data, 20)); 
  R.ma60.setData(buildSMA(data, 60)); 
  
  R.vol.setData(data.map(d => ({ time: fmtD(d.date), value: d.volume, color: d.close >= d.open ? 'rgba(255,71,87,0.3)' : 'rgba(59,130,246,0.3)' })));
  
  // MACD 데이터 세팅
  const macdData = buildMACD(data);
  const macdFormat = macdData.map(d => ({
    time: d.time,
    value: d.value,
    color: d.value >= 0 ? 'rgba(16, 185, 129, 0.5)' : 'rgba(239, 68, 68, 0.5)'
  }));
  R.macdSeries.setData(macdFormat);

  const mk = [];
  if (signal) {
    mk.push({ time: signal.evalDate, position: 'belowBar', color: '#10b981', shape: 'arrowUp', text: 'N자 반등' });
  }
  R.candle.setMarkers(mk);
  R.chart.timeScale().fitContent();
}

// === SCAN ===
async function runReboundScan() {
  const btn = document.getElementById('btnReboundScan');
  const btnText = document.getElementById('btnReboundScanText');
  const statusDot = document.querySelector('.rebound-status-dot');
  const statusText = document.getElementById('reboundStatusText');
  const progWrap = document.getElementById('reboundScanProgressWrap');
  const progFill = document.getElementById('reboundProgressFill');
  const progText = document.getElementById('reboundProgressText');
  const results = document.getElementById('reboundMatchResults');
  
  if (!btn || !results) return;

  btn.classList.add('scanning'); btnText.textContent = '스캔 중...';
  if(statusDot) statusDot.className = 'status-dot rebound-status-dot scanning'; 
  if(statusText) statusText.textContent = '종목 리스트 로딩 중...';
  if(progWrap) progWrap.style.display = 'flex';
  results.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">⏳ 60일선 N자 반등 스캔 중...</div>`;
  
  if (R.stocks.length === 0) {
    await fetchReboundStockList();
  }
  const stockList = R.stocks;
  if(statusText) statusText.textContent = `${stockList.length}개 종목 스캔 중...`;
  
  const allMatches = [];
  const batchSize = 10;
  
  for (let i = 0; i < stockList.length; i += batchSize) {
    const batch = stockList.slice(i, i + batchSize);
    const codes = batch.map(s => s.code).join(',');
    try {
      const res = await fetch(`/api/batch?codes=${codes}&months=${R.months}`);
      const bd = await res.json();
      for (const item of bd) {
        const stock = stockList.find(s => s.code === item.code);
        if (!stock || !item.data || item.data.length < 65) continue;
        const analysis = await analyzeReboundPattern(item.data, stock);
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
  if(statusDot) statusDot.className = 'status-dot rebound-status-dot done';
  if(statusText) statusText.textContent = allMatches.length > 0 ? `✅ ${allMatches.length}건 포착!` : '매칭 없음';
  if(progWrap) progWrap.style.display = 'none'; 
  
  if (allMatches.length === 0) {
    results.innerHTML = `<div class="no-match-msg">매칭 종목 없음 😅<div class="tip">💡 현재 N자 반등을 보이는 종목이 없습니다.</div></div>`;
    return;
  }
  
  allMatches.forEach((m, idx) => m.globalIdx = idx);

  let html = `<div class="mode-badge live" style="background:rgba(59, 130, 246, 0.15); color:#3b82f6; border: 1px solid rgba(59,130,246,0.3)">📈 60일선 N자 반등 — 검색결과</div>`;
  html += `<div style="margin:15px 0 5px 0; font-size:12px; font-weight:700; color:#3b82f6; border-bottom:1px solid #1e293b; padding-bottom:5px;">매수 타점 포착 (${allMatches.length})</div>` + 
    allMatches.map((m) => {
      const s = m.signal;
      return `<div class="match-item rebound-match-item" data-idx="${m.globalIdx}" style="border-left: 2px solid #3b82f6;">
        <div class="match-header">
          <span class="match-name">${m.stock.name}</span>
          <span class="match-reliability reliability-high" style="color:#3b82f6; border-color:#3b82f6;">반등</span>
        </div>
        <div class="match-signal-date">MACD: ${s.macd} (> 0)</div>
        <div class="match-detail">
          현재가 ${s.entryPrice.toLocaleString()}원
        </div>
      </div>`;
    }).join('');

  results.innerHTML = html;
  
  results.querySelectorAll('.rebound-match-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      results.querySelectorAll('.rebound-match-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active'); 
      loadReboundMatch(allMatches[idx]);
    });
  });
  if (allMatches.length > 0) {
    results.querySelector('.rebound-match-item').classList.add('active');
    loadReboundMatch(allMatches[0]);
  }
}

function loadReboundMatch(match) {
  R.stock = match.stock; 
  R.data = match.data; 
  
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
  
  if (!R.chart) initReboundChart(); 
  else { document.getElementById('reboundChartContainer').innerHTML = ''; initReboundChart(); }
  
  showReboundChart(match.data, match.signal);
  renderReboundSignalDetails(match.signal);
}

function renderReboundSignalDetails(s) {
  const el = document.getElementById('reboundSignalsList');
  if (!el) return;

  el.innerHTML = `<div class="signal-item" style="border-left: 3px solid #3b82f6">
    <div class="signal-date" style="font-size:13px;font-weight:700;color:#3b82f6">📈 N자 반등 타점 포착</div>
    <div class="signal-detail" style="font-size:11px;line-height:1.7;margin-top:8px;">
      <b>📊 1. MACD 지표:</b> ${s.macd} (0선 돌파 완료)<br>
      <b>📈 2. 60일선 우상향:</b> 60일 전 종가(${s.past60Close.toLocaleString()}원)보다 현재 종가가 높습니다.<br>
      <b>🌊 3. N자 패턴:</b> 10일선/20일선이 60일선 아래로 눌렸다가 다시 반등(돌파)했습니다.<br>
      <br>
      ──────────<br>
      현재가: <b>${s.entryPrice.toLocaleString()}원</b><br>
      MA10: ${s.ma10} | MA20: ${s.ma20} | MA60: ${s.ma60}
    </div>
  </div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnReboundScan');
  if(btn) btn.addEventListener('click', runReboundScan);
});
