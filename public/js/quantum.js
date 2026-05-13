// 퀀텀 알파 (Quantum Alpha) 로직

let stocks = [];
let chart = null;
let candleSeries = null;
let ma20Series = null;
let ema200Series = null;
let bbUpperSeries = null;
let bbLowerSeries = null;

// Technical Indicators
function SMA(data, period, key = 'close') {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j][key];
    }
    result.push(sum / period);
  }
  return result;
}

function Stdev(data, period, maData, key = 'close') {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    let sumSq = 0;
    const mean = maData[i];
    for (let j = 0; j < period; j++) {
      const val = data[i - j][key];
      sumSq += Math.pow(val - mean, 2);
    }
    result.push(Math.sqrt(sumSq / period));
  }
  return result;
}

function EMA(data, period, key = 'close') {
  const result = [];
  const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      ema = data[i][key];
    } else {
      ema = (data[i][key] - ema) * k + ema;
    }
    result.push(ema);
  }
  return result;
}

// 초기화
async function init() {
  initChart();
  
  document.getElementById('btnScan').addEventListener('click', startScan);
}

function initChart() {
  const container = document.getElementById('chartContainer');
  chart = LightweightCharts.createChart(container, {
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#94a3b8',
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.05)' },
      horzLines: { color: 'rgba(255,255,255,0.05)' },
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.1)',
      timeVisible: true,
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    }
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#ef4444', 
    downColor: '#3b82f6',
    borderVisible: false,
    wickUpColor: '#ef4444',
    wickDownColor: '#3b82f6',
  });

  ma20Series = chart.addLineSeries({
    color: '#f59e0b',
    lineWidth: 2,
  });

  ema200Series = chart.addLineSeries({
    color: '#a855f7', // 보라색
    lineWidth: 2,
  });

  bbUpperSeries = chart.addLineSeries({
    color: 'rgba(0, 242, 254, 0.4)',
    lineWidth: 1,
    lineStyle: 2,
  });

  bbLowerSeries = chart.addLineSeries({
    color: 'rgba(0, 242, 254, 0.4)',
    lineWidth: 1,
    lineStyle: 2,
  });

  window.addEventListener('resize', () => {
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
}

// 스캔 시작
async function startScan() {
  const btn = document.getElementById('btnScan');
  btn.disabled = true;
  document.getElementById('btnScanText').innerText = '스캔 진행중...';
  
  const progressWrap = document.getElementById('progressContainer');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  progressWrap.style.display = 'flex';
  
  const resultsList = document.getElementById('resultsList');
  resultsList.innerHTML = '';
  document.getElementById('matchCount').innerText = '0';

  try {
    // 1. 종목 목록 가져오기
    const res = await fetch('/api/stocklist');
    const data = await res.json();
    if (!data.success) throw new Error('종목 목록 로딩 실패');
    stocks = data.stocks;
    
    // 테스트 속도를 위해 KOSDAQ 일부만 테스트 (실제 서비스시 전체)
    // const testStocks = stocks.slice(0, 300);
    const testStocks = stocks; // 전체

    let matched = [];
    const batchSize = 20;

    for (let i = 0; i < testStocks.length; i += batchSize) {
      const batch = testStocks.slice(i, i + batchSize);
      const codes = batch.map(s => s.code).join(',');
      
      const pRes = await fetch(`/api/batch?codes=${codes}&months=12`);
      const pData = await pRes.json();

      pData.forEach(item => {
        if (!item.data || item.data.length < 200) return; // 200일선 계산을 위해 최소 200일 데이터 필요
        
        const isMatch = checkQuantumConditions(item.data);
        if (isMatch) {
          const stockInfo = testStocks.find(s => s.code === item.code);
          matched.push({ ...stockInfo, history: item.data });
          renderMatchedStock({ ...stockInfo, history: item.data });
        }
      });

      // 진행률 업데이트
      const current = Math.min(i + batchSize, testStocks.length);
      const percent = (current / testStocks.length) * 100;
      progressFill.style.width = `${percent}%`;
      progressText.innerText = `${current} / ${testStocks.length}`;
    }

    document.getElementById('matchCount').innerText = matched.length;
    if (matched.length === 0) {
      resultsList.innerHTML = `<div class="empty-state"><p>조건을 만족하는 종목이 없습니다.</p></div>`;
    }

  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    document.getElementById('btnScanText').innerText = '퀀텀 스캔 재시작';
    setTimeout(() => progressWrap.style.display = 'none', 2000);
  }
}

// 4중 교차 검증 로직
function checkQuantumConditions(history) {
  // 지표 계산
  const closes = history.map(d => ({ close: d.close }));
  const volumes = history.map(d => ({ volume: d.volume }));
  
  const ma20 = SMA(closes, 20);
  const stdev20 = Stdev(closes, 20, ma20);
  const volMa20 = SMA(volumes, 20, 'volume');
  const ema200 = EMA(closes, 200);
  
  // MACD (12, 26, 9)
  const ema12 = EMA(closes, 12);
  const ema26 = EMA(closes, 26);
  const macdLine = [];
  for(let i=0; i<closes.length; i++) {
    if(ema12[i] !== null && ema26[i] !== null) macdLine.push({ close: ema12[i] - ema26[i] });
    else macdLine.push({ close: null });
  }
  const macdSignal = EMA(macdLine.filter(m => m.close !== null), 9);
  
  // 최신 데이터 인덱스
  const cur = history.length - 1;
  if(ma20[cur] === null || stdev20[cur] === null || volMa20[cur] === null) return false;

  const currentPrice = history[cur].close;
  const currentVol = history[cur].volume;
  
  // 1. 추세: 현재 가격이 20일선 위
  const isTrendOk = currentPrice > ma20[cur];
  
  // 2. 수축 (Squeeze): 볼린저밴드 폭이 좁은가? (고가/저가 변동폭)
  // 폭 = (Upper - Lower) / Middle
  const upper = ma20[cur] + (2 * stdev20[cur]);
  const lower = ma20[cur] - (2 * stdev20[cur]);
  const bbWidth = (upper - lower) / ma20[cur];
  const isSqueezeOk = bbWidth < 0.15; // 폭이 15% 이내로 수축된 상태 (종목마다 다를 수 있으나 타이트한 기준)

  // 3. 거래량 폭발: 20일 평균 대비 200% 이상
  const isVolOk = currentVol > volMa20[cur] * 2.0;

  // 4. 모멘텀: 전일 대비 양봉이면서 상승 마감
  const isMomentumOk = history[cur].close > history[cur].open && history[cur].close > history[cur-1].close;

  // 5. 장기 추세: 현재 가격이 지수 200일선 위
  const isEma200Ok = currentPrice > ema200[cur];

  // MACD 골든크로스 또는 MACD > 시그널 추가 가능 (현재는 위 4개로 대체)

  return isTrendOk && isSqueezeOk && isVolOk && isMomentumOk && isEma200Ok;
}

// 결과 목록 렌더링
function renderMatchedStock(stock) {
  const list = document.getElementById('resultsList');
  // 빈 상태 제거
  if (list.querySelector('.empty-state')) list.innerHTML = '';

  const cur = stock.history[stock.history.length - 1];
  const prev = stock.history[stock.history.length - 2];
  const changeRate = (((cur.close - prev.close) / prev.close) * 100).toFixed(2);
  const changeClass = changeRate > 0 ? 'up' : changeRate < 0 ? 'down' : '';

  const div = document.createElement('div');
  div.className = 'result-item';
  div.innerHTML = `
    <div class="item-header">
      <span class="item-name">${stock.name}</span>
      <span class="item-code">${stock.code}</span>
    </div>
    <div class="item-price-row">
      <span>${cur.close.toLocaleString()}원</span>
      <span class="${changeClass}">${changeRate > 0 ? '+' : ''}${changeRate}%</span>
    </div>
  `;

  div.addEventListener('click', () => {
    document.querySelectorAll('.result-item').forEach(el => el.classList.remove('active'));
    div.classList.add('active');
    showStockDetail(stock);
  });

  list.appendChild(div);
}

// 종목 상세 차트 표시
function showStockDetail(stock) {
  document.getElementById('chartPlaceholder').style.display = 'none';
  document.getElementById('stockInfoBar').style.visibility = 'visible';
  document.getElementById('analysisPanel').style.visibility = 'visible';
  document.getElementById('chartLegend').style.display = 'flex';

  const cur = stock.history[stock.history.length - 1];
  const prev = stock.history[stock.history.length - 2];
  const changeRate = (((cur.close - prev.close) / prev.close) * 100).toFixed(2);
  const changeClass = changeRate > 0 ? 'up' : changeRate < 0 ? 'down' : '';

  document.getElementById('stockName').innerText = stock.name;
  document.getElementById('stockCode').innerText = stock.code;
  document.getElementById('stockPrice').innerText = cur.close.toLocaleString() + '원';
  document.getElementById('stockChange').className = `price-change ${changeClass}`;
  document.getElementById('stockChange').innerText = `${changeRate > 0 ? '▲' : '▼'} ${Math.abs(changeRate)}%`;

  // 차트 데이터 포맷팅
  const candleData = stock.history.map(d => ({
    time: `${d.date.slice(0,4)}-${d.date.slice(4,6)}-${d.date.slice(6,8)}`,
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close
  }));

  const closes = stock.history.map(d => ({ close: d.close }));
  const ma20 = SMA(closes, 20);
  const ema200 = EMA(closes, 200);
  const stdev20 = Stdev(closes, 20, ma20);

  const ma20Data = [];
  const ema200Data = [];
  const upperData = [];
  const lowerData = [];

  for (let i = 0; i < stock.history.length; i++) {
    const time = `${stock.history[i].date.slice(0,4)}-${stock.history[i].date.slice(4,6)}-${stock.history[i].date.slice(6,8)}`;
    if (ma20[i] !== null) {
      ma20Data.push({ time, value: ma20[i] });
      upperData.push({ time, value: ma20[i] + (2 * stdev20[i]) });
      lowerData.push({ time, value: ma20[i] - (2 * stdev20[i]) });
    }
    if (ema200[i] !== null) {
      ema200Data.push({ time, value: ema200[i] });
    }
  }

  candleSeries.setData(candleData);
  ma20Series.setData(ma20Data);
  ema200Series.setData(ema200Data);
  bbUpperSeries.setData(upperData);
  bbLowerSeries.setData(lowerData);

  chart.timeScale().fitContent();
}

window.onload = init;
