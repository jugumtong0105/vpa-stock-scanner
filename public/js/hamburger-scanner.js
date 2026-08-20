(() => {
  const $ = id => document.getElementById(id);
  let alertEnabled = localStorage.getItem('hamburger-alert-enabled') === 'true';
  let audioContext = null;
  let timer = null;
  let latest = null;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function formatNumber(value) { return Number(value || 0).toLocaleString('ko-KR'); }
  function formatEok(value) { return `${formatNumber(Math.round(Number(value || 0)))}억원`; }

  function getSeoulClock() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = Number(part.value);
      return acc;
    }, {});
    return parts;
  }

  function updateClock() {
    const now = getSeoulClock();
    const current = now.hour * 3600 + now.minute * 60 + now.second;
    const open = 9 * 3600, closeFirstBar = open + 180;
    let label = '검색 종료';
    let remaining = 0;
    if (current < open) { label = '자동 검색까지'; remaining = open - current; }
    else if (current < closeFirstBar) { label = '첫 3분봉 마감까지'; remaining = closeFirstBar - current; }
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    $('hamburgerClockLabel').textContent = label;
    $('hamburgerClock').textContent = `${mm}:${ss}`;
  }

  function updateAlertButton() {
    const button = $('btnHamburgerAlert');
    button.classList.toggle('enabled', alertEnabled);
    $('btnHamburgerAlertText').textContent = alertEnabled ? '알림 켜짐' : '알림 켜기';
  }

  function beep() {
    if (!alertEnabled) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      audioContext.resume();
      [0, 0.18].forEach((delay, index) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.frequency.value = index ? 880 : 660;
        gain.gain.setValueAtTime(0.0001, audioContext.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.22, audioContext.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + delay + 0.16);
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start(audioContext.currentTime + delay);
        oscillator.stop(audioContext.currentTime + delay + 0.18);
      });
    } catch (_) {}
  }

  async function enableAlerts() {
    alertEnabled = true;
    localStorage.setItem('hamburger-alert-enabled', 'true');
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      await audioContext.resume();
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    } catch (_) {}
    beep();
    updateAlertButton();
  }

  function sendNewAlerts(data) {
    if (!alertEnabled || !data.rows?.length) return;
    const key = `hamburger-alerted-${data.date}`;
    const alerted = new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    const fresh = data.rows.filter(row => !alerted.has(row.code));
    if (!fresh.length) return;
    beep();
    const names = fresh.map(row => `${row.name} ${formatEok(row.tradingValueEok)}`).join(', ');
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('🍔 첫 3분봉 500억 돌파', { body: names, tag: `hamburger-${data.date}` });
    }
    fresh.forEach(row => alerted.add(row.code));
    localStorage.setItem(key, JSON.stringify([...alerted]));
  }

  function renderRows(data) {
    const rows = data.rows || [];
    $('hamburgerMetricCount').textContent = String(rows.length);
    $('hamburgerMatchCount').textContent = `${rows.length}종목`;
    if (!rows.length) {
      $('hamburgerResultsBody').innerHTML = `<tr><td colspan="6" class="hamburger-empty-row">${data.phase === 'SCANNING' ? '500억원 돌파 종목을 기다리고 있습니다.' : '확정된 500억원 돌파 종목이 없습니다.'}</td></tr>`;
      $('hamburgerMatchResults').innerHTML = '<div class="empty-state"><span>🍔</span><p>아직 500억원을 넘긴<br>일반 주식이 없습니다.</p></div>';
      return;
    }
    $('hamburgerResultsBody').innerHTML = rows.map(row => `
      <tr>
        <td><a class="hamburger-stock-link" href="https://finance.naver.com/item/main.naver?code=${encodeURIComponent(row.code)}" target="_blank" rel="noopener">${escapeHtml(row.name)} <small>${escapeHtml(row.code)}</small></a></td>
        <td>${escapeHtml(row.market)}</td><td>${formatNumber(row.price)}원</td>
        <td class="${row.changeRate >= 0 ? 'price-up' : 'price-down'}">${row.changeRate >= 0 ? '+' : ''}${row.changeRate.toFixed(2)}%</td>
        <td class="hamburger-value">${formatEok(row.tradingValueEok)}</td><td><span class="hamburger-pass">돌파</span></td>
      </tr>`).join('');
    $('hamburgerMatchResults').innerHTML = rows.map(row => `
      <div class="match-item hamburger-match-item">
        <div class="match-header"><span class="match-name">${escapeHtml(row.name)}</span><span class="match-reliability reliability-high">돌파</span></div>
        <div class="match-detail">${escapeHtml(row.market)} · ${formatNumber(row.price)}원 · ${row.changeRate >= 0 ? '+' : ''}${row.changeRate.toFixed(2)}%</div>
        <div class="match-signal-date">첫 3분 거래대금 ${formatEok(row.tradingValueEok)}</div>
      </div>`).join('');
  }

  function renderLeaders(data) {
    const leaders = data.leaders || [];
    $('hamburgerLeaderBars').innerHTML = leaders.length ? leaders.slice(0, 10).map(row => {
      const percent = Math.min(100, row.tradingValueEok / data.thresholdEok * 100);
      return `<div class="hamburger-leader"><span class="hamburger-leader-name">${escapeHtml(row.name)}</span><span class="hamburger-bar"><span style="width:${percent.toFixed(1)}%"></span></span><span class="hamburger-leader-value">${formatEok(row.tradingValueEok)}</span></div>`;
    }).join('') : '<div class="hamburger-empty-row">검색 시간에 거래대금 흐름이 표시됩니다.</div>';
  }

  function renderStatus(data) {
    latest = data;
    const status = {
      WAITING: ['idle', '09:00 자동 검색 대기'],
      SCANNING: ['scanning', '첫 3분봉 검색 중'],
      LOCKED: ['done', data.locked ? '오늘 결과 확정' : '오늘 수집 기록 없음'],
      CLOSED: ['idle', '장 마감 · 다음 거래일 대기']
    }[data.phase] || ['idle', '상태 확인 중'];
    $('hamburgerStatusDot').className = `status-dot ${status[0]}`;
    $('hamburgerStatusText').textContent = status[1];
    $('hamburgerNotice').textContent = data.note || '';
    $('hamburgerUpdatedAt').textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
    renderRows(data);
    renderLeaders(data);
    sendNewAlerts(data);
  }

  function nextPollDelay(data) {
    if (data.phase === 'SCANNING') return 3000;
    if (data.phase === 'WAITING') return 30000;
    return null;
  }

  async function poll() {
    clearTimeout(timer);
    try {
      const response = await fetch('/api/hamburger/status', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '검색 상태를 불러오지 못했습니다.');
      renderStatus(data);
      const delay = nextPollDelay(data);
      if (delay) timer = setTimeout(poll, delay);
    } catch (error) {
      $('hamburgerStatusDot').className = 'status-dot error';
      $('hamburgerStatusText').textContent = '연결 재시도 중';
      $('hamburgerNotice').textContent = error.message;
      timer = setTimeout(poll, 10000);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    updateAlertButton();
    $('btnHamburgerAlert').addEventListener('click', enableAlerts);
    document.querySelectorAll('.sidebar-tab').forEach(tab => tab.addEventListener('click', () => {
      const isHamburger = tab.dataset.tab === 'hamburger';
      $('btnScan').style.display = isHamburger ? 'none' : 'flex';
      $('modeToggle').style.display = isHamburger ? 'none' : 'flex';
      if (isHamburger && latest) renderStatus(latest);
    }));
    updateClock();
    setInterval(updateClock, 1000);
    poll();
  });
})();
