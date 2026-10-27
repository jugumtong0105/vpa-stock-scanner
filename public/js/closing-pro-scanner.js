/* 종가배팅 PRO: 거래대금·종가강도·추세·돌파·과열위험을 합산한 100점 스캐너 */
(function () {
  'use strict';

  const COLOR = '#a78bfa';
  const state = { stocks: [], matches: [], chart: null, candle: null, volume: null, ma5: null, ma20: null, months: 6 };

  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const ma = (data, index, period) => index >= period - 1 ? average(data.slice(index - period + 1, index + 1).map(row => row.close)) : null;
  const formatDate = value => `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}`;
  const pct = value => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  const money = value => value >= 100000000000 ? `${(value / 100000000000).toFixed(1)}천억` : `${(value / 100000000).toFixed(0)}억`;

  function atr(data, index, period = 14) {
    if (index < period) return 0;
    const ranges = [];
    for (let i = index - period + 1; i <= index; i++) {
      const previousClose = data[i - 1].close;
      ranges.push(Math.max(data[i].high - data[i].low, Math.abs(data[i].high - previousClose), Math.abs(data[i].low - previousClose)));
    }
    return average(ranges);
  }

  function scoreClosingCandle(data, index, stock = {}) {
    if (!Array.isArray(data) || index < 60 || index >= data.length) return null;
    const today = data[index], previous = data[index - 1];
    const range = Math.max(today.high - today.low, 1);
    const dailyReturn = (today.close / previous.close - 1) * 100;
    const closeLocation = (today.close - today.low) / range;
    const bodyRatio = Math.max(0, today.close - today.open) / range;
    const upperWickRatio = (today.high - Math.max(today.open, today.close)) / range;
    const gapPct = (today.open / previous.close - 1) * 100;
    const avgVolume20 = average(data.slice(index - 20, index).map(row => row.volume));
    const volumeRatio = avgVolume20 ? today.volume / avgVolume20 : 0;
    const tradeValue = today.close * today.volume;
    const ma5 = ma(data, index, 5), ma20 = ma(data, index, 20), ma60 = ma(data, index, 60);
    const priorMa20 = ma(data, index - 5, 20);
    const priorHigh20 = Math.max(...data.slice(index - 20, index).map(row => row.high));
    const highProximity = today.close / priorHigh20;
    const return20 = (today.close / data[index - 20].close - 1) * 100;
    const atrPct = atr(data, index) / today.close * 100;
    const extension = today.close / ma20;
    const stopPrice = Math.round(Math.max(today.low, today.close * 0.965));

    if (today.close < 1000 || dailyReturn < 2 || dailyReturn > 12 || tradeValue < 3000000000 ||
        closeLocation < 0.62 || closeLocation > 0.86 || volumeRatio < 1.15 || today.close <= ma20 ||
        highProximity >= 1.02 || extension >= 1.2 || return20 >= 45 ||
        stock.tradable === false || stock.management || (stock.marketAlertType && stock.marketAlertType !== '00')) return null;

    const parts = { close: 0, flow: 0, trend: 0, breakout: 0, momentum: 0, risk: 0 };
    parts.close += closeLocation >= 0.65 && closeLocation < 0.8 ? 15 : closeLocation < 0.65 ? 5 : 8;
    parts.close += bodyRatio >= 0.35 && bodyRatio <= 0.7 ? 5 : bodyRatio > 0.7 ? 3 : 1;
    parts.flow += volumeRatio >= 1.5 && volumeRatio < 3 ? 10 : volumeRatio >= 3 ? 8 : volumeRatio >= 1.2 ? 5 : 2;
    parts.flow += tradeValue >= 100000000000 ? 10 : tradeValue >= 30000000000 ? 8 : tradeValue >= 10000000000 ? 6 : tradeValue >= 5000000000 ? 4 : 2;
    if (today.close > ma5) parts.trend += 4;
    if (ma5 > ma20) parts.trend += 4;
    if (ma20 > priorMa20) parts.trend += 4;
    if (today.close > ma60) parts.trend += 3;
    parts.trend += extension < 1.05 ? 3 : extension < 1.12 ? 2 : 0;
    if (return20 >= 0 && return20 < 25) parts.trend += 2;
    parts.breakout = highProximity >= 0.9 && highProximity < 0.95 ? 15 : highProximity >= 0.95 && highProximity < 0.98 ? 12 : highProximity >= 0.85 && highProximity < 0.9 ? 10 : highProximity < 1 ? 7 : 2;
    parts.momentum += dailyReturn >= 4 && dailyReturn <= 9 ? 10 : dailyReturn >= 3 && dailyReturn <= 10 ? 8 : 4;
    parts.momentum += gapPct >= 0 && gapPct <= 5 ? 3 : gapPct < 0 ? 1 : 0;
    if (atrPct >= 2 && atrPct <= 8) parts.momentum += 2;
    parts.risk += upperWickRatio >= 0.18 && upperWickRatio <= 0.35 ? 3 : upperWickRatio >= 0.1 && upperWickRatio <= 0.45 ? 1 : 0;
    parts.risk += return20 < 10 ? 3 : return20 < 25 ? 1 : 0;
    if ((today.close - stopPrice) / today.close <= 0.035) parts.risk += 2;
    if (volumeRatio <= 4) parts.risk += 2;

    let penalty = 0;
    if (closeLocation >= 0.82) penalty += 6;
    if (highProximity >= 1) penalty += 10;
    if (extension >= 1.12) penalty += 6;
    if (gapPct > 5) penalty += 8;
    if (atrPct > 12) penalty += 6;
    if (return20 >= 25) penalty += 6;
    if (dailyReturn > 10) penalty += 4;
    const score = Math.max(0, Math.min(100, Object.values(parts).reduce((sum, value) => sum + value, 0) - penalty));

    return {
      date: formatDate(today.date), score, grade: score >= 85 ? 'S' : score >= 75 ? 'A' : 'B', parts, penalty,
      close: today.close, stopPrice, dailyReturn, closeLocation, bodyRatio, upperWickRatio, gapPct,
      volumeRatio, tradeValue, ma5, ma20, ma60, highProximity, return20, atrPct, extension
    };
  }

  function analyzeClosingPro(data, options = {}, stock = {}) {
    const minScore = Number(options.minScore ?? 70);
    const recentDays = Math.max(1, Number(options.recentDays ?? 1));
    let best = null;
    for (let index = data.length - 1; index >= Math.max(60, data.length - recentDays); index--) {
      const signal = scoreClosingCandle(data, index, stock);
      if (signal && signal.score >= minScore && (!best || signal.score > best.score)) best = signal;
    }
    return best;
  }

  async function loadStocks() {
    if (state.stocks.length) return;
    const response = await fetch('/api/stocklist');
    const payload = await response.json();
    if (!payload.success || !payload.stocks?.length) throw new Error('종목 목록이 비어 있습니다. 잠시 뒤 다시 시도해 주세요.');
    state.stocks = payload.stocks;
  }

  async function runScan() {
    const button = document.getElementById('btnClosingProScan');
    const status = document.getElementById('closingProStatus');
    const results = document.getElementById('closingProResults');
    const progressWrap = document.getElementById('closingProProgressWrap');
    const progress = document.getElementById('closingProProgress');
    const progressText = document.getElementById('closingProProgressText');
    const minScore = Number(document.getElementById('closingProMinScore').value);
    const recentDays = Number(document.getElementById('closingProRecentDays').value);
    button.disabled = true;
    button.querySelector('span:last-child').textContent = '분석 중...';
    progressWrap.style.display = 'flex';
    results.innerHTML = '<div class="empty-state"><span>⏳</span><p>거래대금 상위 종목을 점수화하고 있습니다...</p></div>';
    try {
      await loadStocks();
      const found = [], batchSize = 10;
      for (let i = 0; i < state.stocks.length; i += batchSize) {
        const batch = state.stocks.slice(i, i + batchSize);
        const response = await fetch(`/api/batch?codes=${batch.map(stock => stock.code).join(',')}&months=${state.months}`);
        const rows = await response.json();
        for (const row of rows) {
          const stock = batch.find(item => item.code === row.code);
          if (!stock || !row.data?.length) continue;
          const signal = analyzeClosingPro(row.data, { minScore, recentDays }, stock);
          if (signal) found.push({ stock, data: row.data, signal });
        }
        const done = Math.min(i + batchSize, state.stocks.length);
        progress.style.width = `${done / state.stocks.length * 100}%`;
        progressText.textContent = `${done} / ${state.stocks.length}`;
        status.textContent = `분석 중... ${found.length}건`;
      }
      state.matches = found.sort((a, b) => b.signal.score - a.signal.score || b.signal.tradeValue - a.signal.tradeValue);
      renderResults();
      status.textContent = found.length ? `✅ ${found.length}건 포착 · 점수순` : '조건 충족 종목 없음';
    } catch (error) {
      console.error(error);
      status.textContent = '검색 오류';
      results.innerHTML = `<div class="no-match-msg">검색하지 못했습니다.<div class="tip">${error.message}</div></div>`;
    } finally {
      button.disabled = false;
      button.querySelector('span:last-child').textContent = '종가배팅 PRO 다시 검색';
      progressWrap.style.display = 'none';
    }
  }

  function renderResults() {
    const element = document.getElementById('closingProResults');
    if (!state.matches.length) {
      element.innerHTML = '<div class="no-match-msg">오늘은 기준을 통과한 종목이 없습니다.<div class="tip">신호가 없는 날은 쉬는 것도 전략입니다.</div></div>';
      return;
    }
    element.innerHTML = state.matches.map((match, index) => `<div class="match-item closing-pro-item" data-idx="${index}" style="border-left:2px solid ${COLOR}">
      <div class="match-header"><span class="match-name">${match.stock.name}</span><span class="match-reliability" style="color:${COLOR};border-color:${COLOR}">${match.signal.grade} · ${match.signal.score}점</span></div>
      <div class="match-signal-date">${match.signal.date} · ${match.stock.market}</div>
      <div class="match-detail">등락 ${pct(match.signal.dailyReturn)} · 거래대금 ${money(match.signal.tradeValue)} · 거래량 ${match.signal.volumeRatio.toFixed(1)}배</div>
      <div class="match-tags"><span class="match-tag" style="background:${COLOR};color:#130b24">종가 ${Math.round(match.signal.closeLocation * 100)}%</span><span class="match-tag">20일 고점 ${Math.round(match.signal.highProximity * 100)}%</span></div>
    </div>`).join('');
    element.querySelectorAll('.closing-pro-item').forEach(item => item.addEventListener('click', () => selectMatch(Number(item.dataset.idx))));
    selectMatch(0);
  }

  function initChart() {
    const element = document.getElementById('closingProChart');
    element.innerHTML = '';
    state.chart = LightweightCharts.createChart(element, {
      layout: { background: { type: 'solid', color: '#080b12' }, textColor: '#8492a6', fontFamily: "'Inter','Noto Sans KR',sans-serif", fontSize: 11 },
      grid: { vertLines: { color: '#141c28' }, horzLines: { color: '#141c28' } },
      rightPriceScale: { borderColor: '#1e293b', scaleMargins: { top: 0.05, bottom: 0.25 } },
      timeScale: { borderColor: '#1e293b', rightOffset: 3, barSpacing: 8 }
    });
    state.candle = state.chart.addCandlestickSeries({ upColor: '#ff4757', downColor: '#3b82f6', borderUpColor: '#ff4757', borderDownColor: '#3b82f6', wickUpColor: '#ff4757', wickDownColor: '#3b82f6' });
    state.ma5 = state.chart.addLineSeries({ color: '#facc15', lineWidth: 2, title: 'MA5', priceLineVisible: false });
    state.ma20 = state.chart.addLineSeries({ color: COLOR, lineWidth: 2, title: 'MA20', priceLineVisible: false });
    state.volume = state.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume' });
    state.chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });
    new ResizeObserver(() => state.chart.applyOptions({ width: element.clientWidth, height: element.clientHeight })).observe(element);
  }

  function lineData(data, period) {
    return data.map((row, index) => ({ time: formatDate(row.date), value: ma(data, index, period) })).filter(row => row.value);
  }

  function selectMatch(index) {
    const match = state.matches[index];
    if (!match) return;
    document.querySelectorAll('.closing-pro-item').forEach(item => item.classList.toggle('active', Number(item.dataset.idx) === index));
    initChart();
    state.candle.setData(match.data.map(row => ({ time: formatDate(row.date), open: row.open, high: row.high, low: row.low, close: row.close })));
    state.ma5.setData(lineData(match.data, 5));
    state.ma20.setData(lineData(match.data, 20));
    state.volume.setData(match.data.map(row => ({ time: formatDate(row.date), value: row.volume, color: row.close >= row.open ? 'rgba(255,71,87,.3)' : 'rgba(59,130,246,.3)' })));
    state.candle.setMarkers([{ time: match.signal.date, position: 'belowBar', color: COLOR, shape: 'arrowUp', text: `${match.signal.grade} ${match.signal.score}점` }]);
    state.chart.timeScale().fitContent();
    document.getElementById('currentStockName').textContent = match.stock.name;
    document.getElementById('currentStockCode').textContent = `${match.stock.code} | ${match.stock.market}`;
    document.getElementById('currentPrice').textContent = `${match.signal.close.toLocaleString()}원`;
    document.getElementById('priceChange').textContent = `방어선 ${match.signal.stopPrice.toLocaleString()}원`;
    const p = match.signal.parts;
    document.getElementById('closingProSignals').innerHTML = `<div class="signal-item" style="border-left:3px solid ${COLOR}"><div class="signal-date" style="color:${COLOR};font-weight:700">⚡ ${match.signal.grade}등급 · ${match.signal.score}/100점</div><div class="signal-detail">종가강도 ${p.close}/20 · 거래량/대금 ${p.flow}/20<br>추세 ${p.trend}/20 · 돌파 ${p.breakout}/15<br>모멘텀 ${p.momentum}/15 · 위험관리 ${p.risk}/10${match.signal.penalty ? ` · 과열감점 -${match.signal.penalty}` : ''}<br><br>종가 위치 ${Math.round(match.signal.closeLocation * 100)}% · 윗꼬리 ${Math.round(match.signal.upperWickRatio * 100)}%<br>20일 수익률 ${pct(match.signal.return20)} · ATR ${match.signal.atrPct.toFixed(1)}%<br><b>계획 손절선: ${match.signal.stopPrice.toLocaleString()}원 (당일 저가 또는 -3.5% 중 가까운 값)</b></div></div>`;
  }

  function showTab() {
    document.querySelectorAll('.sidebar-tab').forEach(element => element.classList.toggle('active', element.dataset.tab === 'closingpro'));
    document.querySelectorAll('.tab-content').forEach(element => { element.classList.remove('active'); element.style.display = 'none'; });
    const tab = document.getElementById('tabClosingPro'); tab.classList.add('active'); tab.style.display = 'flex';
    document.querySelectorAll('.chart-container').forEach(element => { element.style.display = 'none'; });
    document.getElementById('closingProChart').style.display = 'block';
    document.querySelectorAll('.signals-list').forEach(element => { element.style.display = 'none'; });
    document.getElementById('closingProSignals').style.display = 'block';
    document.querySelectorAll('.signal-legend').forEach(element => { element.style.display = 'none'; });
    document.querySelectorAll('.strategy-card').forEach(element => { element.style.display = 'none'; });
    document.getElementById('closingProStrategy').style.display = 'block';
  }

  function injectUi() {
    document.querySelector('.sidebar-tabs').insertAdjacentHTML('beforeend', `<button class="sidebar-tab" data-tab="closingpro" style="color:${COLOR}">⚡ 종가배팅 PRO</button>`);
    document.getElementById('sidebar').insertAdjacentHTML('beforeend', `<div class="tab-content" id="tabClosingPro" style="display:none"><div class="sidebar-header"><button class="btn-scan" id="btnClosingProScan" style="width:100%;background:linear-gradient(135deg,#8b5cf6,#6d28d9);margin-bottom:10px"><span>⚡</span> <span>종가배팅 PRO 검색</span></button><div class="scan-status"><span class="status-dot idle"></span><span id="closingProStatus">스캔 대기 중</span></div></div><div class="scan-progress-wrap" id="closingProProgressWrap" style="display:none"><div class="progress-bar"><div class="progress-fill" id="closingProProgress" style="background:${COLOR}"></div></div><span class="progress-text" id="closingProProgressText">0 / 0</span></div><div class="param-group" style="padding:8px 12px;font-size:11px"><label>최소 점수 <input id="closingProMinScore" type="number" min="60" max="90" step="5" value="70" style="width:48px">점</label><label>최근 <input id="closingProRecentDays" type="number" min="1" max="5" value="1" style="width:48px">거래일</label></div><div class="match-results" id="closingProResults"><div class="empty-state"><span>⚡</span><p><strong>[종가배팅 PRO]</strong> 버튼으로<br>거래대금 상위 정상종목을 점수화하세요.</p></div></div></div>`);
    document.querySelector('.chart-section').insertAdjacentHTML('beforeend', '<div class="chart-container" id="closingProChart" style="display:none"></div>');
    document.querySelector('.signals-card').insertAdjacentHTML('beforeend', '<div class="signals-list" id="closingProSignals" style="display:none"><div class="empty-state"><span>📭</span><p>검색 결과를 클릭하면<br>점수와 위험 기준이 표시됩니다.</p></div></div>');
    document.querySelector('.analysis-panel').insertAdjacentHTML('beforeend', `<div class="panel-card strategy-card" id="closingProStrategy" style="display:none"><h3 style="color:${COLOR}">⚡ 종가배팅 PRO 실행 원칙</h3><div class="strategy-steps"><div class="step"><span class="step-num" style="background:#8b5cf6">1</span><span><b>15:20 재확인:</b> 70점 이상·거래대금·종가 위치가 유지되는지 확인</span></div><div class="step"><span class="step-num" style="background:#8b5cf6">2</span><span><b>분할 진입:</b> 한 종목 몰입 금지, 신호봉 종가 추격 비중 제한</span></div><div class="step"><span class="step-num" style="background:#10b981">3</span><span><b>다음 날:</b> 큰 갭 상승은 추격하지 말고 일부 이익 실현, 갭 하락은 회복 확인</span></div><div class="step"><span class="step-num" style="background:#ef4444">4</span><span><b>손절:</b> 신호봉 저가 또는 -3.5% 중 가까운 선을 계획 손절로 사용</span></div><div class="step"><span class="step-num" style="background:#64748b">5</span><span><b>주의:</b> 확률형 보조도구이며 뉴스·공시·시장 급변은 별도 확인</span></div></div></div>`);
    const button = document.querySelector('[data-tab="closingpro"]');
    button.addEventListener('click', () => setTimeout(showTab, 0));
    document.getElementById('btnClosingProScan').addEventListener('click', runScan);
  }

  if (typeof window !== 'undefined') window.analyzeClosingPro = analyzeClosingPro;
  if (typeof module !== 'undefined') module.exports = { analyzeClosingPro, scoreClosingCandle };
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', injectUi);
})();
