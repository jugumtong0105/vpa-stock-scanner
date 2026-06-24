// VCP 마스터 스캐너 (Minervini VCP + WMA)
let VCP = {
  stocks: [],
  months: 15, // 52주 고점/저점(약 250일) + 200일선 계산을 위해 넉넉히 15개월치 데이터 요청
  sortCol: 'score',
  sortAsc: false,
  matches: []
};

// 단순 이동평균(SMA) 계산
function buildSMA(data, p) {
  const r = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i].close;
    if (i >= p) sum -= data[i - p].close;
    if (i >= p - 1) r.push({ idx: i, value: sum / p });
  }
  return r;
}

// 가중 이동평균(WMA) 계산
function buildWMA(data, p) {
  const r = [];
  const denominator = (p * (p + 1)) / 2;
  for (let i = p - 1; i < data.length; i++) {
    let wSum = 0;
    for (let j = 0; j < p; j++) {
      wSum += data[i - j].close * (p - j);
    }
    r.push({ idx: i, value: wSum / denominator });
  }
  return r;
}

// 특정 인덱스의 이평선 값 가져오기
function getVal(arr, idx) {
  const item = arr.find(e => e.idx === idx);
  return item ? item.value : null;
}

// VCP 패턴 분석 및 점수 산출 로직
async function analyzeVCPPattern(data, stock) {
  const lastIdx = data.length - 1;
  if (lastIdx < 260) return null; // 250일(52주) + 여유분

  const today = data[lastIdx];
  const yesterday = data[lastIdx - 1];

  // 1. 기초 필터링 (가격 및 거래대금)
  // 현재가 1,000원 ~ 100,000원
  if (today.close < 1000 || today.close > 100000) return null;
  // 당일 거래대금(대략적 계산: 종가 * 거래량) 100억 이상 여부
  const tradingValue = today.close * today.volume;
  if (tradingValue < 10000000000) return null;

  // 2. 각종 지표 계산
  const sma50Arr = buildSMA(data, 50);
  const sma150Arr = buildSMA(data, 150);
  const sma200Arr = buildSMA(data, 200);
  const wma5Arr = buildWMA(data, 5);
  const wma20Arr = buildWMA(data, 20);

  const ma50 = getVal(sma50Arr, lastIdx);
  const ma150 = getVal(sma150Arr, lastIdx);
  const ma200 = getVal(sma200Arr, lastIdx);
  const ma200_past = getVal(sma200Arr, lastIdx - 20); // 20일 전 200일선

  const wma5 = getVal(wma5Arr, lastIdx);
  const wma20 = getVal(wma20Arr, lastIdx);
  const wma5_prev = getVal(wma5Arr, lastIdx - 1);
  const wma20_prev = getVal(wma20Arr, lastIdx - 1);

  if (!ma50 || !ma150 || !ma200 || !ma200_past || !wma5 || !wma20) return null;

  // 52주(250일) 최고가/최저가
  let high52 = 0;
  let low52 = Infinity;
  for (let i = lastIdx - 250; i <= lastIdx; i++) {
    if (data[i].high > high52) high52 = data[i].high;
    if (data[i].low < low52) low52 = data[i].low;
  }

  // === 3. 필수 조건 검증 ===
  // 주가가 모든 이평선 위에 있어야 하고, 정배열이어야 함
  let isTrendOK = (today.close > ma50) && (ma50 > ma150) && (ma150 > ma200);
  let isMA200Rising = (ma200 > ma200_past);
  let isAbove52Low = (today.close >= low52 * 1.30); // 52주 저점 대비 30% 이상
  let isNear52High = (today.close >= high52 * 0.75); // 52주 고점 대비 -25% 이내

  // 하나라도 필수 조건을 크게 어기면 탈락시키지만, 점수제로 유연하게 처리할 수도 있음.
  // 프롬프트상 "필수 기능"이자 "조합해서 필터링"이므로 어느정도 조건 충족해야 진행.
  if (!isTrendOK || !isAbove52Low || !isNear52High) return null;

  // === 4. 점수화 산출 (Total 100) ===
  let trendScore = 0;
  let volumeScore = 0;
  let vcpScore = 0;
  let wmaScore = 0;
  let riskScore = 0;

  // Trend Score (Max 40)
  if (isTrendOK) trendScore += 15;
  if (isMA200Rising) trendScore += 10;
  if (isAbove52Low) trendScore += 5;
  if (isNear52High) {
    trendScore += 10; // 52주 신고가 돌파 직전일수록 높은 점수 부여 가능
    if (today.close >= high52 * 0.90) trendScore += 5; // 보너스
  }
  trendScore = Math.min(trendScore, 40);

  // WMA Cross Score (Max 10)
  // WMA5가 WMA20을 상향 돌파하거나 -1% 이내 근접
  let wmaDist = (wma5 - wma20) / wma20;
  if (wma5_prev < wma20_prev && wma5 >= wma20) wmaScore = 10; // 방금 골든크로스
  else if (wmaDist >= -0.01 && wmaDist <= 0.02) wmaScore = 8; // 매우 근접 (-1% ~ +2%)
  else if (wmaDist > 0.02) wmaScore = 5; // 이미 위에 있음

  // Volume Score (Max 20)
  // 최근 10일 평균 거래량이 최근 30일 평균보다 낮다가 당일 거래량 증가
  let volSum10 = 0, volSum30 = 0;
  for (let i = lastIdx - 1; i >= lastIdx - 30; i--) { // 어제 기준 평균
    volSum30 += data[i].volume;
    if (i >= lastIdx - 10) volSum10 += data[i].volume;
  }
  let avgVol10 = volSum10 / 10;
  let avgVol30 = volSum30 / 30;
  
  if (avgVol10 < avgVol30) {
    volumeScore += 10; // 거래량 급감 (에너지 응축)
    if (today.volume > avgVol10 * 1.5) volumeScore += 10; // 당일 거래량 터짐
  } else if (today.volume > avgVol30 * 2) {
    volumeScore += 15; // 평균 대비 엄청난 폭발
  }

  // VCP Score (Max 20)
  // 변동성 축소: 최근 20일간 5일씩 끊어서 고점-저점 변동폭이 감소하는지 확인
  let v1 = 0, v2 = 0, v3 = 0, v4 = 0;
  for(let i=0; i<5; i++) { v4 += (data[lastIdx-i].high - data[lastIdx-i].low)/data[lastIdx-i].low; }
  for(let i=5; i<10; i++) { v3 += (data[lastIdx-i].high - data[lastIdx-i].low)/data[lastIdx-i].low; }
  for(let i=10; i<15; i++) { v2 += (data[lastIdx-i].high - data[lastIdx-i].low)/data[lastIdx-i].low; }
  for(let i=15; i<20; i++) { v1 += (data[lastIdx-i].high - data[lastIdx-i].low)/data[lastIdx-i].low; }
  
  if (v4 < v3 && v3 < v2) vcpScore = 20; // 완벽한 축소
  else if (v4 < v3) vcpScore = 15;
  else if (v4 < v2) vcpScore = 10;
  else if (v4 < 0.1) vcpScore = 10; // 그냥 변동성 자체가 낮음

  // Risk Score (Max 10)
  // 손절가 대비 목표가(Risk/Reward). 손절가는 MA50, 목표가는 52주 고점
  let stopLoss = ma50; 
  let targetPrice = high52 > today.close * 1.1 ? high52 : today.close * 1.2; // 최소 20% 위
  let riskDist = (today.close - stopLoss) / today.close; 
  let rewardDist = (targetPrice - today.close) / today.close;
  
  if (riskDist < 0.05) riskScore = 10; // 손절라인이 5% 이내로 매우 타이트함 (Low Risk)
  else if (riskDist < 0.10) riskScore = 7;
  else riskScore = 3;

  const totalScore = trendScore + volumeScore + vcpScore + wmaScore + riskScore;

  // 점수에 따른 등급 분류
  let grade = '제외';
  if (totalScore >= 80) grade = 'A급 후보';
  else if (totalScore >= 70) grade = '관심 후보';
  else if (totalScore >= 60) grade = '관찰';

  if (totalScore < 60) return null; // 60점 미만 제외

  return {
    stock: stock,
    score: totalScore,
    grade: grade,
    trendScore,
    volumeScore,
    vcpScore,
    wmaScore,
    riskScore,
    price: today.close,
    changeRate: ((today.close - yesterday.close) / yesterday.close * 100).toFixed(2),
    tradingValue: tradingValue,
    stopLoss: Math.round(stopLoss),
    targetPrice: Math.round(targetPrice)
  };
}

// 스캔 실행
async function runVcpScan() {
  const btn = document.getElementById('btnVcpScan');
  const btnText = document.getElementById('btnVcpScanText');
  const resultsEl = document.getElementById('vcpResultsBody');
  const summaryEl = document.getElementById('vcpSummary');

  if (!btn || !resultsEl) return;

  btn.classList.add('scanning'); 
  btnText.textContent = '스캔 중...';
  resultsEl.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:30px;">⏳ VCP 마스터 스캐닝 진행 중...</td></tr>`;

  if (VCP.stocks.length === 0) {
    try {
      const r = await fetch('/api/stocklist');
      const j = await r.json();
      if (j.success) VCP.stocks = j.stocks;
    } catch (e) {}
  }

  const stockList = VCP.stocks;
  const allMatches = [];
  const batchSize = 10;

  for (let i = 0; i < stockList.length; i += batchSize) {
    const batch = stockList.slice(i, i + batchSize);
    const codes = batch.map(s => s.code).join(',');
    try {
      const res = await fetch(`/api/batch?codes=${codes}&months=${VCP.months}`);
      const bd = await res.json();
      for (const item of bd) {
        const stock = stockList.find(s => s.code === item.code);
        if (!stock || !item.data || item.data.length < 260) continue;
        const analysis = await analyzeVCPPattern(item.data, stock);
        if (analysis) {
          allMatches.push(analysis);
        }
      }
    } catch (e) { console.error(e); }
    btnText.textContent = `${Math.min(i + batchSize, stockList.length)} / ${stockList.length}`;
  }

  btn.classList.remove('scanning'); 
  btnText.textContent = '스캔 시작';
  
  VCP.matches = allMatches;
  renderVcpTable();
  
  if (summaryEl) summaryEl.textContent = `✅ 총 ${allMatches.length}개 종목 포착`;
}

// 테이블 렌더링
function renderVcpTable() {
  const tbody = document.getElementById('vcpResultsBody');
  if (!tbody) return;

  if (VCP.matches.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:30px; color:var(--text-muted);">조건에 맞는 종목이 없습니다.</td></tr>`;
    return;
  }

  // 정렬 로직
  VCP.matches.sort((a, b) => {
    let valA = a[VCP.sortCol];
    let valB = b[VCP.sortCol];
    if (VCP.sortCol === 'name') { valA = a.stock.name; valB = b.stock.name; }
    
    if (valA < valB) return VCP.sortAsc ? -1 : 1;
    if (valA > valB) return VCP.sortAsc ? 1 : -1;
    return 0;
  });

  // 거래대금 변환 포맷
  const fmtWon = (v) => {
    return (v / 100000000).toLocaleString('ko-KR', { maximumFractionDigits: 0 }) + '억';
  };

  const html = VCP.matches.map((m, idx) => {
    const gradeColor = m.grade === 'A급 후보' ? '#ef4444' : (m.grade === '관심 후보' ? '#f59e0b' : '#3b82f6');
    return `
      <tr class="vcp-tr">
        <td style="font-weight:700; color:#fff;">${m.stock.name}</td>
        <td>${m.price.toLocaleString()}</td>
        <td style="color:${m.changeRate > 0 ? '#ff4757' : (m.changeRate < 0 ? '#3b82f6' : '#fff')}">${m.changeRate}%</td>
        <td>${fmtWon(m.tradingValue)}</td>
        <td><span style="font-weight:700; color:${gradeColor}; font-size:14px;">${m.score}</span></td>
        <td><span class="vcp-badge" style="background:${gradeColor}20; color:${gradeColor}; padding:4px 8px; border-radius:4px; font-size:11px; font-weight:700;">${m.grade}</span></td>
        <td style="color:#9ca3af; font-size:12px;">${m.trendScore}/${m.volumeScore}/${m.vcpScore}</td>
        <td style="color:#ef4444">${m.targetPrice.toLocaleString()}</td>
        <td style="color:#3b82f6">${m.stopLoss.toLocaleString()}</td>
        <td><button class="vcp-fav-btn" onclick="toggleFav('${m.stock.code}')" style="background:none;border:none;cursor:pointer;font-size:16px;">⭐</button></td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = html;
}

// 컬럼 정렬 핸들러
function handleVcpSort(col) {
  if (VCP.sortCol === col) VCP.sortAsc = !VCP.sortAsc;
  else { VCP.sortCol = col; VCP.sortAsc = false; }
  
  document.querySelectorAll('.vcp-th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === col) th.classList.add(VCP.sortAsc ? 'sort-asc' : 'sort-desc');
  });

  renderVcpTable();
}

// CSV 다운로드 로직
function downloadVcpCSV() {
  if (VCP.matches.length === 0) {
    alert("다운로드할 데이터가 없습니다.");
    return;
  }
  
  let csvContent = "\uFEFF"; // 한글 깨짐 방지 BOM
  csvContent += "종목명,현재가,등락률,거래대금(억),총점,등급,Trend점수,Volume점수,VCP점수,WMA점수,Risk점수,목표가,손절가\n";
  
  VCP.matches.forEach(m => {
    const row = [
      m.stock.name,
      m.price,
      m.changeRate,
      Math.round(m.tradingValue / 100000000),
      m.score,
      m.grade,
      m.trendScore,
      m.volumeScore,
      m.vcpScore,
      m.wmaScore,
      m.riskScore,
      m.targetPrice,
      m.stopLoss
    ].join(',');
    csvContent += row + "\n";
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  link.setAttribute("download", `VCP_마스터_스캐너_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function toggleFav(code) {
  alert(code + " 관심종목 등록 로직 (추후 확장 가능)");
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnVcpScan');
  if(btn) btn.addEventListener('click', runVcpScan);

  const csvBtn = document.getElementById('btnVcpCsv');
  if(csvBtn) csvBtn.addEventListener('click', downloadVcpCSV);

  document.querySelectorAll('.vcp-th').forEach(th => {
    th.addEventListener('click', () => {
      if (th.dataset.col) handleVcpSort(th.dataset.col);
    });
  });
});
