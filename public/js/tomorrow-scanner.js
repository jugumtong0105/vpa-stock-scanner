// 내일 급등 종가 베팅 (Tomorrow's Surge Setup) 스캐너
let T = {
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
  months: 6
};

function fmtD(d) { return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`; }
function calcMA(data, i, p) { if (i < p - 1) return null; let s = 0; for (let j = i - p + 1; j <= i; j++) s += data[j].close; return s / p; }
function buildMA(data, p) { const r = []; for (let i = 0; i < data.length; i++) { if (i < p - 1) continue; let s = 0; for (let j = i - p + 1; j <= i; j++) s += data[j].close; r.push({ time: fmtD(data[i].date), value: s / p }); } return r; }

function calcWMA(data, i, p) {
  if (i < p - 1) return null;
  let s = 0;
  let wSum = (p * (p + 1)) / 2;
  let weight = 1;
  for (let j = i - p + 1; j <= i; j++) {
    s += data[j].close * weight;
    weight++;
  }
  return s / wSum;
}

function buildWMA(data, p) {
  const r = [];
  let wSum = (p * (p + 1)) / 2;
  for (let i = 0; i < data.length; i++) {
    if (i < p - 1) continue;
    let s = 0;
    let weight = 1;
    for (let j = i - p + 1; j <= i; j++) {
      s += data[j].close * weight;
      weight++;
    }
    r.push({ time: fmtD(data[i].date), value: s / wSum });
  }
  return r;
}

// 볼린저밴드 계산
function calcStdDev(data, i, p, ma) {
  if (i < p - 1 || ma === null) return null;
  let sum = 0;
  for (let j = i - p + 1; j <= i; j++) {
    sum += Math.pow(data[j].close - ma, 2);
  }
  return Math.sqrt(sum / p);
}

function buildBBUpper(data, p, mult) {
  const r = [];
  for (let i = 0; i < data.length; i++) {
    if (i < p - 1) continue;
    const ma = calcMA(data, i, p);
    const sd = calcStdDev(data, i, p, ma);
    if (ma !== null && sd !== null) {
      r.push({ time: fmtD(data[i].date), value: ma + (sd * mult) });
    }
  }
  return r;
}

function buildBBLower(data, p, mult) {
  const r = [];
  for (let i = 0; i < data.length; i++) {
    if (i < p - 1) continue;
    const ma = calcMA(data, i, p);
    const sd = calcStdDev(data, i, p, ma);
    if (ma !== null && sd !== null) {
      r.push({ time: fmtD(data[i].date), value: ma - (sd * mult) });
    }
  }
  return r;
}

async function fetchTomorrowStockList() {
  try {
    const r = await fetch('/api/stocklist');
    const j = await r.json();
    if (j.success && j.stocks.length > 50) { T.stocks = j.stocks; return; }
  } catch (e) { console.error("Stock list fetch failed", e); }
}

async function analyzeTomorrowPattern(data, stock) {
  const lastIdx = data.length - 1;
  if (lastIdx < 40) return null; // 최소 40봉 필요

  const evalIdx = lastIdx;
  const today = data[evalIdx];
  const yesterday = data[evalIdx - 1];

  // F. 주가범위: 1000원 ~ 150000원
  if (today.close < 1000 || today.close > 150000) return null;

  // C. 기간내 등락률: 최근 10봉 이내(오늘 제외)에서 전일종가대비 당일고가 10% 이상 상승한 '기준봉' 찾기
  let targetCandleIdx = -1;
  let targetCandle = null;
  
  for (let i = evalIdx - 10; i < evalIdx; i++) {
    if (i <= 0) continue;
    const prev = data[i - 1];
    const highPct = (data[i].high - prev.close) / prev.close;
    if (highPct >= 0.10) {
      // 가장 최근 급등봉을 기준봉으로 잡음
      targetCandleIdx = i;
      targetCandle = data[i];
    }
  }

  // 10일 이내에 돈이 들어온 흔적(급등)이 없으면 탈락
  if (targetCandleIdx === -1) return null;

  const wma5 = calcWMA(data, evalIdx, 5);
  const wma20 = calcWMA(data, evalIdx, 20);
  
  // 볼린저 밴드는 단순이평(SMA)을 기준으로 계산 (표준)
  const sma20 = calcMA(data, evalIdx, 20);
  const sd = calcStdDev(data, evalIdx, 20, sma20);
  
  if (!wma5 || !wma20 || !sma20 || !sd) return null;
  const bbUpper = sma20 + (sd * 2);

  const baseSignal = {
    evalDate: fmtD(today.date),
    entryPrice: today.close,
    targetDate: fmtD(targetCandle.date),
    targetHighPct: (((targetCandle.high - data[targetCandleIdx-1].close) / data[targetCandleIdx-1].close) * 100).toFixed(1),
    wma5: wma5.toFixed(2),
    wma20: wma20.toFixed(2),
    bbUpper: bbUpper.toFixed(2)
  };

  // A 변형: 가중이평선 수렴. 5일선이 20일선 근처이거나 크로스 초입
  // 조건: 가중 5일선이 가중 20일선의 98% ~ 105% 이내 위치
  const isMaConverged = wma5 >= wma20 * 0.98 && wma5 <= wma20 * 1.05;
  if (!isMaConverged) return null;

  // E 변형: 볼린저 밴드 상단 근접 & 횡보
  // 조건: 오늘 종가가 단순 20일선 위이면서, 밴드 상단보다 너무 높지 않아야 함 (상단의 85% ~ 105% 이내)
  const isNearBBUpper = today.close >= sma20 && today.close >= bbUpper * 0.85 && today.close <= bbUpper * 1.05;
  if (!isNearBBUpper) return null;

  // --- 여기까지가 1단계 (급등 이력 + 이평수렴 + 볼밴상단근접) ---
  
  // D 변형 (내일 5% 급등을 위한 오늘의 응축): 오늘 캔들은 변동성이 작고(단봉), 거래량이 현저히 줄었는가?
  // 1. 단봉 조건: 시가-종가 변동폭 3% 이하, 또는 고가-저가 꼬리 포함해도 변동폭이 작음.
  const bodyPct = Math.abs(today.close - today.open) / today.open;
  // 2. 거래량 마름: 오늘 거래량이 급등 기준봉 거래량의 35% 이하
  const volDried = today.volume <= targetCandle.volume * 0.35;

  if (bodyPct <= 0.04 && volDried) {
    return { stage: 2, signal: baseSignal }; // 완벽한 타점
  }

  return { stage: 1, signal: baseSignal }; // 1단계 만족 (관심종목)
}

// === CHART ===
function initTomorrowChart() {
  const el = document.getElementById('tomorrowChartContainer'); 
  if (!el) return;
  el.innerHTML = '';
  const c = LightweightCharts.createChart(el, {
    layout: { background: { type: 'solid', color: '#0f172a' }, textColor: '#8492a6', fontFamily: "'Inter','Noto Sans KR',sans-serif", fontSize: 11 },
    grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1e293b', scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: '#1e293b', timeVisible: false, rightOffset: 3, barSpacing: 8 },
  });
  T.candle = c.addCandlestickSeries({ upColor: '#ff4757', downColor: '#3b82f6', borderDownColor: '#3b82f6', borderUpColor: '#ff4757', wickDownColor: '#3b82f6', wickUpColor: '#ff4757' });
  T.ma5 = c.addLineSeries({ color: '#f0c040', lineWidth: 2, title: 'WMA5', priceLineVisible: false, lastValueVisible: false });
  T.ma20 = c.addLineSeries({ color: '#00d4ff', lineWidth: 2, title: 'WMA20', priceLineVisible: false, lastValueVisible: false });
  T.bbUpper = c.addLineSeries({ color: 'rgba(236, 72, 153, 0.6)', lineWidth: 1, title: 'BB(Upper)', priceLineVisible: false, lastValueVisible: false });
  T.bbLower = c.addLineSeries({ color: 'rgba(236, 72, 153, 0.6)', lineWidth: 1, title: 'BB(Lower)', priceLineVisible: false, lastValueVisible: false });
  
  T.vol = c.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
  c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });
  T.chart = c;
  new ResizeObserver(() => c.applyOptions({ width: el.clientWidth, height: el.clientHeight })).observe(el);
}

function showTomorrowChart(data, signal) {
  if (!T.chart) initTomorrowChart();
  T.candle.setData(data.map(d => ({ time: fmtD(d.date), open: d.open, high: d.high, low: d.low, close: d.close })));
  T.ma5.setData(buildWMA(data, 5)); 
  T.ma20.setData(buildWMA(data, 20)); 
  T.bbUpper.setData(buildBBUpper(data, 20, 2));
  T.bbLower.setData(buildBBLower(data, 20, 2));
  
  T.vol.setData(data.map(d => ({ time: fmtD(d.date), value: d.volume, color: d.close >= d.open ? 'rgba(255,71,87,0.3)' : 'rgba(59,130,246,0.3)' })));
  
  const mk = [];
  if (signal) {
    mk.push({ time: signal.targetDate, position: 'aboveBar', color: '#ec4899', shape: 'arrowDown', text: '급등 기준봉' });
    mk.push({ time: signal.evalDate, position: 'belowBar', color: '#10b981', shape: 'arrowUp', text: '매수 타점' });
  }
  T.candle.setMarkers(mk);
  T.chart.timeScale().fitContent();
}

// === SCAN ===
async function runTomorrowScan() {
  const btn = document.getElementById('btnTomorrowScan');
  const btnText = document.getElementById('btnTomorrowScanText');
  const statusDot = document.querySelector('.tomorrow-status-dot');
  const statusText = document.getElementById('tomorrowStatusText');
  const progWrap = document.getElementById('tomorrowScanProgressWrap');
  const progFill = document.getElementById('tomorrowProgressFill');
  const progText = document.getElementById('tomorrowProgressText');
  const results = document.getElementById('tomorrowMatchResults');
  
  if (!btn || !results) return;

  btn.classList.add('scanning'); btnText.textContent = '스캔 중...';
  if(statusDot) statusDot.className = 'status-dot tomorrow-status-dot scanning'; 
  if(statusText) statusText.textContent = '종목 리스트 로딩 중...';
  if(progWrap) progWrap.style.display = 'flex';
  results.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">⏳ 내일 급등 종가베팅 스캔 중...</div>`;
  
  if (T.stocks.length === 0) {
    await fetchTomorrowStockList();
  }
  const stockList = T.stocks;
  if(statusText) statusText.textContent = `${stockList.length}개 종목 스캔 중...`;
  
  const allMatches = [];
  let scanned = 0;
  const batchSize = 10;
  
  for (let i = 0; i < stockList.length; i += batchSize) {
    const batch = stockList.slice(i, i + batchSize);
    const codes = batch.map(s => s.code).join(',');
    try {
      const r = await fetch(`/api/batch?codes=${codes}&months=${T.months}`);
      const bd = await r.json();
      for (const item of bd) {
        const stock = stockList.find(s => s.code === item.code);
        if (!stock || !item.data || item.data.length < 40) continue;
        const res = await analyzeTomorrowPattern(item.data, stock);
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
  if(statusDot) statusDot.className = 'status-dot tomorrow-status-dot done';
  if(statusText) statusText.textContent = allMatches.length > 0 ? `✅ ${allMatches.length}건 포착!` : '매칭 없음';
  if(progWrap) progWrap.style.display = 'none'; 
  
  if (allMatches.length === 0) {
    results.innerHTML = `<div class="no-match-msg">매칭 종목 없음 😅<div class="tip">💡 폭풍 전야의 수렴 구간에 있는 종목이 현재 없습니다.</div></div>`;
    return;
  }
  
  allMatches.forEach((m, idx) => m.globalIdx = idx);

  const stage2 = allMatches.filter(m => m.stage === 2);
  const stage1 = allMatches.filter(m => m.stage === 1);

  let html = `<div class="mode-badge live" style="background:rgba(16, 185, 129, 0.15); color:#10b981; border: 1px solid rgba(16,185,129,0.3)">🚀 내일 급등 후보 — 검색결과</div>`;

  function renderGroup(group, title, color, badgeText) {
    if (group.length === 0) return '';
    return `<div style="margin:15px 0 5px 0; font-size:12px; font-weight:700; color:${color}; border-bottom:1px solid #1e293b; padding-bottom:5px;">${title} (${group.length})</div>` + 
    group.map((m) => {
      const s = m.signal;
      return `<div class="match-item tomorrow-match-item" data-idx="${m.globalIdx}" style="border-left: 2px solid ${color};">
        <div class="match-header">
          <span class="match-name">${m.stock.name}</span>
          <span class="match-reliability reliability-high" style="color:${color}; border-color:${color};">${badgeText}</span>
        </div>
        <div class="match-signal-date">기준: ${s.targetDate} (+${s.targetHighPct}%)</div>
        <div class="match-detail">
          현재가 ${s.entryPrice.toLocaleString()}원
        </div>
      </div>`;
    }).join('');
  }

  html += renderGroup(stage2, '완벽한 타점 (단봉 & 거래량 마름)', '#10b981', '베팅승인');
  html += renderGroup(stage1, '관심 종목 (볼밴 상단 밀집 & 이평 수렴)', '#ec4899', '관심종목');

  results.innerHTML = html;
  
  results.querySelectorAll('.tomorrow-match-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      results.querySelectorAll('.tomorrow-match-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active'); 
      loadTomorrowMatch(allMatches[idx]);
    });
  });
  if (allMatches.length > 0) {
    results.querySelector('.tomorrow-match-item').classList.add('active');
    loadTomorrowMatch(allMatches[0]);
  }
}

function loadTomorrowMatch(match) {
  T.stock = match.stock; 
  T.data = match.data; 
  
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
  
  if (!T.chart) initTomorrowChart(); 
  else { document.getElementById('tomorrowChartContainer').innerHTML = ''; initTomorrowChart(); }
  
  showTomorrowChart(match.data, match.signal);
  renderTomorrowSignalDetails(match.signal, match.stage);
}

function renderTomorrowSignalDetails(s, stage) {
  const el = document.getElementById('tomorrowSignalsList');
  if (!el) return;
  
  let stageText = '';
  let color = '';
  if (stage === 2) { stageText = '✅ 타점 승인: 거래량 마른 단봉 출현'; color = '#10b981'; }
  else { stageText = '👀 수렴 진행중: 볼린저 밴드 상단 밀집'; color = '#ec4899'; }

  el.innerHTML = `<div class="signal-item" style="border-left: 3px solid ${color}">
    <div class="signal-date" style="font-size:13px;font-weight:700;color:${color}">${stageText}</div>
    <div class="signal-detail" style="font-size:11px;line-height:1.7;margin-top:8px;">
      <b>🔥 1. 급등 이력:</b> ${s.targetDate} (고가 +${s.targetHighPct}%)<br>
      <b>📈 2. 가중이평 수렴:</b> 가중 5일선(${s.wma5})이 가중 20일선(${s.wma20})과 근접 (골든크로스 초입)<br>
      <b>🌪️ 3. 볼밴 밀집:</b> 종가가 볼린저밴드 상단(${s.bbUpper}) 근처에서 힘을 응축 중<br>
      <b>📉 4. 폭풍 전야:</b> ${stage === 2 ? '변동성이 죽고 거래량이 말랐습니다! (내일 급등 유력)' : '단봉(십자도지 등)이 나오거나 거래량이 더 줄기를 기다립니다.'}<br>
      <br>
      ──────────<br>
      현재가: <b>${s.entryPrice.toLocaleString()}원</b>
    </div>
  </div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnTomorrowScan');
  if(btn) btn.addEventListener('click', runTomorrowScan);
});
