/* 장대음봉 → 도지 → 장대양봉 또는 상승 장악형 패턴 검색기 */
(function () {
  'use strict';

  const TAB_KEY = 'threecandle';
  const COLOR = '#22c55e';
  const state = {
    stocks: [],
    matches: [],
    months: 12,
    chart: null,
    candleSeries: null,
    volumeSeries: null,
    resizeObserver: null
  };

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function normalizeCandle(candle) {
    return {
      date: String(candle.date),
      open: toNumber(candle.open),
      high: toNumber(candle.high),
      low: toNumber(candle.low),
      close: toNumber(candle.close),
      volume: toNumber(candle.volume)
    };
  }

  function formatDate(date) {
    const value = String(date).replace(/[^0-9]/g, '');
    if (value.length !== 8) return String(date);
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }

  function candleMetrics(candle) {
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    return {
      range,
      body,
      bodyPct: candle.open > 0 ? body / candle.open * 100 : 0,
      bodyToRange: range > 0 ? body / range : Infinity
    };
  }

  function isValidCandle(candle) {
    return candle.open > 0 && candle.high > candle.low && candle.low > 0 &&
      candle.high >= Math.max(candle.open, candle.close) &&
      candle.low <= Math.min(candle.open, candle.close);
  }

  /**
   * 연속된 세 거래일을 검사한다.
   * 1. 장대음봉: 하락 몸통 크기와 몸통/전체 길이 비율을 모두 충족
   * 2. 도지: 바로 다음 캔들의 몸통/전체 길이 비율이 기준 이하
   * 3. 양봉: 장대양봉 또는 첫 장대음봉 몸통을 완전히 덮는 상승 장악형
   */
  function analyzeThreeCandleReversal(rawData, options = {}) {
    const settings = {
      bearishBodyPct: toNumber(options.bearishBodyPct ?? 4),
      dojiBodyRatio: toNumber(options.dojiBodyRatio ?? 0.15),
      bullishBodyPct: toNumber(options.bullishBodyPct ?? 4),
      longBodyRatio: toNumber(options.longBodyRatio ?? 0.6),
      recentDays: Math.max(1, Math.floor(toNumber(options.recentDays ?? 5)))
    };

    if (!Array.isArray(rawData) || rawData.length < 3) return null;
    const data = rawData.map(normalizeCandle);
    const firstSignalIndex = Math.max(2, data.length - settings.recentDays);

    for (let signalIndex = data.length - 1; signalIndex >= firstSignalIndex; signalIndex -= 1) {
      const bear = data[signalIndex - 2];
      const doji = data[signalIndex - 1];
      const bull = data[signalIndex];
      if (![bear, doji, bull].every(isValidCandle)) continue;

      const bearMetrics = candleMetrics(bear);
      const dojiMetrics = candleMetrics(doji);
      const bullMetrics = candleMetrics(bull);

      const isLongBear = bear.close < bear.open &&
        bearMetrics.bodyPct >= settings.bearishBodyPct &&
        bearMetrics.bodyToRange >= settings.longBodyRatio;
      const isDoji = dojiMetrics.bodyToRange <= settings.dojiBodyRatio;
      const isBullish = bull.close > bull.open;
      const isLongBull = isBullish &&
        bullMetrics.bodyPct >= settings.bullishBodyPct &&
        bullMetrics.bodyToRange >= settings.longBodyRatio;
      const engulfsBearBody = isBullish &&
        bull.open <= bear.close &&
        bull.close >= bear.open;

      // 핵심: 장대양봉 OR 첫 장대음봉 몸통을 덮는 양봉
      if (isLongBear && isDoji && (isLongBull || engulfsBearBody)) {
        const signalType = isLongBull && engulfsBearBody
          ? '장대양봉 + 상승 장악형'
          : isLongBull ? '장대양봉' : '상승 장악형';
        return {
          bearDate: formatDate(bear.date),
          dojiDate: formatDate(doji.date),
          signalDate: formatDate(bull.date),
          bearBodyPct: bearMetrics.bodyPct,
          bearBodyRatioPct: bearMetrics.bodyToRange * 100,
          dojiBodyRatioPct: dojiMetrics.bodyToRange * 100,
          bullBodyPct: bullMetrics.bodyPct,
          bullBodyRatioPct: bullMetrics.bodyToRange * 100,
          engulfRatio: bearMetrics.body > 0 ? bullMetrics.body / bearMetrics.body : 0,
          isLongBull,
          engulfsBearBody,
          signalType,
          entryPrice: bull.close,
          stopPrice: Math.min(bear.low, doji.low, bull.low),
          volumeRatio: bear.volume > 0 ? bull.volume / bear.volume : 0
        };
      }
    }
    return null;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function readSettings() {
    return {
      bearishBodyPct: document.getElementById('threeBearPct').value,
      dojiBodyRatio: document.getElementById('threeDojiRatio').value / 100,
      bullishBodyPct: document.getElementById('threeBullPct').value,
      longBodyRatio: document.getElementById('threeLongRatio').value / 100,
      recentDays: document.getElementById('threeRecentDays').value
    };
  }

  async function loadStocks() {
    if (state.stocks.length) return;
    const response = await fetch('/api/stocklist');
    if (!response.ok) throw new Error(`종목 목록 요청 실패 (${response.status})`);
    const payload = await response.json();
    if (!payload.success || !Array.isArray(payload.stocks)) {
      throw new Error('종목 목록 형식이 올바르지 않습니다.');
    }
    state.stocks = payload.stocks;
  }

  function setStatus(message, mode = 'idle') {
    document.getElementById('threeStatusText').textContent = message;
    const dot = document.querySelector('#tabThreeCandle .status-dot');
    dot.className = `status-dot ${mode}`;
  }

  async function runScan() {
    const button = document.getElementById('btnThreeCandleScan');
    const buttonText = button.querySelector('span:last-child');
    const results = document.getElementById('threeMatchResults');
    const progressWrap = document.getElementById('threeProgressWrap');
    const progress = document.getElementById('threeProgressFill');
    const progressText = document.getElementById('threeProgressText');

    button.disabled = true;
    buttonText.textContent = '스캔 중...';
    progressWrap.style.display = 'flex';
    results.innerHTML = '<div class="empty-state"><span>🔎</span><p>연속 3캔들 패턴을 찾고 있습니다...</p></div>';
    setStatus('종목 데이터 불러오는 중...', 'scanning');

    try {
      await loadStocks();
      const found = [];
      const batchSize = 10;
      const settings = readSettings();

      for (let index = 0; index < state.stocks.length; index += batchSize) {
        const batch = state.stocks.slice(index, index + batchSize);
        const codes = batch.map(stock => stock.code).join(',');
        const response = await fetch(`/api/batch?codes=${encodeURIComponent(codes)}&months=${state.months}`);
        if (!response.ok) throw new Error(`차트 데이터 요청 실패 (${response.status})`);
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error('차트 데이터 형식이 올바르지 않습니다.');

        rows.forEach(row => {
          const stock = batch.find(item => String(item.code) === String(row.code));
          const signal = analyzeThreeCandleReversal(row.data, settings);
          if (stock && signal) found.push({ stock, data: row.data, signal });
        });

        const completed = Math.min(index + batchSize, state.stocks.length);
        progress.style.width = `${completed / state.stocks.length * 100}%`;
        progressText.textContent = `${completed} / ${state.stocks.length}`;
        setStatus(`스캔 중... (${found.length}건 발견)`, 'scanning');
      }

      state.matches = found.sort((left, right) =>
        right.signal.signalDate.localeCompare(left.signal.signalDate) ||
        right.signal.engulfRatio - left.signal.engulfRatio
      );
      renderResults();
      setStatus(found.length ? `${found.length}건 포착` : '매칭 종목 없음', found.length ? 'complete' : 'idle');
    } catch (error) {
      console.error(error);
      setStatus('스캔 오류', 'idle');
      results.innerHTML = `<div class="no-match-msg">데이터를 불러오지 못했습니다.<div class="tip">${escapeHtml(error.message)}</div></div>`;
    } finally {
      button.disabled = false;
      buttonText.textContent = '3캔들 반전 다시 스캔';
      progressWrap.style.display = 'none';
    }
  }

  function renderResults() {
    const results = document.getElementById('threeMatchResults');
    if (!state.matches.length) {
      results.innerHTML = '<div class="no-match-msg">매칭 종목 없음<div class="tip">기준값을 완화하거나 다음 거래일에 다시 확인해 보세요.</div></div>';
      return;
    }

    results.innerHTML = state.matches.map((match, index) => `
      <div class="match-item three-match-item" data-index="${index}">
        <div class="match-header">
          <span class="match-name">${escapeHtml(match.stock.name)}</span>
          <span class="match-reliability" style="color:${COLOR}">${escapeHtml(match.signal.signalType)}</span>
        </div>
        <div class="match-signal-date">완성일 ${match.signal.signalDate}</div>
        <div class="match-detail">음봉 ${match.signal.bearBodyPct.toFixed(1)}% → 도지 ${match.signal.dojiBodyRatioPct.toFixed(1)}% → 양봉 ${match.signal.bullBodyPct.toFixed(1)}%</div>
        <div class="match-tags"><span class="match-tag three-tag">3캔들 반전</span><span class="match-tag">${escapeHtml(match.stock.market || '')}</span></div>
      </div>`).join('');

    results.querySelectorAll('.three-match-item').forEach(item => {
      item.addEventListener('click', () => selectMatch(Number(item.dataset.index)));
    });
    selectMatch(0);
  }

  function initChart() {
    const container = document.getElementById('threeChartContainer');
    if (state.resizeObserver) state.resizeObserver.disconnect();
    if (state.chart) state.chart.remove();
    container.innerHTML = '';

    state.chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: 'solid', color: '#080b12' },
        textColor: '#8492a6',
        fontFamily: "'Inter','Noto Sans KR',sans-serif",
        fontSize: 11
      },
      grid: { vertLines: { color: '#141c28' }, horzLines: { color: '#141c28' } },
      rightPriceScale: { borderColor: '#1e293b', scaleMargins: { top: 0.05, bottom: 0.25 } },
      timeScale: { borderColor: '#1e293b', rightOffset: 3, barSpacing: 8 }
    });
    state.candleSeries = state.chart.addCandlestickSeries({
      upColor: '#ff4757', downColor: '#3b82f6',
      borderUpColor: '#ff4757', borderDownColor: '#3b82f6',
      wickUpColor: '#ff4757', wickDownColor: '#3b82f6'
    });
    state.volumeSeries = state.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'threeVolume' });
    state.chart.priceScale('threeVolume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });
    state.resizeObserver = new ResizeObserver(() => {
      state.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
    state.resizeObserver.observe(container);
  }

  function selectMatch(index) {
    const match = state.matches[index];
    if (!match) return;
    document.querySelectorAll('.three-match-item').forEach(item => {
      item.classList.toggle('active', Number(item.dataset.index) === index);
    });

    initChart();
    const candles = match.data.map(normalizeCandle).filter(isValidCandle);
    state.candleSeries.setData(candles.map(candle => ({
      time: formatDate(candle.date), open: candle.open, high: candle.high, low: candle.low, close: candle.close
    })));
    state.volumeSeries.setData(candles.map(candle => ({
      time: formatDate(candle.date),
      value: candle.volume,
      color: candle.close >= candle.open ? 'rgba(255,71,87,.3)' : 'rgba(59,130,246,.3)'
    })));
    state.candleSeries.setMarkers([
      { time: match.signal.bearDate, position: 'aboveBar', color: '#3b82f6', shape: 'arrowDown', text: '장대음봉' },
      { time: match.signal.dojiDate, position: 'belowBar', color: '#facc15', shape: 'circle', text: '도지' },
      { time: match.signal.signalDate, position: 'belowBar', color: COLOR, shape: 'arrowUp', text: match.signal.signalType }
    ]);
    state.chart.timeScale().fitContent();

    document.getElementById('currentStockName').textContent = match.stock.name;
    document.getElementById('currentStockCode').textContent = `${match.stock.code} | ${match.stock.market || ''}`;
    document.getElementById('currentPrice').textContent = `${match.signal.entryPrice.toLocaleString()}원`;
    document.getElementById('priceChange').textContent = `패턴 저가 ${match.signal.stopPrice.toLocaleString()}원`;
    document.getElementById('threeSignalsList').innerHTML = `
      <div class="signal-item" style="border-left:3px solid ${COLOR}">
        <div class="signal-date" style="color:${COLOR};font-weight:700">🎯 ${escapeHtml(match.signal.signalType)} 포착</div>
        <div class="signal-detail">
          장대음봉 몸통 ${match.signal.bearBodyPct.toFixed(2)}% · 전체 대비 ${match.signal.bearBodyRatioPct.toFixed(1)}%<br>
          도지 몸통/전체 ${match.signal.dojiBodyRatioPct.toFixed(1)}%<br>
          양봉 몸통 ${match.signal.bullBodyPct.toFixed(2)}% · 전체 대비 ${match.signal.bullBodyRatioPct.toFixed(1)}%<br>
          양봉/음봉 몸통 크기 ${match.signal.engulfRatio.toFixed(2)}배 · 거래량 ${match.signal.volumeRatio.toFixed(2)}배<br>
          <b>패턴 저가 이탈 확인 기준: ${match.signal.stopPrice.toLocaleString()}원</b>
        </div>
      </div>`;
  }

  function hideThreeCandleUi() {
    const chart = document.getElementById('threeChartContainer');
    const signals = document.getElementById('threeSignalsList');
    const strategy = document.getElementById('threeStrategyCard');
    if (chart) chart.style.display = 'none';
    if (signals) signals.style.display = 'none';
    if (strategy) strategy.style.display = 'none';
  }

  function showThreeCandleTab() {
    document.querySelectorAll('.sidebar-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === TAB_KEY));
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.remove('active');
      content.style.display = 'none';
    });
    const tab = document.getElementById('tabThreeCandle');
    tab.classList.add('active');
    tab.style.display = 'flex';

    document.querySelectorAll('.chart-container').forEach(element => { element.style.display = 'none'; });
    document.getElementById('threeChartContainer').style.display = 'block';
    document.querySelectorAll('.signals-list').forEach(element => { element.style.display = 'none'; });
    document.getElementById('threeSignalsList').style.display = 'block';
    document.querySelectorAll('.signal-legend').forEach(element => { element.style.display = 'none'; });
    document.querySelectorAll('.strategy-card').forEach(element => { element.style.display = 'none'; });
    document.getElementById('threeStrategyCard').style.display = 'block';
    const stockInfoBar = document.getElementById('stockInfoBar');
    if (stockInfoBar) stockInfoBar.style.display = 'flex';
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .sidebar-tabs{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));flex:none;max-height:205px;overflow-y:auto;overflow-x:hidden}
      .sidebar-tabs .sidebar-tab{min-width:0;min-height:38px;padding:7px 5px;white-space:normal;line-height:1.25;word-break:keep-all}
      #tabThreeCandle .three-params{padding:10px 12px;display:grid;gap:7px;font-size:11px;border-bottom:1px solid var(--border-color,#1e293b)}
      #tabThreeCandle .three-param{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--text-secondary,#94a3b8)}
      #tabThreeCandle .three-param input{width:58px;padding:4px 6px;border:1px solid #334155;border-radius:5px;background:#0f172a;color:#e2e8f0;text-align:right}
      #tabThreeCandle .three-rule{padding:9px 12px;color:#94a3b8;font-size:10px;line-height:1.55;background:rgba(34,197,94,.06);border-bottom:1px solid rgba(34,197,94,.18)}
      .three-tag{background:${COLOR}!important;color:#07130b!important}
      .three-match-item .match-reliability{max-width:130px;text-align:right;font-size:10px}
    `;
    document.head.appendChild(style);
  }

  function injectUi() {
    injectStyles();
    document.querySelector('.sidebar-tabs').insertAdjacentHTML('beforeend',
      `<button class="sidebar-tab" data-tab="${TAB_KEY}" style="color:${COLOR}">🎯 3캔들 반전</button>`
    );
    document.getElementById('sidebar').insertAdjacentHTML('beforeend', `
      <div class="tab-content" id="tabThreeCandle" style="display:none">
        <div class="sidebar-header">
          <button class="btn-scan" id="btnThreeCandleScan" style="width:100%;background:linear-gradient(135deg,#22c55e,#15803d);margin-bottom:10px">
            <span>🎯</span> <span>3캔들 반전 스캔</span>
          </button>
          <div class="scan-status"><span class="status-dot idle"></span><span id="threeStatusText">스캔 대기 중</span></div>
        </div>
        <div class="scan-progress-wrap" id="threeProgressWrap" style="display:none">
          <div class="progress-bar"><div class="progress-fill" id="threeProgressFill" style="background:${COLOR}"></div></div>
          <span class="progress-text" id="threeProgressText">0 / 0</span>
        </div>
        <div class="three-rule"><b>연속 3거래일:</b> 장대음봉 → 도지 → 장대양봉 <b>또는</b> 첫 음봉을 덮는 양봉</div>
        <div class="three-params">
          <label class="three-param"><span>장대음봉 몸통 최소</span><span><input id="threeBearPct" type="number" min="1" max="20" step="0.5" value="4"> %</span></label>
          <label class="three-param"><span>도지 몸통/전체 최대</span><span><input id="threeDojiRatio" type="number" min="1" max="40" step="1" value="15"> %</span></label>
          <label class="three-param"><span>장대양봉 몸통 최소</span><span><input id="threeBullPct" type="number" min="1" max="20" step="0.5" value="4"> %</span></label>
          <label class="three-param"><span>장대봉 몸통/전체 최소</span><span><input id="threeLongRatio" type="number" min="30" max="95" step="5" value="60"> %</span></label>
          <label class="three-param"><span>완성 신호 최근 범위</span><span><input id="threeRecentDays" type="number" min="1" max="30" step="1" value="5"> 거래일</span></label>
        </div>
        <div class="match-results" id="threeMatchResults">
          <div class="empty-state"><span>🎯</span><p><strong>[3캔들 반전 스캔]</strong> 버튼으로<br>매도 후 반전 패턴을 찾아보세요.</p></div>
        </div>
      </div>`
    );
    document.querySelector('.chart-section').insertAdjacentHTML('beforeend',
      '<div class="chart-container" id="threeChartContainer" style="display:none"></div>'
    );
    document.querySelector('.signals-card').insertAdjacentHTML('beforeend', `
      <div class="signals-list" id="threeSignalsList" style="display:none">
        <div class="empty-state"><span>💡</span><p>매칭 종목을 클릭하면<br>세 캔들의 상세 조건이 표시됩니다.</p></div>
      </div>`
    );
    document.querySelector('.analysis-panel').insertAdjacentHTML('beforeend', `
      <div class="panel-card strategy-card three-candle-strategy" id="threeStrategyCard" style="display:none">
        <h3 style="color:${COLOR}">📖 3캔들 반전 판정</h3>
        <div class="strategy-steps">
          <div class="step"><span class="step-num" style="background:#3b82f6">1</span><span><b>투매:</b> 몸통이 크고 아래로 닫힌 장대음봉</span></div>
          <div class="step"><span class="step-num" style="background:#facc15;color:#111">2</span><span><b>균형:</b> 바로 다음 거래일에 몸통이 작은 도지</span></div>
          <div class="step"><span class="step-num" style="background:${COLOR}">3</span><span><b>반전:</b> 장대양봉 또는 첫 음봉 몸통을 덮는 양봉</span></div>
          <div class="step"><span class="step-num" style="background:#ef4444">4</span><span><b>확인:</b> 패턴 저가 이탈 여부와 거래량을 함께 점검</span></div>
        </div>
      </div>`
    );

    document.querySelector(`[data-tab="${TAB_KEY}"]`).addEventListener('click', showThreeCandleTab);
    document.getElementById('btnThreeCandleScan').addEventListener('click', runScan);
    document.querySelectorAll(`.sidebar-tab:not([data-tab="${TAB_KEY}"])`).forEach(tab => {
      tab.addEventListener('click', hideThreeCandleUi);
    });
  }

  if (typeof window !== 'undefined') window.analyzeThreeCandleReversal = analyzeThreeCandleReversal;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { analyzeThreeCandleReversal, candleMetrics, normalizeCandle };
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', injectUi);
})();
