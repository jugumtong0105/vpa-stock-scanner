(() => {
  'use strict';
  function detect(rows, period = 20, width = 10) {
    if (!Array.isArray(rows) || rows.length < period || period < 2 || width <= 0 || width >= 100) return null;
    const recent = rows.slice(-period), bar = recent.at(-1);
    if (recent.some(r => ![r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite) ||
      r.low <= 0 || r.low > Math.min(r.open, r.close) || r.high < Math.max(r.open, r.close)) || bar.volume <= 0) return null;
    const center = recent.reduce((s, r) => s + r.close, 0) / period;
    const lower = center * (1 - width / 100);
    if (bar.low > lower) return null;
    const range = bar.high - bar.low;
    const body = (bar.close - bar.open) / bar.open;
    const recovery = range > 0 && (bar.close - bar.low) / range >= 0.5;
    return { date: bar.date, close: bar.close, lower, center,
      confirmed: bar.close >= lower && recovery && body >= -0.025 };
  }
  function scenario(price, step) {
    const second = price * (1 - step / 100), third = second * (1 - step / 100);
    return [price, second, third, third * .95, price * 1.07];
  }
  if (typeof module !== 'undefined') module.exports = { detect, scenario };
  if (typeof document === 'undefined') return;
  document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelector('.sidebar-tabs'), sidebar = document.getElementById('sidebar');
    if (!tabs || !sidebar) return;
    const button = document.createElement('button');
    button.className = 'sidebar-tab'; button.dataset.tab = 'envelope'; button.textContent = '📉 엔벨로프 반등';
    tabs.append(button);
    const panel = document.createElement('div');
    panel.className = 'tab-content';
    panel.innerHTML = '<div class="sidebar-header"><h2>엔벨로프 하단 반등</h2><p>일봉 관찰용 · 장중 봉은 잠정</p><form class="param-group"><label>이평 기간 <input name="period" type="number" min="5" max="120" value="20" required></label><label>하단 폭 (%) <input name="width" type="number" min="1" max="40" step="0.5" value="10" required></label><label>분할 간격 (%) <input name="step" type="number" min="7" max="10" step="0.5" value="8" required></label><button class="btn-scan">검색</button></form><p role="status" class="scan-status"></p><small>거래대금 상위 종목 대상(코스피200 주도주 필터 아님). 기본 밴드·멈춤 기준은 구현값입니다.</small></div><div class="match-results"></div>';
    sidebar.append(panel);
    const chartSection = document.querySelector('.chart-section');
    const view = document.createElement('div');
    view.style.cssText = 'display:none;flex:1;min-height:0;flex-direction:column';
    view.innerHTML = '<div class="stock-info-bar"><strong></strong><span>파랑: 엔벨로프 하단 · 노랑: 이동평균</span></div><div class="chart-container"></div>';
    const caption = view.querySelector('strong'), canvas = view.lastElementChild;
    chartSection.append(view);
    let savedDisplays = null, chart, candle, lowerLine, centerLine;
    let selected = null;
    function draw(hit) {
      selected = hit;
      caption.textContent = hit ? `${hit.stock.name} (${hit.stock.code}) · ${hit.date}` : '검색 결과를 선택하면 차트가 표시됩니다.';
      if (!hit) { canvas.style.display = 'none'; return; }
      canvas.style.display = 'block';
      if (!window.LightweightCharts) { caption.textContent += ' · 차트 라이브러리를 불러오지 못했습니다.'; return; }
      if (!chart) {
        chart = window.LightweightCharts.createChart(canvas, {
          autoSize: true,
          layout: { background: {color: '#080b12'}, textColor: '#aab7ca' },
          grid: { vertLines: {color: '#141c28'}, horzLines: {color: '#141c28'} }
        });
        candle = chart.addCandlestickSeries({upColor:'#ff4757',downColor:'#3b82f6',borderVisible:false,wickUpColor:'#ff4757',wickDownColor:'#3b82f6'});
        lowerLine = chart.addLineSeries({color:'#38bdf8',lineWidth:2,priceLineVisible:false});
        centerLine = chart.addLineSeries({color:'#facc15',lineWidth:1,priceLineVisible:false});
      }
      const rows = [...new Map(hit.rows.filter(r => /^\d{8}$/.test(r.date) &&
        [r.open,r.high,r.low,r.close].every(Number.isFinite)).map(r => [String(r.date),r])).values()]
        .sort((a,b) => String(a.date).localeCompare(String(b.date)));
      const day = value => String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
      candle.setData(rows.map(({date,open,high,low,close}) => ({time:day(date),open,high,low,close})));
      const averages = rows.flatMap((r,i) => i + 1 < hit.period ? [] : [{
        time: day(r.date), value: rows.slice(i + 1 - hit.period,i + 1).reduce((sum,b) => sum + b.close,0) / hit.period
      }]);
      centerLine.setData(averages);
      lowerLine.setData(averages.map(p => ({time:p.time,value:p.value * (1 - hit.width / 100)})));
      candle.setMarkers([{time:day(hit.date),position:'belowBar',color:'#38bdf8',shape:'arrowUp',text:'하단 접촉'}]);
      chart.timeScale().fitContent();
    }
    tabs.addEventListener('click', event => {
      const next = event.target.closest('.sidebar-tab');
      if (!next || next === button || !savedDisplays) return;
      for (const [el, display] of savedDisplays) el.style.display = display;
      savedDisplays = null;
      view.style.display = 'none';
    }, true);
    button.addEventListener('click', () => {
      tabs.querySelectorAll('.sidebar-tab').forEach(el => el.classList.toggle('active', el === button));
      sidebar.querySelectorAll('.tab-content').forEach(el => {
        el.classList.toggle('active', el === panel);
        el.style.display = el === panel ? 'flex' : 'none';
      });
      if (!savedDisplays) {
        savedDisplays = [...chartSection.children].filter(el => el !== view).map(el => [el, el.style.display]);
        for (const [el] of savedDisplays) el.style.display = 'none';
      }
      view.style.display = 'flex';
      draw(selected);
    });
    const form = panel.querySelector('form'), status = panel.querySelector('[role=status]'), results = panel.querySelector('.match-results');
    const won = value => Math.round(value).toLocaleString('ko-KR') + '원';
    async function json(url) {
      const response = await fetch(url, {signal: AbortSignal.timeout(25000)});
      if (!response.ok) throw Error('시세 API 응답 오류');
      return response.json();
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = form.querySelector('button');
      if (submit.disabled) return;
      const {period, width, step} = Object.fromEntries(new FormData(form));
      submit.disabled = true; results.replaceChildren(); draw(null); status.textContent = '종목 목록 확인 중…';
      try {
        const {stocks} = await json('/api/stocklist');
        if (!stocks?.length) throw Error('종목 목록을 받지 못했습니다.');
        const hits = [];
        let checked = 0;
        for (let i = 0; i < stocks.length; i += 12) {
          const batch = stocks.slice(i, i + 12), lookup = new Map(batch.map(s => [s.code, s]));
          try {
            const rows = await json('/api/batch?months=9&codes=' + encodeURIComponent(batch.map(s => s.code).join(',')));
            for (const row of rows) {
              const stock = lookup.get(row.code);
              if (!stock || row.data?.length < +period || !row.data?.length) continue;
              checked++;
              const signal = detect(row.data, +period, +width);
              if (signal) hits.push({stock, rows: row.data, period: +period, width: +width, ...signal});
            }
          } catch (error) { console.warn('Envelope batch unavailable', error); }
          status.textContent = `진행 ${Math.min(i + 12, stocks.length)}/${stocks.length}`;
        }
        hits.sort((a,b) => Number(b.confirmed) - Number(a.confirmed) || String(b.date).localeCompare(String(a.date)));
        for (const hit of hits) {
          const card = document.createElement('details'); card.className = 'match-item';
          const title = document.createElement('summary');
          title.textContent = `${hit.stock.name} (${hit.stock.code}) · ${hit.confirmed ? '멈춤 확인 후보' : '하단 접촉 · 관찰'}`;
          const body = document.createElement('p'); body.className = 'match-detail';
          body.textContent = `일봉 ${hit.date} · 종가 ${won(hit.close)} · 하단 ${won(hit.lower)} · 중심선 ${won(hit.center)}`;
          card.append(title, body);
          title.addEventListener('click', () => draw(hit));
          if (hit.confirmed) {
            const [first, second, third, stop, target] = scenario(hit.close, +step);
            const plan = document.createElement('p'); plan.className = 'match-detail';
            plan.textContent = `가상 기준: 40/30/30% 예산 배분 · 1차 ${won(first)} → 2차 ${won(second)} → 3차 ${won(third)} · 3차 기준 -5% ${won(stop)} · 1차만 체결 가정 +7% ${won(target)} (절반 예시). 갭·실제 체결은 반영하지 않습니다.`;
            card.append(plan);
          }
          results.append(card);
        }
        if (hits.length) {
          results.firstElementChild.open = true;
          if (savedDisplays) draw(hits[0]);
          else selected = hits[0];
        }
        status.textContent = checked ? `${checked}/${stocks.length}종목 확인 · 후보 ${hits.length}건${checked < stocks.length ? ' · 일부 데이터 부족/조회 실패' : ''}` : '분석 가능한 일봉을 받지 못했습니다.';
      } catch (error) { status.textContent = error.message; }
      finally { submit.disabled = false; }
    });
  });
})();
