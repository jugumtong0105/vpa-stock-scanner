(() => {
  'use strict';
  const Engine = window.AlphaPrimeEngine;
  if (!Engine) return;

  const state = { stocks: [], matches: [], benchmarks: {}, regimes: {}, selected: null, running: false };
  const excluded = /KODEX|TIGER|ACE|RISE|HANARO|KOSEF|KBSTAR|ETN|인버스|레버리지|스팩|우(?:B|C)?$/i;
  const $ = id => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function number(value, digits = 0) {
    return Number(value || 0).toLocaleString('ko-KR', { maximumFractionDigits: digits });
  }

  function gradeColor(grade) {
    return grade === 'S급' ? '#a78bfa' : grade === 'A급' ? '#22c55e' : grade === 'B급' ? '#38bdf8' : '#f59e0b';
  }

  function marketFor(stock) {
    return stock.market === 'KOSDAQ' ? state.benchmarks.KOSDAQ : state.benchmarks.KOSPI;
  }

  async function loadUniverse() {
    if (state.stocks.length) return;
    const response = await fetch('/api/stocklist', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || '종목 목록을 불러오지 못했습니다.');
    state.stocks = payload.stocks.filter(stock => !excluded.test(stock.name));
  }

  async function loadBenchmarks() {
    const [kospiResponse, kosdaqResponse] = await Promise.all([
      fetch('/api/chart/069500?months=15', { cache: 'no-store' }),
      fetch('/api/chart/229200?months=15', { cache: 'no-store' })
    ]);
    const [kospi, kosdaq] = await Promise.all([kospiResponse.json(), kosdaqResponse.json()]);
    state.benchmarks = { KOSPI: kospi.data || [], KOSDAQ: kosdaq.data || [] };
    state.regimes = {
      KOSPI: Engine.getMarketRegime(state.benchmarks.KOSPI),
      KOSDAQ: Engine.getMarketRegime(state.benchmarks.KOSDAQ)
    };
    renderRegimes();
  }

  function renderRegimes() {
    for (const market of ['KOSPI', 'KOSDAQ']) {
      const regime = state.regimes[market] || { label: '확인 중', color: '#94a3b8', return20: 0 };
      const node = $(`alphaRegime${market}`);
      if (node) node.innerHTML = `<span>${market}</span><strong style="color:${regime.color}">${escapeHtml(regime.label)}</strong><small>20일 ${regime.return20 >= 0 ? '+' : ''}${number(regime.return20, 1)}%</small>`;
    }
  }

  function updateProgress(done, total) {
    const percent = total ? Math.min(100, done / total * 100) : 0;
    $('alphaProgressFill').style.width = `${percent}%`;
    $('alphaProgressText').textContent = `${done} / ${total}`;
    $('alphaStatusText').textContent = done < total ? '시장 주도주 점수 계산 중' : '검색 완료';
  }

  async function runScan() {
    if (state.running) return;
    state.running = true;
    const button = $('btnAlphaPrimeScan');
    button.disabled = true;
    button.classList.add('scanning');
    $('btnAlphaPrimeScanText').textContent = '분석 중...';
    $('alphaProgressWrap').style.display = 'flex';
    $('alphaStatusDot').className = 'status-dot scanning';
    $('alphaMatchResults').innerHTML = '<div class="empty-state"><span>🧭</span><p>시장 국면과 전 종목 상대강도를<br>계산하고 있습니다.</p></div>';
    $('alphaResultsBody').innerHTML = '<tr><td colspan="10" class="alpha-empty">시장 주도주를 분석하고 있습니다.</td></tr>';

    try {
      await Promise.all([loadUniverse(), loadBenchmarks()]);
      const matches = [];
      const batchSize = 10;
      for (let index = 0; index < state.stocks.length; index += batchSize) {
        const batch = state.stocks.slice(index, index + batchSize);
        const codes = batch.map(stock => stock.code).join(',');
        try {
          const [chartResponse, sectorResponse] = await Promise.all([
            fetch(`/api/batch?codes=${encodeURIComponent(codes)}&months=15`),
            fetch(`/api/alpha-prime/sectors?codes=${encodeURIComponent(codes)}`)
          ]);
          const [rows, sectorsPayload] = await Promise.all([chartResponse.json(), sectorResponse.json()]);
          const sectorMap = new Map((sectorsPayload.rows || []).map(row => [row.code, row.sector]));
          for (const row of rows) {
            const stock = batch.find(item => item.code === row.code);
            if (!stock || !row.data) continue;
            stock.sector = sectorMap.get(stock.code) || '업종 미분류';
            const signal = Engine.analyzeStock(row.data, stock, marketFor(stock), { minimumScore: 55 });
            if (signal) matches.push(signal);
          }
        } catch (error) {
          console.warn('알파 프라임 배치 실패:', error);
        }
        updateProgress(Math.min(index + batchSize, state.stocks.length), state.stocks.length);
      }
      state.matches = Engine.applySectorLeadership(matches, 55)
        .sort((left, right) => right.score - left.score || right.relative.r60 - left.relative.r60);
      renderResults();
      $('alphaStatusDot').className = 'status-dot done';
      $('alphaStatusText').textContent = `${state.matches.length}개 후보 · 상위 점수순`;
    } catch (error) {
      $('alphaStatusDot').className = 'status-dot error';
      $('alphaStatusText').textContent = error.message;
      $('alphaResultsBody').innerHTML = `<tr><td colspan="10" class="alpha-empty">${escapeHtml(error.message)}</td></tr>`;
    } finally {
      state.running = false;
      button.disabled = false;
      button.classList.remove('scanning');
      $('btnAlphaPrimeScanText').textContent = '최고 후보 검색';
    }
  }

  function renderResults() {
    $('alphaMetricCount').textContent = String(state.matches.length);
    $('alphaDataDate').textContent = state.matches[0]?.date
      ? `${state.matches[0].date.slice(0, 4)}-${state.matches[0].date.slice(4, 6)}-${state.matches[0].date.slice(6, 8)}`
      : '-';
    if (!state.matches.length) {
      $('alphaMatchResults').innerHTML = '<div class="empty-state"><span>🛡️</span><p>현재 기준을 모두 통과한 종목이 없습니다.<br>현금도 하나의 포지션입니다.</p></div>';
      $('alphaResultsBody').innerHTML = '<tr><td colspan="10" class="alpha-empty">조건에 맞는 종목이 없습니다. 기준을 낮추지 않고 다음 기회를 기다립니다.</td></tr>';
      return;
    }

    $('alphaMatchResults').innerHTML = state.matches.slice(0, 20).map((signal, index) => {
      const color = gradeColor(signal.grade);
      return `<button class="alpha-match" data-alpha-index="${index}">
        <span><b>${escapeHtml(signal.stock.name)}</b><small>${escapeHtml(signal.setup)} · ${escapeHtml(signal.sector)}</small></span>
        <span class="alpha-score" style="color:${color}">${signal.score}<small>${signal.grade}</small></span>
      </button>`;
    }).join('');

    $('alphaResultsBody').innerHTML = state.matches.slice(0, 50).map((signal, index) => {
      const color = gradeColor(signal.grade);
      return `<tr data-alpha-index="${index}">
        <td><b>${escapeHtml(signal.stock.name)}</b><small>${escapeHtml(signal.stock.code)} · ${escapeHtml(signal.stock.market)}</small></td>
        <td><span class="alpha-grade" style="color:${color};border-color:${color}55;background:${color}12">${signal.grade}</span></td>
        <td class="alpha-score-cell" style="color:${color}">${signal.score}</td>
        <td>${escapeHtml(signal.setup)}<small>${escapeHtml(signal.sector)}${signal.sectorBonus ? ` · 섹터 +${signal.sectorBonus}` : ''}</small></td>
        <td>${number(signal.price)}원</td>
        <td class="${signal.changeRate >= 0 ? 'price-up' : 'price-down'}">${signal.changeRate >= 0 ? '+' : ''}${number(signal.changeRate, 2)}%</td>
        <td>${signal.relative.r60 >= 0 ? '+' : ''}${number(signal.relative.r60, 1)}%</td>
        <td>${number(signal.volumeRatio, 1)}배</td>
        <td>${number(signal.stopLoss)}원<small>-${number(signal.stopPct, 1)}%</small></td>
        <td>${number(signal.target2R)}원</td>
      </tr>`;
    }).join('');
    bindSelection();
    selectSignal(0);
  }

  function bindSelection() {
    document.querySelectorAll('[data-alpha-index]').forEach(node => node.addEventListener('click', () => {
      selectSignal(Number(node.dataset.alphaIndex));
    }));
  }

  function selectSignal(index) {
    const signal = state.matches[index];
    if (!signal) return;
    state.selected = signal;
    document.querySelectorAll('[data-alpha-index]').forEach(node => node.classList.toggle('selected', Number(node.dataset.alphaIndex) === index));
    renderDetail(signal);
  }

  function renderDetail(signal) {
    const color = gradeColor(signal.grade);
    const parts = signal.scores;
    $('alphaSignalsList').innerHTML = `
      <div class="alpha-detail-head"><span class="alpha-grade" style="color:${color};border-color:${color}55;background:${color}12">${signal.grade} · ${signal.score}점</span><b>${escapeHtml(signal.stock.name)}</b></div>
      <div class="alpha-detail-setup">${escapeHtml(signal.setup)} · ${escapeHtml(signal.sector)}${signal.sectorBonus ? ` 동반강세 +${signal.sectorBonus}점` : ''} · 시장 ${escapeHtml(signal.market.label)}</div>
      <div class="alpha-score-grid">
        <span>추세 <b>${parts.trend}/20</b></span><span>모멘텀 <b>${parts.momentum}/20</b></span>
        <span>상대강도 <b>${parts.relative}/20</b></span><span>수급 <b>${parts.volume}/15</b></span>
        <span>타점 <b>${parts.setup}/15</b></span><span>위험 <b>${parts.risk}/10</b></span>
      </div>
      <div class="alpha-levels">
        <span>현재가 <b>${number(signal.price)}원</b></span><span>손절 기준 <b class="price-down">${number(signal.stopLoss)}원</b></span>
        <span>2R 관리선 <b class="price-up">${number(signal.target2R)}원</b></span><span>52주 고점 위치 <b>${number(signal.highPositionPct, 1)}%</b></span>
      </div>
      <div class="alpha-risk-box">
        <label>운용자금 <input id="alphaCapital" type="number" min="1000000" step="1000000" value="100000000">원</label>
        <label>1회 위험 <input id="alphaRiskPercent" type="number" min="0.1" max="2" step="0.1" value="0.5">%</label>
        <div id="alphaPositionResult"></div>
      </div>
      <a class="alpha-naver-link" href="https://finance.naver.com/item/main.naver?code=${encodeURIComponent(signal.stock.code)}" target="_blank" rel="noopener">네이버 종목 화면 열기 ↗</a>
      <p class="alpha-disclaimer">점수는 매수 보장이 아닙니다. 시장이 약하면 등급이 자동 하향되며, 실제 주문 전 공시·뉴스·호가를 다시 확인하세요.</p>`;
    $('alphaCapital').addEventListener('input', updatePosition);
    $('alphaRiskPercent').addEventListener('input', updatePosition);
    updatePosition();
  }

  function updatePosition() {
    if (!state.selected) return;
    const capital = Number($('alphaCapital')?.value || 0);
    const riskPercent = Number($('alphaRiskPercent')?.value || 0.5);
    const position = Engine.calculatePosition(state.selected, capital, riskPercent);
    $('alphaPositionResult').innerHTML = `최대 <b>${number(position.shares)}주</b> · 투입 약 <b>${number(position.positionWon)}원</b><br>손절 시 예상손실 약 <b class="price-down">${number(position.maxLossWon)}원</b>`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('btnAlphaPrimeScan')?.addEventListener('click', runScan);
  });
})();
