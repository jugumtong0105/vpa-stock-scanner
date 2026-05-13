// 신규 조건검색 스캐너 (VPA 기존 로직과 독립적으로 작동)
let N = {
  stocks: [],
  stock: null,
  data: [],
  chart: null,
  candle: null,
  vol: null,
  ma5: null,
  ma20: null,
  bbUpper: null,
  bbLower: null,
  months: 12
};

function fmtD(d) { return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`; }
function calcMA(data, i, p) { if (i < p - 1) return null; let s = 0; for (let j = i - p + 1; j <= i; j++) s += data[j].close; return s / p; }
function buildMA(data, p) { const r = []; for (let i = 0; i < data.length; i++) { if (i < p - 1) continue; let s = 0; for (let j = i - p + 1; j <= i; j++) s += data[j].close; r.push({ time: fmtD(data[i].date), value: s / p }); } return r; }

// 볼린저 밴드 계산
function buildBB(data, p, dev) {
  const upper = [], lower = [];
  for (let i = 0; i < data.length; i++) {
    if (i < p - 1) continue;
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += data[j].close;
    const ma = s / p;
    let devSum = 0;
    for (let j = i - p + 1; j <= i; j++) devSum += Math.pow(data[j].close - ma, 2);
    const stdDev = Math.sqrt(devSum / p);
    upper.push({ time: fmtD(data[i].date), value: ma + (dev * stdDev) });
    lower.push({ time: fmtD(data[i].date), value: ma - (dev * stdDev) });
  }
  return { upper, lower };
}

async function fetchNewStockList() {
  try {
    const r = await fetch('/api/new-scanner/stocklist');
    const j = await r.json();
    if (j.success && j.stocks.length > 50) { N.stocks = j.stocks; return; }
  } catch (e) { console.error("New stock list fetch failed", e); }
}

function analyzeNewPattern(data, stock) {
  const lastIdx = data.length - 1;
  if (lastIdx < 25) return null; // 볼린저 밴드 및 이평선 계산을 위해 최소 데이터 필요

  const evalIdx = lastIdx; // 현재가 기준 (Live 모드와 동일하게 최신 캔들 기준)
  
  // F. 주가범위: 1000이상 150000이하
  const todayClose = data[evalIdx].close;
  if (todayClose < 1000 || todayClose > 150000) return null;

  // B. 시가총액: 50십억원 이상 3000십억원 이하 (500억 ~ 3조) -> mcap 단위는 '억원'
  const mcap = stock.mcap || 0;
  if (mcap < 500 || mcap > 30000) return null;

  // D. 주가등락률: 1봉전 종가대비 0봉전 종가 5% 이상
  const yesterdayClose = data[evalIdx - 1].close;
  if (((todayClose - yesterdayClose) / yesterdayClose) < 0.05) return null;

  // A. 주가이평돌파: [일]0봉전 5이평 20이평 골든크로스
  const ma5 = calcMA(data, evalIdx, 5);
  const ma20 = calcMA(data, evalIdx, 20);
  const prevMa5 = calcMA(data, evalIdx - 1, 5);
  const prevMa20 = calcMA(data, evalIdx - 1, 20);
  if (!ma5 || !ma20 || !prevMa5 || !prevMa20) return null;
  const isGoldenCross = prevMa5 <= prevMa20 && ma5 > ma20;
  if (!isGoldenCross) return null;

  // E. [일]0봉전 Bollinger Band(20,2) 종가가 상한선 이상
  let s = 0;
  for (let j = evalIdx - 19; j <= evalIdx; j++) s += data[j].close;
  const bb_ma20 = s / 20;
  let devSum = 0;
  for (let j = evalIdx - 19; j <= evalIdx; j++) devSum += Math.pow(data[j].close - bb_ma20, 2);
  const stdDev = Math.sqrt(devSum / 20);
  const bb_upper = bb_ma20 + (2 * stdDev);
  if (todayClose < bb_upper) return null;

  // C. 기간내 등락률: [일]0봉전 10봉이내에서 전일종가대비 당일고가 10% 이상
  let conditionC = false;
  for (let j = Math.max(1, evalIdx - 10); j <= evalIdx; j++) {
    const pClose = data[j - 1].close;
    const hi = data[j].high;
    if (((hi - pClose) / pClose) >= 0.10) {
      conditionC = true;
      break;
    }
  }
  if (!conditionC) return null;

  return {
    evalDate: fmtD(data[evalIdx].date),
    entryPrice: todayClose,
    goldenCross: isGoldenCross,
    bbUpper: bb_upper.toFixed(2),
    mcap: mcap,
    changePct: (((todayClose - yesterdayClose) / yesterdayClose) * 100).toFixed(2)
  };
}

// === NEW CHART ===
function initNewChart() {
  const el = document.getElementById('newChartContainer'); 
  if (!el) return;
  el.innerHTML = '';
  const c = LightweightCharts.createChart(el, {
    layout: { background: { type: 'solid', color: '#080b12' }, textColor: '#8492a6', fontFamily: "'Inter','Noto Sans KR',sans-serif", fontSize: 11 },
    grid: { vertLines: { color: '#141c28' }, horzLines: { color: '#141c28' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1e293b', scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: '#1e293b', timeVisible: false, rightOffset: 3, barSpacing: 8 },
  });
  N.candle = c.addCandlestickSeries({ upColor: '#ff4757', downColor: '#3b82f6', borderDownColor: '#3b82f6', borderUpColor: '#ff4757', wickDownColor: '#3b82f6', wickUpColor: '#ff4757' });
  N.ma5 = c.addLineSeries({ color: '#f0c040', lineWidth: 2, title: 'MA5', priceLineVisible: false, lastValueVisible: false });
  N.ma20 = c.addLineSeries({ color: '#00d4ff', lineWidth: 2, title: 'MA20', priceLineVisible: false, lastValueVisible: false });
  
  // BB bands
  N.bbUpper = c.addLineSeries({ color: 'rgba(224, 86, 253, 0.6)', lineWidth: 1, title: 'BB Upper', priceLineVisible: false, lastValueVisible: false, lineStyle: LightweightCharts.LineStyle.Dashed });
  N.bbLower = c.addLineSeries({ color: 'rgba(224, 86, 253, 0.6)', lineWidth: 1, title: 'BB Lower', priceLineVisible: false, lastValueVisible: false, lineStyle: LightweightCharts.LineStyle.Dashed });

  N.vol = c.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
  c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });
  N.chart = c;
  new ResizeObserver(() => c.applyOptions({ width: el.clientWidth, height: el.clientHeight })).observe(el);
}

function showNewChart(data, signal) {
  if (!N.chart) initNewChart();
  N.candle.setData(data.map(d => ({ time: fmtD(d.date), open: d.open, high: d.high, low: d.low, close: d.close })));
  N.ma5.setData(buildMA(data, 5)); 
  N.ma20.setData(buildMA(data, 20)); 
  
  const bb = buildBB(data, 20, 2);
  N.bbUpper.setData(bb.upper);
  N.bbLower.setData(bb.lower);

  N.vol.setData(data.map(d => ({ time: fmtD(d.date), value: d.volume, color: d.close >= d.open ? 'rgba(255,71,87,0.3)' : 'rgba(59,130,246,0.3)' })));
  
  const mk = [];
  if (signal) {
    mk.push({ time: signal.evalDate, position: 'belowBar', color: '#00d4aa', shape: 'arrowUp', text: '🔥골든크로스+BB상단' });
  }
  N.candle.setMarkers(mk);
  N.chart.timeScale().fitContent();
  document.getElementById('newSignalLegend').style.display = 'flex';
}

// === NEW SCAN ===
async function runNewScan() {
  const btn = document.getElementById('btnNewScan');
  const btnText = document.getElementById('btnNewScanText');
  const statusDot = document.querySelector('.new-status-dot');
  const statusText = document.getElementById('newStatusText');
  const progWrap = document.getElementById('newScanProgressWrap');
  const progFill = document.getElementById('newProgressFill');
  const progText = document.getElementById('newProgressText');
  const results = document.getElementById('newMatchResults');
  
  btn.classList.add('scanning'); btnText.textContent = '스캔 중...';
  if(statusDot) statusDot.className = 'status-dot new-status-dot scanning'; 
  if(statusText) statusText.textContent = '종목 리스트 로딩 중 (시가총액)...';
  progWrap.style.display = 'flex';
  results.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">⏳ 신규 조건검색 스캔 중...</div>`;
  
  if (N.stocks.length === 0) {
    await fetchNewStockList();
  }
  const stockList = N.stocks;
  if(statusText) statusText.textContent = `${stockList.length}개 종목 스캔 중...`;
  
  const allMatches = [];
  let scanned = 0;
  const batchSize = 10;
  for (let i = 0; i < stockList.length; i += batchSize) {
    const batch = stockList.slice(i, i + batchSize);
    const codes = batch.map(s => s.code).join(',');
    try {
      const r = await fetch(`/api/batch?codes=${codes}&months=${N.months}`);
      const bd = await r.json();
      for (const item of bd) {
        const stock = stockList.find(s => s.code === item.code);
        if (!stock || !item.data || item.data.length < 25) continue;
        const sig = analyzeNewPattern(item.data, stock);
        if (sig) {
          allMatches.push({ stock, data: item.data, signal: sig });
        }
        scanned++;
      }
    } catch (e) { console.error(e); }
    const pct = Math.min(((i + batchSize) / stockList.length) * 100, 100);
    progFill.style.width = pct + '%';
    progText.textContent = `${Math.min(i + batchSize, stockList.length)} / ${stockList.length}`;
    if(statusText) statusText.textContent = `스캔 중... (${allMatches.length}건 발견)`;
  }
  
  btn.classList.remove('scanning'); btnText.textContent = '다시 스캔';
  if(statusDot) statusDot.className = 'status-dot new-status-dot done';
  if(statusText) statusText.textContent = allMatches.length > 0 ? `✅ ${allMatches.length}건 포착!` : '매칭 없음';
  progWrap.style.display = 'none'; 
  
  if (allMatches.length === 0) {
    results.innerHTML = `<div class="no-match-msg">매칭 종목 없음 😅<div class="tip">💡 시장 상황에 따라 조건에 맞는 종목이 없을 수 있습니다.</div></div>`;
    return;
  }
  
  results.innerHTML = `<div class="mode-badge live" style="background:rgba(224, 86, 253, 0.15); color:#e056fd; border: 1px solid rgba(224,86,253,0.3)">🚀 신규 조건검색 — 골든크로스 + BB돌파</div>` + 
  allMatches.map((m, idx) => {
    const s = m.signal;
    return `<div class="match-item new-match-item" data-idx="${idx}">
      <div class="match-header">
        <span class="match-name">${m.stock.name}</span>
        <span class="match-reliability reliability-high" style="color:#00d4aa">+${s.changePct}% 급등</span>
      </div>
      <div class="match-signal-date">시가총액: ${(s.mcap * 100000000).toLocaleString()}원</div>
      <div class="match-detail">
        포착가 ${s.entryPrice.toLocaleString()}원<br>
        BB상단돌파 (${s.bbUpper}) | MA5 골든크로스 완료
      </div>
      <div class="match-tags">
        <span class="match-tag tomorrow" style="background:#e056fd;color:#fff;">🎯 매수타점</span>
        <span class="match-tag">${m.stock.market}</span>
      </div>
    </div>`;
  }).join('');
  
  results.querySelectorAll('.new-match-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      results.querySelectorAll('.new-match-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active'); 
      loadNewMatch(allMatches[idx]);
    });
  });
  if (allMatches.length > 0) {
    results.querySelector('.new-match-item').classList.add('active');
    loadNewMatch(allMatches[0]);
  }
}

function loadNewMatch(match) {
  N.stock = match.stock; 
  N.data = match.data; 
  
  const titleEl = document.getElementById('newCurrentStockName');
  if(titleEl) titleEl.textContent = match.stock.name;
  
  const codeEl = document.getElementById('newCurrentStockCode');
  if(codeEl) codeEl.textContent = match.stock.code + ' | 시총 ' + (match.signal.mcap * 1).toLocaleString() + '억원';
  
  const priceEl = document.getElementById('newCurrentPrice');
  if(priceEl) priceEl.textContent = match.signal.entryPrice.toLocaleString() + '원';
  
  const chEl = document.getElementById('newPriceChange');
  if(chEl) {
    chEl.textContent = '+' + match.signal.changePct + '%';
    chEl.className = 'price-change price-up';
  }
  
  if (!N.chart) initNewChart(); 
  else { document.getElementById('newChartContainer').innerHTML = ''; initNewChart(); }
  
  showNewChart(match.data, match.signal);
  renderNewSignalDetails(match.signal);
}

function renderNewSignalDetails(s) {
  const el = document.getElementById('newSignalsList');
  if (!el) return;
  el.innerHTML = `<div class="signal-item" style="border-left: 3px solid #e056fd">
    <div class="signal-date" style="font-size:13px;font-weight:700;color:#e056fd">🔥 골든크로스 & BB 돌파</div>
    <div class="signal-detail" style="font-size:11px;line-height:1.7">
      <b>📉 이동평균선:</b> MA5 > MA20 골든크로스 확인<br>
      <b>📈 볼린저밴드:</b> 종가 ${s.entryPrice.toLocaleString()}원 >= BB상단 ${s.bbUpper}<br>
      <b>💰 당일등락:</b> 전일대비 +${s.changePct}% 상승<br>
      <b>📊 시가총액:</b> ${(s.mcap / 10).toLocaleString()}천억원 규모 (조건만족)<br>
      ──────────<br>
      💎 진입 타점: <b>${s.entryPrice.toLocaleString()}원</b> 부근
    </div>
  </div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnNewScan');
  if(btn) btn.addEventListener('click', runNewScan);
});
