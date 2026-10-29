/* 역매공파 112: 장기 역배열 → 매집봉 → 20·60일선 회복 → 112일선 공략 */
(function () {
  'use strict';

  const COLOR = '#38bdf8';
  const state = { stocks: [], matches: [], chart: null, candle: null, volume: null, lines: {}, months: 36 };
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const formatDate = value => `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}`;
  const ma = (data, index, period) => index >= period - 1 ? average(data.slice(index - period + 1, index + 1).map(row => row.close)) : null;

  function std(values) {
    const mean = average(values);
    return Math.sqrt(average(values.map(value => (value - mean) ** 2)));
  }

  function atr(data, index, period = 20) {
    if (index < period) return 0;
    const values = [];
    for (let i = index - period + 1; i <= index; i++) {
      const previous = data[i - 1].close;
      values.push(Math.max(data[i].high - data[i].low, Math.abs(data[i].high - previous), Math.abs(data[i].low - previous)));
    }
    return average(values);
  }

  function findAccumulation(data, index, lookback = 90) {
    let best = null;
    for (let i = Math.max(20, index - lookback); i <= index; i++) {
      const row = data[i], range = Math.max(row.high - row.low, 1);
      const bodyPct = (row.close / row.open - 1) * 100;
      const closeLocation = (row.close - row.low) / range;
      const avgVolume = average(data.slice(i - 20, i).map(item => item.volume));
      const volumeRatio = avgVolume ? row.volume / avgVolume : 0;
      const tradeValue = row.close * row.volume;
      if (bodyPct < 3 || volumeRatio < 1.7 || closeLocation < 0.65 || tradeValue < 1000000000) continue;
      const power = Math.min(bodyPct, 12) + Math.min(volumeRatio, 5) * 2 + closeLocation * 5;
      if (!best || power > best.power) best = { index: i, date: formatDate(row.date), bodyPct, volumeRatio, tradeValue, closeLocation, power };
    }
    return best;
  }

  function recentCross112(data, index, lookback = 20) {
    for (let i = index; i >= Math.max(448, index - lookback); i--) {
      const current = ma(data, i, 112), previous = ma(data, i - 1, 112);
      if (previous && data[i - 1].close < previous && data[i].close >= current) return i;
    }
    return -1;
  }

  function scoreReverseMa112(data, index, stock = {}) {
    if (!Array.isArray(data) || index < 448 || index >= data.length) return null;
    const today = data[index];
    const ma20 = ma(data, index, 20), ma60 = ma(data, index, 60), ma112 = ma(data, index, 112);
    const ma224 = ma(data, index, 224), ma448 = ma(data, index, 448);
    const oldMa20 = ma(data, index - 5, 20);
    const reverseStrict = ma112 < ma224 && ma224 < ma448;
    const reverseLoose = ma112 < ma224 * 1.05 && ma224 < ma448 * 1.05;
    const aboveShort = today.close > ma20 * 0.97 && today.close > ma60 * 0.97;
    const distance112 = (today.close / ma112 - 1) * 100;
    const accumulation = findAccumulation(data, index);
    const crossIndex = recentCross112(data, index);
    const closes20 = data.slice(index - 19, index + 1).map(row => row.close);
    const bbUpper = ma20 + 2 * std(closes20);
    const bbDistance = (today.close / bbUpper - 1) * 100;
    const priorLow = Math.min(...data.slice(index - 80, index - 19).map(row => row.low));
    const recentLow = Math.min(...data.slice(index - 19, index + 1).map(row => row.low));
    const higherLow = recentLow >= priorLow * 0.97;
    const atrPct = atr(data, index) / today.close * 100;
    const tradeValue = today.close * today.volume;

    if (!reverseLoose || !aboveShort || !accumulation || distance112 < -12 || distance112 > 12 ||
        stock.tradable === false || stock.management ||
        (stock.marketAlertType && stock.marketAlertType !== '00')) return null;

    const parts = { reverse: reverseStrict ? 20 : 15, recovery: 0, accumulation: 0, line112: 0, base: 0, risk: 0 };
    if (today.close > ma20) parts.recovery += 5;
    if (today.close > ma60) parts.recovery += 8;
    if (ma20 > oldMa20) parts.recovery += 4;
    if (ma20 > ma60) parts.recovery += 3;
    const accumulationAge = index - accumulation.index;
    parts.accumulation += accumulationAge <= 20 ? 12 : 8;
    parts.accumulation += accumulation.volumeRatio >= 3 ? 5 : accumulation.volumeRatio >= 2 ? 4 : 3;
    parts.accumulation += accumulation.bodyPct >= 6 ? 3 : 2;
    if (crossIndex === index) parts.line112 = 20;
    else if (crossIndex >= index - 10 && today.close >= ma112 * 0.98) parts.line112 = 18;
    else if (Math.abs(distance112) <= 3) parts.line112 = 16;
    else if (Math.abs(distance112) <= 6) parts.line112 = 12;
    else parts.line112 = 6;
    if (higherLow) parts.base += 5;
    if (atrPct <= 6) parts.base += 3;
    if (Math.abs(bbDistance) <= 5) parts.base += 2;

    const supportCandidates = [ma60 * 0.98, ma112 * 0.97, recentLow].filter(value => value < today.close);
    const structuralStop = supportCandidates.length ? Math.max(...supportCandidates) : today.close * 0.95;
    const stopPrice = Math.round(structuralStop);
    const riskPct = (today.close - stopPrice) / today.close * 100;
    if (riskPct >= 2 && riskPct <= 5) parts.risk += 5;
    else if (riskPct <= 8) parts.risk += 3;
    if (Math.abs(distance112) <= 6) parts.risk += 3;
    if (accumulation.tradeValue >= 10000000000) parts.risk += 2;

    let penalty = 0;
    if (distance112 > 8) penalty += 8;
    if (atrPct > 10) penalty += 6;
    if (accumulationAge > 45) penalty += 4;
    if (accumulationAge > 70) penalty += 4;
    if (riskPct > 8) penalty += 6;
    const score = Math.max(0, Math.min(100, Object.values(parts).reduce((sum, value) => sum + value, 0) - penalty));
    const stage = crossIndex >= index - 10 && today.close >= ma112 * 0.98 ? '112 돌파·안착' : today.close < ma112 ? '112 돌파 대기' : '112선 눌림';

    return {
      date: formatDate(today.date), score, grade: score >= 85 ? 'S' : score >= 75 ? 'A' : 'B', stage, parts, penalty,
      close: today.close, stopPrice, riskPct, ma20, ma60, ma112, ma224, ma448, distance112,
      bbUpper, bbDistance, higherLow, atrPct, accumulation, crossDate: crossIndex >= 0 ? formatDate(data[crossIndex].date) : null
    };
  }

  function analyzeReverseMa112(data, options = {}, stock = {}) {
    const minScore = Number(options.minScore ?? 80);
    const recentDays = Math.max(1, Number(options.recentDays ?? 3));
    let best = null;
    for (let index = data.length - 1; index >= Math.max(448, data.length - recentDays); index--) {
      const signal = scoreReverseMa112(data, index, stock);
      if (signal && signal.score >= minScore && (!best || signal.score > best.score)) best = signal;
    }
    return best;
  }

  async function loadStocks() {
    if (state.stocks.length) return;
    const payload = await (await fetch('/api/stocklist')).json();
    if (!payload.success || !payload.stocks?.length) throw new Error('종목 목록을 불러오지 못했습니다.');
    state.stocks = payload.stocks;
  }

  async function runScan() {
    const button = document.getElementById('btnReverse112Scan');
    const status = document.getElementById('reverse112Status');
    const results = document.getElementById('reverse112Results');
    const wrap = document.getElementById('reverse112ProgressWrap');
    const bar = document.getElementById('reverse112Progress');
    const count = document.getElementById('reverse112ProgressText');
    const minScore = Number(document.getElementById('reverse112MinScore').value);
    const recentDays = Number(document.getElementById('reverse112RecentDays').value);
    button.disabled = true; button.querySelector('span:last-child').textContent = '분석 중...'; wrap.style.display = 'flex';
    results.innerHTML = '<div class="empty-state"><span>⏳</span><p>448일 이평까지 계산하고 있습니다...</p></div>';
    try {
      await loadStocks();
      const found = [], batchSize = 8;
      for (let i = 0; i < state.stocks.length; i += batchSize) {
        const batch = state.stocks.slice(i, i + batchSize);
        const rows = await (await fetch(`/api/batch?codes=${batch.map(stock => stock.code).join(',')}&months=${state.months}`)).json();
        for (const row of rows) {
          const stock = batch.find(item => item.code === row.code);
          if (!stock || row.data?.length < 449) continue;
          const signal = analyzeReverseMa112(row.data, { minScore, recentDays }, stock);
          if (signal) found.push({ stock, data: row.data, signal });
        }
        const done = Math.min(i + batchSize, state.stocks.length);
        bar.style.width = `${done / state.stocks.length * 100}%`; count.textContent = `${done} / ${state.stocks.length}`;
        status.textContent = `분석 중... ${found.length}건`;
      }
      state.matches = found.sort((a, b) => b.signal.score - a.signal.score);
      renderResults(); status.textContent = found.length ? `✅ ${found.length}건 포착` : '조건 충족 종목 없음';
    } catch (error) {
      console.error(error); status.textContent = '검색 오류';
      results.innerHTML = `<div class="no-match-msg">검색하지 못했습니다.<div class="tip">${error.message}</div></div>`;
    } finally {
      button.disabled = false; button.querySelector('span:last-child').textContent = '역매공파 112 다시 검색'; wrap.style.display = 'none';
    }
  }

  function renderResults() {
    const element = document.getElementById('reverse112Results');
    if (!state.matches.length) {
      element.innerHTML = '<div class="no-match-msg">현재 기준을 통과한 종목이 없습니다.<div class="tip">장기 역배열 종목의 전환은 드물기 때문에 신호가 없는 날이 정상입니다.</div></div>';
      return;
    }
    element.innerHTML = state.matches.map((match, index) => `<div class="match-item reverse112-item" data-idx="${index}" style="border-left:2px solid ${COLOR}"><div class="match-header"><span class="match-name">${match.stock.name}</span><span class="match-reliability" style="color:${COLOR};border-color:${COLOR}">${match.signal.grade} · ${match.signal.score}점</span></div><div class="match-signal-date">${match.signal.date} · ${match.signal.stage}</div><div class="match-detail">112선 거리 ${match.signal.distance112 >= 0 ? '+' : ''}${match.signal.distance112.toFixed(1)}% · 매집봉 거래량 ${match.signal.accumulation.volumeRatio.toFixed(1)}배</div><div class="match-tags"><span class="match-tag" style="background:${COLOR};color:#06202d">역배열 전환</span><span class="match-tag">손절폭 ${match.signal.riskPct.toFixed(1)}%</span></div></div>`).join('');
    element.querySelectorAll('.reverse112-item').forEach(item => item.addEventListener('click', () => selectMatch(Number(item.dataset.idx))));
    selectMatch(0);
  }

  function lineData(data, period) {
    return data.map((row, index) => ({ time: formatDate(row.date), value: ma(data, index, period) })).filter(row => row.value);
  }

  function initChart() {
    const element = document.getElementById('reverse112Chart'); element.innerHTML = '';
    state.chart = LightweightCharts.createChart(element, { layout: { background: { type: 'solid', color: '#080b12' }, textColor: '#8492a6', fontFamily: "'Inter','Noto Sans KR',sans-serif", fontSize: 11 }, grid: { vertLines: { color: '#141c28' }, horzLines: { color: '#141c28' } }, rightPriceScale: { borderColor: '#1e293b', scaleMargins: { top: .05, bottom: .25 } }, timeScale: { borderColor: '#1e293b', rightOffset: 3, barSpacing: 6 } });
    state.candle = state.chart.addCandlestickSeries({ upColor: '#ff4757', downColor: '#3b82f6', borderUpColor: '#ff4757', borderDownColor: '#3b82f6', wickUpColor: '#ff4757', wickDownColor: '#3b82f6' });
    state.lines.ma20 = state.chart.addLineSeries({ color: '#facc15', lineWidth: 1, title: 'MA20', priceLineVisible: false });
    state.lines.ma60 = state.chart.addLineSeries({ color: '#22c55e', lineWidth: 1, title: 'MA60', priceLineVisible: false });
    state.lines.ma112 = state.chart.addLineSeries({ color: COLOR, lineWidth: 2, title: 'MA112', priceLineVisible: false });
    state.lines.ma224 = state.chart.addLineSeries({ color: '#a78bfa', lineWidth: 1, title: 'MA224', priceLineVisible: false });
    state.lines.ma448 = state.chart.addLineSeries({ color: '#f97316', lineWidth: 1, title: 'MA448', priceLineVisible: false });
    state.volume = state.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume' });
    state.chart.priceScale('volume').applyOptions({ scaleMargins: { top: .82, bottom: 0 }, borderVisible: false });
    new ResizeObserver(() => state.chart.applyOptions({ width: element.clientWidth, height: element.clientHeight })).observe(element);
  }

  function selectMatch(index) {
    const match = state.matches[index]; if (!match) return;
    document.querySelectorAll('.reverse112-item').forEach(item => item.classList.toggle('active', Number(item.dataset.idx) === index));
    initChart();
    state.candle.setData(match.data.map(row => ({ time: formatDate(row.date), open: row.open, high: row.high, low: row.low, close: row.close })));
    [20, 60, 112, 224, 448].forEach(period => state.lines[`ma${period}`].setData(lineData(match.data, period)));
    state.volume.setData(match.data.map(row => ({ time: formatDate(row.date), value: row.volume, color: row.close >= row.open ? 'rgba(255,71,87,.28)' : 'rgba(59,130,246,.28)' })));
    const markers = [{ time: match.signal.accumulation.date, position: 'belowBar', color: '#facc15', shape: 'arrowUp', text: '매집봉' }, { time: match.signal.date, position: 'belowBar', color: COLOR, shape: 'arrowUp', text: match.signal.stage }];
    if (match.signal.crossDate && match.signal.crossDate !== match.signal.date) markers.push({ time: match.signal.crossDate, position: 'aboveBar', color: COLOR, shape: 'circle', text: '112 돌파' });
    state.candle.setMarkers(markers.sort((a, b) => a.time.localeCompare(b.time))); state.chart.timeScale().fitContent();
    document.getElementById('currentStockName').textContent = match.stock.name;
    document.getElementById('currentStockCode').textContent = `${match.stock.code} | ${match.stock.market}`;
    document.getElementById('currentPrice').textContent = `${match.signal.close.toLocaleString()}원`;
    document.getElementById('priceChange').textContent = `방어선 ${match.signal.stopPrice.toLocaleString()}원`;
    const p = match.signal.parts;
    document.getElementById('reverse112Signals').innerHTML = `<div class="signal-item" style="border-left:3px solid ${COLOR}"><div class="signal-date" style="color:${COLOR};font-weight:700">🧱 ${match.signal.stage} · ${match.signal.score}/100점</div><div class="signal-detail">장기 역배열 ${p.reverse}/20 · 단기선 회복 ${p.recovery}/20<br>매집봉 ${p.accumulation}/20 · 112일선 ${p.line112}/20<br>바닥·볼린저 ${p.base}/10 · 위험관리 ${p.risk}/10${match.signal.penalty ? ` · 감점 -${match.signal.penalty}` : ''}<br><br>MA20 ${Math.round(match.signal.ma20).toLocaleString()} · MA60 ${Math.round(match.signal.ma60).toLocaleString()}<br>MA112 ${Math.round(match.signal.ma112).toLocaleString()} · MA224 ${Math.round(match.signal.ma224).toLocaleString()} · MA448 ${Math.round(match.signal.ma448).toLocaleString()}<br>매집봉 ${match.signal.accumulation.date}: 몸통 ${match.signal.accumulation.bodyPct.toFixed(1)}%, 거래량 ${match.signal.accumulation.volumeRatio.toFixed(1)}배<br><b>계획 방어선 ${match.signal.stopPrice.toLocaleString()}원 (${match.signal.riskPct.toFixed(1)}%)</b></div></div>`;
  }

  function showTab() {
    document.querySelectorAll('.sidebar-tab').forEach(element => element.classList.toggle('active', element.dataset.tab === 'reverse112'));
    document.querySelectorAll('.tab-content').forEach(element => { element.classList.remove('active'); element.style.display = 'none'; });
    const tab = document.getElementById('tabReverse112'); tab.classList.add('active'); tab.style.display = 'flex';
    document.querySelectorAll('.chart-container').forEach(element => { element.style.display = 'none'; }); document.getElementById('reverse112Chart').style.display = 'block';
    document.querySelectorAll('.signals-list').forEach(element => { element.style.display = 'none'; }); document.getElementById('reverse112Signals').style.display = 'block';
    document.querySelectorAll('.signal-legend').forEach(element => { element.style.display = 'none'; });
    document.querySelectorAll('.strategy-card').forEach(element => { element.style.display = 'none'; }); document.getElementById('reverse112Strategy').style.display = 'block';
  }

  function injectUi() {
    document.querySelector('.sidebar-tabs').insertAdjacentHTML('beforeend', `<button class="sidebar-tab" data-tab="reverse112" style="color:${COLOR}">🧱 역매공파 112</button>`);
    document.getElementById('sidebar').insertAdjacentHTML('beforeend', `<div class="tab-content" id="tabReverse112" style="display:none"><div class="sidebar-header"><button class="btn-scan" id="btnReverse112Scan" style="width:100%;background:linear-gradient(135deg,#0ea5e9,#0369a1);margin-bottom:10px"><span>🧱</span> <span>역매공파 112 검색</span></button><div class="scan-status"><span class="status-dot idle"></span><span id="reverse112Status">스캔 대기 중</span></div></div><div class="scan-progress-wrap" id="reverse112ProgressWrap" style="display:none"><div class="progress-bar"><div class="progress-fill" id="reverse112Progress" style="background:${COLOR}"></div></div><span class="progress-text" id="reverse112ProgressText">0 / 0</span></div><div class="param-group" style="padding:8px 12px;font-size:11px"><label>최소 점수 <input id="reverse112MinScore" type="number" min="60" max="90" step="5" value="80" style="width:48px">점</label><label>최근 <input id="reverse112RecentDays" type="number" min="1" max="10" value="3" style="width:48px">거래일</label></div><div class="match-results" id="reverse112Results"><div class="empty-state"><span>🧱</span><p>장기 역배열에서 매집봉이 나온 뒤<br>112일선을 공략하는 종목을 찾습니다.</p></div></div></div>`);
    document.querySelector('.chart-section').insertAdjacentHTML('beforeend', '<div class="chart-container" id="reverse112Chart" style="display:none"></div>');
    document.querySelector('.signals-card').insertAdjacentHTML('beforeend', '<div class="signals-list" id="reverse112Signals" style="display:none"><div class="empty-state"><span>📭</span><p>검색 결과를 클릭하면<br>역배열 전환 구조가 표시됩니다.</p></div></div>');
    document.querySelector('.analysis-panel').insertAdjacentHTML('beforeend', `<div class="panel-card strategy-card" id="reverse112Strategy" style="display:none"><h3 style="color:${COLOR}">🧱 영상 기법을 계산식으로 바꾼 원칙</h3><div class="strategy-steps"><div class="step"><span class="step-num" style="background:#f97316">1</span><span><b>바닥 후보:</b> 112·224·448일선 장기 역배열</span></div><div class="step"><span class="step-num" style="background:#facc15;color:#111">2</span><span><b>매집 흔적:</b> 90일 안에 3% 양봉·평균 1.7배 거래량·10억 이상</span></div><div class="step"><span class="step-num" style="background:#22c55e">3</span><span><b>추세 회복:</b> 종가가 20·60일선 위에 안착</span></div><div class="step"><span class="step-num" style="background:${COLOR};color:#06202d">4</span><span><b>타점:</b> 112일선 ±6% 또는 최근 돌파 후 눌림</span></div><div class="step"><span class="step-num" style="background:#ef4444">5</span><span><b>방어:</b> 60·112일선/최근 저점을 종가로 이탈하면 무효, 계좌 위험 1% 이내로 수량 조절</span></div><div class="step"><span class="step-num" style="background:#64748b">6</span><span><b>주의:</b> 영상의 3.5% 손절·20% 수익은 사례이며 종목별 변동성이 다름</span></div></div></div>`);
    const button = document.querySelector('[data-tab="reverse112"]'); button.addEventListener('click', () => setTimeout(showTab, 0));
    document.getElementById('btnReverse112Scan').addEventListener('click', runScan);
  }

  if (typeof window !== 'undefined') window.analyzeReverseMa112 = analyzeReverseMa112;
  if (typeof module !== 'undefined') module.exports = { analyzeReverseMa112, scoreReverseMa112 };
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', injectUi);
})();
