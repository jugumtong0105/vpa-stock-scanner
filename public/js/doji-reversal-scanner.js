/* 장대음봉 → 도지 → 장대양봉(모닝 도지 반전) 스캐너 */
(function () {
  'use strict';

  const COLOR = '#22c55e';
  const state = { stocks: [], matches: [], chart: null, candle: null, volume: null, months: 12 };

  function formatDate(date) {
    const value = String(date);
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }

  function candleMetrics(candle) {
    const range = Math.max(candle.high - candle.low, Number.EPSILON);
    const body = Math.abs(candle.close - candle.open);
    return { range, body, bodyPct: body / candle.open * 100, bodyToRange: body / range };
  }

  /**
   * 2026-07-29~31 이수페타시스·주성엔지니어링·심텍 공통 패턴
   * 1) 장대음봉: 시가 대비 몸통 8.5% 이상
   * 2) 멈춤봉(준도지): 첫날보다 몸통이 작고 6% 이하이며 저가를 재확인
   * 3) 장대양봉: 6% 이상 + 멈춤봉 고가 위 갭 상승 + 첫 음봉 몸통 절반 이상 회복
   */
  function analyzeDojiReversal(data, options = {}) {
    const p = {
      bearishBodyPct: Number(options.bearishBodyPct ?? 8.5),
      pauseBodyPct: Number(options.pauseBodyPct ?? 6),
      pauseVsBearRatio: Number(options.pauseVsBearRatio ?? 0.65),
      bullishBodyPct: Number(options.bullishBodyPct ?? 6),
      bullVsBearRatio: Number(options.bullVsBearRatio ?? 0.6),
      recoveryRatio: Number(options.recoveryRatio ?? 0.5),
      recentDays: Number(options.recentDays ?? 5)
    };
    if (!Array.isArray(data) || data.length < 3) return null;

    const firstEnd = Math.max(0, data.length - p.recentDays - 2);
    for (let i = data.length - 3; i >= firstEnd; i--) {
      const bear = data[i], doji = data[i + 1], bull = data[i + 2];
      const bm = candleMetrics(bear), dm = candleMetrics(doji), um = candleMetrics(bull);

      const longBear = bear.close < bear.open && bm.bodyPct >= p.bearishBodyPct;
      const isPause = doji.close <= doji.open && dm.bodyPct <= p.pauseBodyPct &&
        dm.body <= bm.body * p.pauseVsBearRatio && doji.close < bear.close && doji.low <= bear.low * 1.02;
      const longBull = bull.close > bull.open && um.bodyPct >= p.bullishBodyPct &&
        um.body >= bm.body * p.bullVsBearRatio;
      const gapReversal = bull.open > doji.high;
      const recoveryLevel = bear.close + bm.body * p.recoveryRatio;
      const recoversBear = bull.close >= recoveryLevel;

      if (longBear && isPause && longBull && gapReversal && recoversBear) {
        return {
          bearDate: formatDate(bear.date), dojiDate: formatDate(doji.date), signalDate: formatDate(bull.date),
          bearBodyPct: bm.bodyPct, pauseBodyPct: dm.bodyPct,
          bullBodyPct: um.bodyPct, powerRatio: um.body / bm.body,
          gapPct: (bull.open - doji.high) / doji.high * 100,
          recoveryPct: (bull.close - bear.close) / bm.body * 100,
          entryPrice: bull.close, stopPrice: Math.min(bear.low, doji.low),
          volumeRatio: bear.volume ? bull.volume / bear.volume : 0
        };
      }
    }
    return null;
  }

  function params() {
    return {
      bearishBodyPct: document.getElementById('dojiBearPct').value,
      pauseBodyPct: document.getElementById('dojiRatio').value,
      bullishBodyPct: document.getElementById('dojiBullPct').value,
      recentDays: document.getElementById('dojiRecentDays').value
    };
  }

  async function loadStocks() {
    if (state.stocks.length) return;
    const response = await fetch('/api/stocklist');
    const payload = await response.json();
    if (!payload.success || !Array.isArray(payload.stocks)) throw new Error('종목 목록을 불러오지 못했습니다.');
    state.stocks = payload.stocks;
  }

  async function runScan() {
    const button = document.getElementById('btnDojiScan');
    const status = document.getElementById('dojiStatusText');
    const results = document.getElementById('dojiMatchResults');
    const progressWrap = document.getElementById('dojiProgressWrap');
    const progress = document.getElementById('dojiProgressFill');
    const progressText = document.getElementById('dojiProgressText');
    button.disabled = true;
    button.querySelector('span:last-child').textContent = '스캔 중...';
    progressWrap.style.display = 'flex';
    results.innerHTML = '<div class="empty-state"><span>⏳</span><p>패턴을 찾고 있습니다...</p></div>';

    try {
      await loadStocks();
      const found = [];
      const batchSize = 10;
      for (let i = 0; i < state.stocks.length; i += batchSize) {
        const batch = state.stocks.slice(i, i + batchSize);
        const codes = batch.map(stock => stock.code).join(',');
        const response = await fetch(`/api/batch?codes=${codes}&months=${state.months}`);
        const rows = await response.json();
        for (const row of rows) {
          const stock = batch.find(item => item.code === row.code);
          const signal = analyzeDojiReversal(row.data, params());
          if (stock && signal) found.push({ stock, data: row.data, signal });
        }
        const done = Math.min(i + batchSize, state.stocks.length);
        progress.style.width = `${done / state.stocks.length * 100}%`;
        progressText.textContent = `${done} / ${state.stocks.length}`;
        status.textContent = `스캔 중... (${found.length}건 발견)`;
      }
      state.matches = found.sort((a, b) => b.signal.powerRatio - a.signal.powerRatio);
      renderResults();
      status.textContent = found.length ? `✅ ${found.length}건 포착` : '매칭 종목 없음';
    } catch (error) {
      console.error(error);
      status.textContent = '스캔 오류';
      results.innerHTML = `<div class="no-match-msg">데이터를 불러오지 못했습니다.<div class="tip">${error.message}</div></div>`;
    } finally {
      button.disabled = false;
      button.querySelector('span:last-child').textContent = '반전 패턴 다시 스캔';
      progressWrap.style.display = 'none';
    }
  }

  function renderResults() {
    const results = document.getElementById('dojiMatchResults');
    if (!state.matches.length) {
      results.innerHTML = '<div class="no-match-msg">매칭 종목 없음<div class="tip">조건을 조금 완화하거나 다음 거래일에 다시 확인해 보세요.</div></div>';
      return;
    }
    results.innerHTML = state.matches.map((match, index) => `<div class="match-item doji-match-item" data-idx="${index}">
      <div class="match-header"><span class="match-name">${match.stock.name}</span><span class="match-reliability" style="color:${COLOR}">${match.signal.powerRatio.toFixed(2)}배 압도</span></div>
      <div class="match-signal-date">완성일 ${match.signal.signalDate}</div>
      <div class="match-detail">음봉 ${match.signal.bearBodyPct.toFixed(1)}% → 멈춤봉 ${match.signal.pauseBodyPct.toFixed(1)}% → 양봉 ${match.signal.bullBodyPct.toFixed(1)}%</div>
      <div class="match-tags"><span class="match-tag" style="background:${COLOR};color:#08110b">모닝 도지 반전</span><span class="match-tag">${match.stock.market || ''}</span></div>
    </div>`).join('');
    results.querySelectorAll('.doji-match-item').forEach(item => item.addEventListener('click', () => selectMatch(Number(item.dataset.idx))));
    selectMatch(0);
  }

  function initChart() {
    const element = document.getElementById('dojiChartContainer');
    element.innerHTML = '';
    state.chart = LightweightCharts.createChart(element, {
      layout: { background: { type: 'solid', color: '#080b12' }, textColor: '#8492a6', fontFamily: "'Inter','Noto Sans KR',sans-serif", fontSize: 11 },
      grid: { vertLines: { color: '#141c28' }, horzLines: { color: '#141c28' } },
      rightPriceScale: { borderColor: '#1e293b', scaleMargins: { top: 0.05, bottom: 0.25 } },
      timeScale: { borderColor: '#1e293b', rightOffset: 3, barSpacing: 8 }
    });
    state.candle = state.chart.addCandlestickSeries({ upColor: '#ff4757', downColor: '#3b82f6', borderUpColor: '#ff4757', borderDownColor: '#3b82f6', wickUpColor: '#ff4757', wickDownColor: '#3b82f6' });
    state.volume = state.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume' });
    state.chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });
    new ResizeObserver(() => state.chart.applyOptions({ width: element.clientWidth, height: element.clientHeight })).observe(element);
  }

  function selectMatch(index) {
    const match = state.matches[index];
    if (!match) return;
    document.querySelectorAll('.doji-match-item').forEach(item => item.classList.toggle('active', Number(item.dataset.idx) === index));
    initChart();
    state.candle.setData(match.data.map(d => ({ time: formatDate(d.date), open: d.open, high: d.high, low: d.low, close: d.close })));
    state.volume.setData(match.data.map(d => ({ time: formatDate(d.date), value: d.volume, color: d.close >= d.open ? 'rgba(255,71,87,.3)' : 'rgba(59,130,246,.3)' })));
    state.candle.setMarkers([
      { time: match.signal.bearDate, position: 'aboveBar', color: '#3b82f6', shape: 'arrowDown', text: '장대음봉' },
      { time: match.signal.dojiDate, position: 'belowBar', color: '#facc15', shape: 'circle', text: '도지' },
      { time: match.signal.signalDate, position: 'belowBar', color: COLOR, shape: 'arrowUp', text: '반전완성' }
    ]);
    state.chart.timeScale().fitContent();
    document.getElementById('currentStockName').textContent = match.stock.name;
    document.getElementById('currentStockCode').textContent = `${match.stock.code} | ${match.stock.market || ''}`;
    document.getElementById('currentPrice').textContent = `${match.signal.entryPrice.toLocaleString()}원`;
    document.getElementById('priceChange').textContent = `손절기준 ${match.signal.stopPrice.toLocaleString()}원`;
    document.getElementById('dojiSignalsList').innerHTML = `<div class="signal-item" style="border-left:3px solid ${COLOR}"><div class="signal-date" style="color:${COLOR};font-weight:700">🌅 도지형 갭 반전 완성</div><div class="signal-detail">장대음봉 ${match.signal.bearBodyPct.toFixed(2)}%<br>멈춤봉 몸통 ${match.signal.pauseBodyPct.toFixed(2)}%<br>장대양봉 ${match.signal.bullBodyPct.toFixed(2)}% / 음봉 대비 ${match.signal.powerRatio.toFixed(2)}배<br>멈춤봉 고가 대비 갭 ${match.signal.gapPct.toFixed(2)}% / 첫 음봉 회복률 ${match.signal.recoveryPct.toFixed(1)}%<br>양봉 거래량 / 음봉 거래량 ${match.signal.volumeRatio.toFixed(2)}배<br><b>패턴 저가 이탈 손절 기준: ${match.signal.stopPrice.toLocaleString()}원</b></div></div>`;
  }

  function showDojiTab() {
    document.querySelectorAll('.sidebar-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === 'doji'));
    document.querySelectorAll('.tab-content').forEach(el => { el.classList.remove('active'); el.style.display = 'none'; });
    document.getElementById('tabDoji').classList.add('active');
    document.getElementById('tabDoji').style.display = 'flex';
    document.querySelectorAll('.chart-container').forEach(el => { el.style.display = 'none'; });
    document.getElementById('dojiChartContainer').style.display = 'block';
    document.querySelectorAll('.signals-list').forEach(el => { el.style.display = 'none'; });
    document.getElementById('dojiSignalsList').style.display = 'block';
    document.querySelectorAll('.signal-legend').forEach(el => { el.style.display = 'none'; });
    document.querySelectorAll('.strategy-card').forEach(el => { el.style.display = 'none'; });
    document.getElementById('dojiStrategyCard').style.display = 'block';
  }

  function injectUi() {
    document.querySelector('.sidebar-tabs').insertAdjacentHTML('beforeend', '<button class="sidebar-tab" data-tab="doji" style="color:#22c55e">🌅 도지반전</button>');
    document.getElementById('sidebar').insertAdjacentHTML('beforeend', `<div class="tab-content" id="tabDoji" style="display:none"><div class="sidebar-header"><button class="btn-scan" id="btnDojiScan" style="width:100%;background:linear-gradient(135deg,#22c55e,#15803d);margin-bottom:10px"><span>🌅</span> <span>도지 반전 스캔</span></button><div class="scan-status"><span class="status-dot idle"></span><span id="dojiStatusText">스캔 대기 중</span></div></div><div class="scan-progress-wrap" id="dojiProgressWrap" style="display:none"><div class="progress-bar"><div class="progress-fill" id="dojiProgressFill" style="background:${COLOR}"></div></div><span class="progress-text" id="dojiProgressText">0 / 0</span></div><div class="param-group" style="padding:8px 12px;font-size:11px"><label>장대음봉 최소 <input id="dojiBearPct" type="number" min="5" max="15" step=".5" value="8.5" style="width:48px">%</label><label>멈춤봉 몸통 최대 <input id="dojiRatio" type="number" min="1" max="10" step=".5" value="6" style="width:48px">%</label><label>장대양봉 최소 <input id="dojiBullPct" type="number" min="3" max="15" step=".5" value="6" style="width:48px">%</label><label>최근 <input id="dojiRecentDays" type="number" min="1" max="20" value="5" style="width:48px">거래일</label></div><div class="match-results" id="dojiMatchResults"><div class="empty-state"><span>🌅</span><p><strong>[도지 반전 스캔]</strong> 버튼으로<br>장대음봉 → 멈춤봉 → 갭 장대양봉 종목을 찾으세요.</p></div></div></div>`);
    document.querySelector('.chart-section').insertAdjacentHTML('beforeend', '<div class="chart-container" id="dojiChartContainer" style="display:none"></div>');
    document.querySelector('.signals-card').insertAdjacentHTML('beforeend', '<div class="signals-list" id="dojiSignalsList" style="display:none"><div class="empty-state"><span>📭</span><p>매칭 종목을 클릭하면<br>상세 정보가 표시됩니다.</p></div></div>');
    document.querySelector('.analysis-panel').insertAdjacentHTML('beforeend', `<div class="panel-card strategy-card" id="dojiStrategyCard" style="display:none"><h3 style="color:${COLOR}">📖 도지형 갭 반전 원칙</h3><div class="strategy-steps"><div class="step"><span class="step-num" style="background:#3b82f6">1</span><span><b>투매:</b> 8.5% 이상 장대음봉 확인</span></div><div class="step"><span class="step-num" style="background:#facc15;color:#111">2</span><span><b>멈춤:</b> 추가 하락하되 몸통이 6% 이하로 축소</span></div><div class="step"><span class="step-num" style="background:${COLOR}">3</span><span><b>반전:</b> 전일 고가 위 갭 상승 + 6% 이상 장대양봉</span></div><div class="step"><span class="step-num" style="background:#ef4444">4</span><span><b>리스크:</b> 3개 봉의 최저가 이탈 시 무효</span></div></div></div>`);
    const tabButton = document.querySelector('[data-tab="doji"]');
    // 기존 app.js의 공통 탭 처리보다 마지막에 실행해 새 탭 상태를 확정한다.
    tabButton.addEventListener('click', () => setTimeout(showDojiTab, 0));
    document.getElementById('btnDojiScan').addEventListener('click', runScan);
  }

  window.analyzeDojiReversal = analyzeDojiReversal;
  document.addEventListener('DOMContentLoaded', injectUi);
})();
