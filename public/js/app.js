/* VPA Scanner v6 - 실전모드 + 검증모드 */
const FALLBACK = [
  '005930','000660','005380','000270','035420','035720','005490','207940','006400','051910',
  '068270','055550','105560','003670','000810','012330','066570','003550','096770','034730',
  '011200','009150','033780','030200','028260','018260','017670','034020','011070','003490',
  '036570','402340','000720','086790','326030','047050','352820','015760','010140','042660',
];
let S = { stocks:[], stock:null, data:[], signals:[], chart:null, candle:null, vol:null,
  ma5:null, ma50:null, ma200:null, months:12, scanMode:'live',
  params:{ bullishRate:4, volMultiple:1.5, volDecline:65, bearishMax:-7, recentDays:15 }
};
function fmtD(d){return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`;}
async function fetchStockList(){
  try{ const r=await fetch('/api/stocklist'); const j=await r.json();
    if(j.success&&j.stocks.length>50){S.stocks=j.stocks;return;}
  }catch(e){}
  S.stocks=FALLBACK.map(c=>({code:c,name:c,market:'KOSPI'}));
}
function calcMA(data,i,p){if(i<p-1)return null;let s=0;for(let j=i-p+1;j<=i;j++)s+=data[j].close;return s/p;}
function calcAvgVol(data,i,p){let s=0,c=0;for(let j=Math.max(0,i-p);j<i;j++){s+=data[j].volume;c++;}return c?s/c:0;}
function buildMA(data,p){const r=[];for(let i=0;i<data.length;i++){if(i<p-1)continue;let s=0;for(let j=i-p+1;j<=i;j++)s+=data[j].close;r.push({time:fmtD(data[i].date),value:s/p});}return r;}

// ===== 공통 패턴 분석 엔진 =====
// mode='live': 마지막 캔들 기준 → 내일 매수 후보
// mode='backtest': 마지막-1 캔들 기준 → 사후 검증
function analyzePattern(data, params, mode) {
  const signals = [];
  const lastIdx = data.length - 1;
  if (lastIdx < 12) return signals;

  const isLive = mode === 'live';
  const evalIdx = isLive ? lastIdx : lastIdx - 1;
  const evalCandle = data[evalIdx];
  const finalCandle = isLive ? null : data[lastIdx];

  for (let a = Math.max(5, evalIdx - 25); a < evalIdx - 1; a++) {
    const base = data[a];
    const bChg = ((base.close - base.open) / base.open) * 100;
    if (bChg < params.bullishRate) continue;
    const avgV = calcAvgVol(data, a, 20);
    const vR = avgV > 0 ? base.volume / avgV : 0;
    if (vR < params.volMultiple) continue;

    const consolidation = data.slice(a + 1, evalIdx + 1);
    if (consolidation.length < 2) continue;
    if (evalCandle.close > base.high * 1.02) continue;

    // 실전모드: 오늘 이미 5%이상 급등한 종목 제외
    if (isLive) {
      const todayChg = ((evalCandle.close - evalCandle.open) / evalCandle.open) * 100;
      if (todayChg > 5) continue;
    }

    let sumBody = 0, sumVol = 0, lowPrice = Infinity, lowIdx = a + 1;
    let holdSupport = 0;
    const cLen = consolidation.length;
    for (let j = 0; j < cLen; j++) {
      const c = consolidation[j];
      sumBody += Math.abs(c.close - c.open) / c.open * 100;
      sumVol += c.volume;
      if (c.low < lowPrice) { lowPrice = c.low; lowIdx = a + 1 + j; }
      if (c.close >= base.open * 0.97) holdSupport++;
    }

    const avgBodyPct = sumBody / cLen;
    const avgConsVol = sumVol / cLen;
    const volDryUp = base.volume > 0 ? avgConsVol / base.volume : 1;
    if (avgBodyPct > 5) continue;
    if (volDryUp > 0.6) continue;
    const supportRate = holdSupport / cLen;
    if (supportRate < 0.5) continue;
    const pullDepth = ((base.high - lowPrice) / base.high) * 100;
    if (pullDepth > 25) continue;

    const r3Start = Math.max(a + 1, evalIdx - 2);
    const recent3 = data.slice(r3Start, evalIdx + 1);
    let recentVolTrend = 0, recentUpCount = 0;
    for (let k = 0; k < recent3.length; k++) {
      if (recent3[k].close >= recent3[k].open) recentUpCount++;
      recentVolTrend += recent3[k].volume;
    }
    const recentAvgVol = recentVolTrend / recent3.length;
    const volPickup = avgConsVol > 0 ? recentAvgVol / avgConsVol : 1;

    const toHighPct = (evalCandle.close / base.high) * 100;
    const aboveOpen = evalCandle.close >= base.open;

    let readiness = '🟡 조정 중';
    if (toHighPct >= 90 && volPickup > 1.2) readiness = '🔴 돌파 임박!';
    else if (toHighPct >= 85 && aboveOpen) readiness = '🟠 반등 시작';
    else if (toHighPct >= 75) readiness = '🟡 지지 확인';

    let rel = 0;
    rel += Math.min(bChg / 12, 1) * 12;
    rel += Math.min(vR / 5, 1) * 12;
    rel += Math.min((1 - volDryUp) * 2, 1) * 15;
    rel += Math.min((3 - avgBodyPct) / 3, 1) * 15;
    rel += supportRate * 15;
    const ma5v = calcMA(data, evalIdx, 5);
    const ma20v = calcMA(data, evalIdx, 20);
    const ma50v = calcMA(data, evalIdx, 50);
    if (ma5v && evalCandle.close >= ma5v) rel += 6;
    if (ma20v && evalCandle.close >= ma20v) rel += 6;
    if (ma50v && evalCandle.close >= ma50v) rel += 6;
    if (toHighPct >= 85) rel += 5;
    if (volPickup > 1.2) rel += 5;
    if (recentUpCount >= 2) rel += 3;

    const finalChg = finalCandle ? ((finalCandle.close - evalCandle.close) / evalCandle.close * 100) : 0;
    const verified = finalCandle ? finalChg > 3 : false;

    if (rel >= 35) {
      signals.push({
        mode, readiness, baseFdate:fmtD(base.date), baseDate:base.date,
        baseHigh:base.high, baseOpen:base.open, baseClose:base.close,
        baseChange:bChg.toFixed(1), baseVolRatio:vR.toFixed(1),
        pullFdate:fmtD(data[lowIdx].date), pullLow:lowPrice,
        pullDepth:pullDepth.toFixed(1), consolDays:cLen,
        avgBody:avgBodyPct.toFixed(1), volDryUp:(volDryUp*100).toFixed(0),
        supportRate:(supportRate*100).toFixed(0),
        toHighPct:toHighPct.toFixed(0), volPickup:volPickup.toFixed(1),
        currPrice:evalCandle.close, entryPrice:evalCandle.close,
        targetPrice:base.high,
        stopLoss:Math.min(lowPrice, base.open * 0.97),
        reliability:Math.round(rel), baseIdx:a, pullIdx:lowIdx,
        evalDate:fmtD(data[evalIdx].date),
        finalPrice:finalCandle ? finalCandle.close : null,
        finalChange:finalCandle ? finalChg.toFixed(1) : null,
        verified
      });
    }
  }
  const order = {'🔴 돌파 임박!':0, '🟠 반등 시작':1, '🟡 지지 확인':2, '🟡 조정 중':3};
  return signals.sort((a,b) => {
    const od = (order[a.readiness]||9) - (order[b.readiness]||9);
    return od !== 0 ? od : b.reliability - a.reliability;
  });
}

// === CHART ===
function initChart(){
  const el=document.getElementById('chartContainer'); el.innerHTML='';
  const c=LightweightCharts.createChart(el,{
    layout:{background:{type:'solid',color:'#080b12'},textColor:'#8492a6',fontFamily:"'Inter','Noto Sans KR',sans-serif",fontSize:11},
    grid:{vertLines:{color:'#141c28'},horzLines:{color:'#141c28'}},
    crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
    rightPriceScale:{borderColor:'#1e293b',scaleMargins:{top:0.05,bottom:0.25}},
    timeScale:{borderColor:'#1e293b',timeVisible:false,rightOffset:3,barSpacing:8},
  });
  S.candle=c.addCandlestickSeries({upColor:'#ff4757',downColor:'#3b82f6',borderDownColor:'#3b82f6',borderUpColor:'#ff4757',wickDownColor:'#3b82f6',wickUpColor:'#ff4757'});
  S.ma5=c.addLineSeries({color:'#f0c040',lineWidth:1,title:'MA5',priceLineVisible:false,lastValueVisible:false});
  S.ma50=c.addLineSeries({color:'#00d4ff',lineWidth:1.5,title:'MA50',priceLineVisible:false,lastValueVisible:false});
  S.ma200=c.addLineSeries({color:'#e056fd',lineWidth:2,title:'MA200',priceLineVisible:false,lastValueVisible:false});
  S.vol=c.addHistogramSeries({priceFormat:{type:'volume'},priceScaleId:'vol'});
  c.priceScale('vol').applyOptions({scaleMargins:{top:0.8,bottom:0},borderVisible:false});
  S.chart=c;
  new ResizeObserver(()=>c.applyOptions({width:el.clientWidth,height:el.clientHeight})).observe(el);
}
function showChart(data, signals){
  if(!S.chart) initChart();
  S.candle.setData(data.map(d=>({time:fmtD(d.date),open:d.open,high:d.high,low:d.low,close:d.close})));
  S.ma5.setData(buildMA(data,5)); S.ma50.setData(buildMA(data,50)); S.ma200.setData(buildMA(data,200));
  S.vol.setData(data.map(d=>({time:fmtD(d.date),value:d.volume,color:d.close>=d.open?'rgba(255,71,87,0.3)':'rgba(59,130,246,0.3)'})));
  const mk=[];
  signals.forEach(s=>{
    mk.push({time:s.baseFdate,position:'aboveBar',color:'#ffa502',shape:'circle',text:'①기준봉(+'+s.baseChange+'%)'});
    mk.push({time:s.pullFdate,position:'belowBar',color:'#e056fd',shape:'arrowUp',text:'④저점'});
  });
  // 현재 위치 = 매수 대기 포인트
  if(signals.length > 0){
    const lastDate=fmtD(data[data.length-1].date);
    mk.push({time:lastDate,position:'belowBar',color:'#00d4aa',shape:'arrowUp',text:'💎매수대기'});
  }
  mk.sort((a,b)=>a.time>b.time?1:-1);
  const unique=[]; const seen=new Set();
  mk.forEach(m=>{const key=m.time+m.position;if(!seen.has(key)){seen.add(key);unique.push(m);}});
  S.candle.setMarkers(unique);
  S.chart.timeScale().fitContent();
  document.getElementById('signalLegend').style.display='flex';
}

// === SCAN ===
async function runScan(){
  const btn=document.getElementById('btnScan'),btnText=document.getElementById('btnScanText');
  const statusDot=document.querySelector('.status-dot'),statusText=document.getElementById('statusText');
  const progWrap=document.getElementById('scanProgressWrap'),progFill=document.getElementById('progressFill');
  const progText=document.getElementById('progressText'),results=document.getElementById('matchResults');
  const summary=document.getElementById('scanSummary');
  const mode = S.scanMode;
  const modeLabel = mode==='live' ? '🔥 실전모드: 내일 매수 후보' : '🔬 검증모드: 사후 검증';
  btn.classList.add('scanning'); btnText.textContent='스캔 중...';
  statusDot.className='status-dot scanning'; statusText.textContent='종목 리스트 로딩 중...';
  progWrap.style.display='flex';
  results.innerHTML=`<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">⏳ ${modeLabel} 스캔 중...</div>`;
  await fetchStockList();
  const stockList=S.stocks;
  statusText.textContent=`${stockList.length}개 종목 스캔 중...`;
  const allMatches=[];
  let scanned=0, lastDataDate='';
  const batchSize=8;
  for(let i=0;i<stockList.length;i+=batchSize){
    const batch=stockList.slice(i,i+batchSize);
    const codes=batch.map(s=>s.code).join(',');
    try{
      const r=await fetch(`/api/batch?codes=${codes}&months=${S.months}`);
      const bd=await r.json();
      for(const item of bd){
        const stock=stockList.find(s=>s.code===item.code);
        if(!stock||!item.data||item.data.length<20) continue;
        const sigs=analyzePattern(item.data,S.params,mode);
        if(sigs.length>0){
          const d=item.data, last=d[d.length-1], prev=d.length>=2?d[d.length-2]:last;
          if(d.length>0) lastDataDate=fmtD(d[d.length-1].date);
          allMatches.push({stock,data:d,signals:sigs,allSignals:sigs,
            lastPrice:last.close,change:((last.close-prev.close)/prev.close*100).toFixed(2)});
        }
        scanned++;
      }
    }catch(e){}
    const pct=Math.min(((i+batchSize)/stockList.length)*100,100);
    progFill.style.width=pct+'%';
    progText.textContent=`${Math.min(i+batchSize,stockList.length)} / ${stockList.length}`;
    statusText.textContent=`스캔 중... (${allMatches.length}건 발견)`;
    await new Promise(r=>setTimeout(r,150));
  }
  // 돌파 임박 순으로 정렬
  const order={'🔴 돌파 임박!':0,'🟠 반등 시작':1,'🟡 지지 확인':2,'🟡 조정 중':3};
  allMatches.sort((a,b)=>{
    const oa=order[a.signals[0].readiness]||9, ob=order[b.signals[0].readiness]||9;
    return oa!==ob?oa-ob:b.signals[0].reliability-a.signals[0].reliability;
  });
  btn.classList.remove('scanning'); btnText.textContent='다시 스캔';
  statusDot.className='status-dot done';
  statusText.textContent=allMatches.length>0?`✅ ${allMatches.length}건 포착!`:'매칭 없음';
  progWrap.style.display='none'; summary.style.display='block';
  document.getElementById('totalScanned').textContent=scanned+'개';
  document.getElementById('totalMatched').textContent=allMatches.length+'개';
  document.getElementById('dataDate').textContent=lastDataDate||'-';
  // ★ 성과 추적용 자동 저장!
  if (allMatches.length > 0) saveSignals(allMatches);
  if(allMatches.length===0){
    results.innerHTML=`<div class="no-match-msg">매칭 종목 없음 😅<div class="tip">💡 등락률/거래량 조건을 완화해보세요</div></div>`;
    return;
  }
  const modeBadge = mode==='live'
    ? '<div class="mode-badge live">🔥 실전모드 — 장 마감 후 확인 → 내일 아침 매수</div>'
    : '<div class="mode-badge backtest">🔬 검증모드 — 어제 포착 → 오늘 결과 확인</div>';
  results.innerHTML=modeBadge + allMatches.map((m,idx)=>{
    const s=m.signals[0];
    const relClass=s.reliability>=70?'reliability-high':s.reliability>=50?'reliability-mid':'reliability-low';
    const stars=s.reliability>=75?'⭐⭐⭐':s.reliability>=55?'⭐⭐':'⭐';
    const profitPct=((s.targetPrice-s.entryPrice)/s.entryPrice*100).toFixed(1);
    let infoLine, extraTag;
    if(mode==='live'){
      infoLine=`현재가 ${s.entryPrice.toLocaleString()}원 | 목표 ${s.targetPrice.toLocaleString()}원 (+${profitPct}%)`;
      extraTag='<span class="match-tag tomorrow">🌅 내일 매수 후보</span>';
    } else {
      const vBadge=s.verified?'<span class="match-tag verified">✅ +'+s.finalChange+'% 적중</span>':'';
      infoLine=`포착가 ${s.entryPrice.toLocaleString()}원 → 다음날 ${s.finalPrice.toLocaleString()}원 (${s.finalChange>0?'+':''}${s.finalChange}%)`;
      extraTag=vBadge;
    }
    return `<div class="match-item" data-idx="${idx}">
      <div class="match-header">
        <span class="match-name">${m.stock.name}</span>
        <span class="match-reliability ${relClass}">${stars} ${s.reliability}%</span>
      </div>
      <div class="match-signal-date">${s.readiness} ${mode==='live'?'기준봉':'포착일 '+s.evalDate+' | 기준봉'} ${s.baseFdate}</div>
      <div class="match-detail">
        ${infoLine}<br>
        단봉 ${s.avgBody}% | 거래량 ${s.volDryUp}%↓ | 지지 ${s.supportRate}% | 고가대비 ${s.toHighPct}%
      </div>
      <div class="match-tags">
        ${extraTag}
        <span class="match-tag">목표 +${profitPct}%</span>
        <span class="match-tag">조정 ${s.consolDays}일</span>
        <span class="match-tag">${m.stock.market}</span>
      </div>
    </div>`;
  }).join('');
  results.querySelectorAll('.match-item').forEach(el=>{
    el.addEventListener('click',()=>{
      const idx=parseInt(el.dataset.idx);
      results.querySelectorAll('.match-item').forEach(e=>e.classList.remove('active'));
      el.classList.add('active'); loadMatch(allMatches[idx]);
    });
  });
  if(allMatches.length>0){results.querySelector('.match-item').classList.add('active');loadMatch(allMatches[0]);}
}
function loadMatch(match){
  S.stock=match.stock;S.data=match.data;S.signals=match.signals;
  document.getElementById('currentStockName').textContent=match.stock.name;
  document.getElementById('currentStockCode').textContent=match.stock.code+' | 네이버금융';
  document.getElementById('currentPrice').textContent=match.lastPrice.toLocaleString()+'원';
  const chEl=document.getElementById('priceChange');
  chEl.textContent=(match.change>0?'+':'')+match.change+'%';
  chEl.className='price-change '+(parseFloat(match.change)>=0?'price-up':'price-down');
  if(!S.chart)initChart();else{document.getElementById('chartContainer').innerHTML='';initChart();}
  showChart(match.data,match.allSignals);
  renderSignalDetails(match.signals);
}
function renderSignalDetails(signals){
  const el=document.getElementById('signalsList');
  if(!signals.length){el.innerHTML='<div class="empty-state"><span>📭</span><p>시그널 없음</p></div>';return;}
  el.innerHTML=signals.map(s=>{
    const profitPct=((s.targetPrice-s.entryPrice)/s.entryPrice*100).toFixed(1);
    const lossPct=((s.stopLoss-s.entryPrice)/s.entryPrice*100).toFixed(1);
    return `<div class="signal-item">
      <div class="signal-date" style="font-size:13px;font-weight:700">${s.readiness}</div>
      <div class="signal-detail" style="font-size:11px;line-height:1.7">
        <b>① 기준봉:</b> ${s.baseFdate} (+${s.baseChange}%, ×${s.baseVolRatio})<br>
        <b>📉 조정:</b> ${s.consolDays}일간 | 평균 봉크기 ${s.avgBody}%<br>
        <b>🔇 거래량:</b> 기준봉 대비 ${s.volDryUp}% (건조!)<br>
        <b>🛡️ 지지율:</b> ${s.supportRate}% (기준봉 시가 위)<br>
        <b>📊 고가대비:</b> ${s.toHighPct}%<br>
        ──────────<br>
        💎 진입: ${s.entryPrice.toLocaleString()}원<br>
        🎯 목표: ${s.targetPrice.toLocaleString()}원 (+${profitPct}%)<br>
        🚫 손절: ${s.stopLoss.toLocaleString()}원 (${lossPct}%)
      </div>
      <span class="signal-reliability">${s.reliability>=75?'⭐⭐⭐':s.reliability>=55?'⭐⭐':'⭐'} 신뢰도 ${s.reliability}%</span>
    </div>`;
  }).join('');
}
// === 성과 추적: 자동 저장 ===
async function saveSignals(matches) {
  if (!matches.length) return;
  const payload = matches.map(m => {
    const s = m.signals[0];
    return { code: m.stock.code, name: m.stock.name, market: m.stock.market,
      entryPrice: s.entryPrice, targetPrice: s.targetPrice, stopLoss: s.stopLoss,
      readiness: s.readiness, reliability: s.reliability,
      baseFdate: s.baseFdate, baseChange: s.baseChange, toHighPct: s.toHighPct };
  });
  try {
    const r = await fetch('/api/signals/save', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ signals: payload }) });
    const j = await r.json();
    if (j.success) console.log(`💾 ${j.added}건 저장 (총 ${j.total}건)`);
  } catch(e) { console.error('Save error:', e); }
}

// === 성과 추적: 히스토리 로드 ===
async function loadHistory() {
  const el = document.getElementById('historyResults');
  const status = document.getElementById('historyStatus');
  const statsEl = document.getElementById('perfStats');
  status.textContent = '시그널 히스토리 로딩 중...';
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">⏳ 로딩 중...</div>';
  try {
    const r = await fetch('/api/signals/history');
    const j = await r.json();
    if (!j.success || !j.signals.length) {
      status.textContent = '저장된 시그널 없음';
      el.innerHTML = '<div class="empty-state"><span>📭</span><p>아직 저장된 시그널이 없어요<br>스캔하면 자동 저장됩니다!</p></div>';
      return;
    }
    // 현재가 가져오기
    const codes = [...new Set(j.signals.map(s => s.code))];
    status.textContent = `${codes.length}개 종목 현재가 조회 중...`;
    const pr = await fetch('/api/signals/prices', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ codes }) });
    const pj = await pr.json();
    const prices = pj.success ? pj.prices : {};
    // 수익률 계산
    const enriched = j.signals.map(s => {
      const cp = prices[s.code];
      const currentPrice = cp ? cp.close : s.entryPrice;
      const returnPct = ((currentPrice - s.entryPrice) / s.entryPrice * 100);
      const hitTarget = currentPrice >= s.targetPrice;
      const hitStop = currentPrice <= s.stopLoss;
      const daysHeld = Math.floor((Date.now() - new Date(s.savedAt).getTime()) / 86400000);
      return { ...s, currentPrice, returnPct, hitTarget, hitStop, daysHeld };
    });
    // 통계
    const total = enriched.length;
    const wins = enriched.filter(s => s.returnPct > 0).length;
    const losses = enriched.filter(s => s.returnPct < 0).length;
    const avgRet = enriched.reduce((a, s) => a + s.returnPct, 0) / total;
    const winRate = (wins / total * 100).toFixed(1);
    statsEl.style.display = 'block';
    document.getElementById('statTotal').textContent = total + '건';
    document.getElementById('statWin').textContent = wins + '건';
    document.getElementById('statLoss').textContent = losses + '건';
    document.getElementById('statWinRate').textContent = winRate + '%';
    document.getElementById('statAvgReturn').textContent = (avgRet >= 0 ? '+' : '') + avgRet.toFixed(1) + '%';
    document.getElementById('statAvgReturn').style.color = avgRet >= 0 ? '#00d4aa' : '#ff4757';
    document.getElementById('statWinRate').style.color = parseFloat(winRate) >= 50 ? '#00d4aa' : '#ff4757';
    status.textContent = `총 ${total}건 | 승률 ${winRate}%`;
    // 날짜별 그룹핑 (최신순)
    const grouped = {};
    enriched.forEach(s => { if (!grouped[s.savedAt]) grouped[s.savedAt] = []; grouped[s.savedAt].push(s); });
    const dates = Object.keys(grouped).sort().reverse();
    let html = '';
    dates.forEach(date => {
      const dayItems = grouped[date];
      const dayAvg = dayItems.reduce((a, s) => a + s.returnPct, 0) / dayItems.length;
      html += `<div class="history-group-title">📅 ${date} (${dayItems.length}건 | 평균 ${dayAvg >= 0 ? '+' : ''}${dayAvg.toFixed(1)}%)</div>`;
      dayItems.sort((a, b) => b.returnPct - a.returnPct);
      dayItems.forEach(s => {
        const cls = s.returnPct > 0 ? 'profit' : s.returnPct < 0 ? 'loss' : 'pending';
        const retCls = s.returnPct > 0 ? 'up' : s.returnPct < 0 ? 'down' : 'flat';
        const status = s.hitTarget ? '🎯 목표달성!' : s.hitStop ? '🚫 손절' : '⏳ 보유중';
        html += `<div class="history-item ${cls}">
          <div class="hist-header">
            <span class="hist-name">${s.name}</span>
            <span class="hist-return ${retCls}">${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(1)}%</span>
          </div>
          <div class="hist-detail">
            진입 ${s.entryPrice.toLocaleString()}원 → 현재 ${s.currentPrice.toLocaleString()}원 | ${status}<br>
            기준봉 ${s.baseFdate} (+${s.baseChange}%) | ${s.daysHeld}일 경과
          </div>
        </div>`;
      });
    });
    el.innerHTML = html;
  } catch(e) { status.textContent = '로딩 실패'; console.error(e); }
}

// === INIT ===
document.addEventListener('DOMContentLoaded',()=>{
  function updateTime(){const now=new Date(),h=now.getHours();
    const st=h>=9&&h<15?'🟢 장중':h>=15&&h<16?'🟡 시간외':'🔴 장마감';
    document.getElementById('marketTime').textContent=st+' '+now.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});}
  updateTime();setInterval(updateTime,30000);
  document.getElementById('btnScan').addEventListener('click',runScan);
  // 모드 토글 → 자동 재스캔
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const prev = S.scanMode;
      document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      S.scanMode=btn.dataset.mode;
      if(prev !== S.scanMode) runScan();
    });
  });
  document.querySelectorAll('.range-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{document.querySelectorAll('.range-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');S.months=parseInt(btn.dataset.months);});
  });
  const PM={paramBullishRate:{k:'bullishRate',s:'%',v:'valBullishRate'},paramVolMultiple:{k:'volMultiple',s:'x',v:'valVolMultiple'},paramVolDecline:{k:'volDecline',s:'%',v:'valVolDecline'},paramBearishMax:{k:'bearishMax',s:'%',v:'valBearishMax'},paramRecentDays:{k:'recentDays',s:'일',v:'valRecentDays'}};
  Object.entries(PM).forEach(([id,cfg])=>{const inp=document.getElementById(id);if(!inp)return;
    inp.addEventListener('input',()=>{S.params[cfg.k]=parseFloat(inp.value);document.getElementById(cfg.v).textContent=inp.value+cfg.s;});
  });
  // 탭 전환 (display 속성도 직접 제어)
  document.querySelectorAll('.sidebar-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.sidebar-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      // 모든 탭 콘텐츠 숨기기
      document.querySelectorAll('.tab-content').forEach(t=>{
        t.classList.remove('active');
        t.style.display='none';
      });
      // 선택된 탭 보이기
      const targetMap = {
        'scan': 'tabScan',
        'history': 'tabHistory',
        'newscan': 'tabNewScan',
        'closing': 'tabClosing',
        'tomorrow': 'tabTomorrow',
        'rebound': 'tabRebound',
        'minervini': 'tabMinervini',
        'vcp': 'tabVcp'
      };
      const target = targetMap[tab.dataset.tab] || 'tabScan';
      const el = document.getElementById(target);
      if (el) { el.classList.add('active'); el.style.display='flex'; }
      
      // 차트 영역 및 시그널 영역 토글
      const isNew = tab.dataset.tab === 'newscan';
      const isClosing = tab.dataset.tab === 'closing';
      const isTomorrow = tab.dataset.tab === 'tomorrow';
      const isRebound = tab.dataset.tab === 'rebound';
      const isMinervini = tab.dataset.tab === 'minervini';
      const isVcp = tab.dataset.tab === 'vcp';

      const isMain = !isNew && !isClosing && !isTomorrow && !isRebound && !isMinervini && !isVcp;

      document.getElementById('chartContainer').style.display = isMain ? 'block' : 'none';
      if(document.getElementById('newChartContainer')) document.getElementById('newChartContainer').style.display = isNew ? 'block' : 'none';
      if(document.getElementById('closingChartContainer')) document.getElementById('closingChartContainer').style.display = isClosing ? 'block' : 'none';
      if(document.getElementById('tomorrowChartContainer')) document.getElementById('tomorrowChartContainer').style.display = isTomorrow ? 'block' : 'none';
      if(document.getElementById('reboundChartContainer')) document.getElementById('reboundChartContainer').style.display = isRebound ? 'block' : 'none';
      if(document.getElementById('minerviniChartContainer')) document.getElementById('minerviniChartContainer').style.display = isMinervini ? 'block' : 'none';
      if(document.getElementById('vcpTableContainer')) document.getElementById('vcpTableContainer').style.display = isVcp ? 'block' : 'none';
      
      document.getElementById('signalsList').style.display = isMain ? 'block' : 'none';
      if(document.getElementById('newSignalsList')) document.getElementById('newSignalsList').style.display = isNew ? 'block' : 'none';
      if(document.getElementById('closingSignalsList')) document.getElementById('closingSignalsList').style.display = isClosing ? 'block' : 'none';
      if(document.getElementById('tomorrowSignalsList')) document.getElementById('tomorrowSignalsList').style.display = isTomorrow ? 'block' : 'none';
      if(document.getElementById('reboundSignalsList')) document.getElementById('reboundSignalsList').style.display = isRebound ? 'block' : 'none';
      if(document.getElementById('minerviniSignalsList')) document.getElementById('minerviniSignalsList').style.display = isMinervini ? 'block' : 'none';
      if(document.getElementById('vcpSignalsList')) document.getElementById('vcpSignalsList').style.display = isVcp ? 'block' : 'none';
      
      if(document.getElementById('signalLegend')) document.getElementById('signalLegend').style.display = isMain ? 'flex' : 'none';
      if(document.getElementById('newSignalLegend')) document.getElementById('newSignalLegend').style.display = isNew ? 'flex' : 'none';
      if(document.getElementById('closingSignalLegend')) document.getElementById('closingSignalLegend').style.display = isClosing ? 'flex' : 'none';
      if(document.getElementById('tomorrowSignalLegend')) document.getElementById('tomorrowSignalLegend').style.display = isTomorrow ? 'flex' : 'none';
      if(document.getElementById('reboundSignalLegend')) document.getElementById('reboundSignalLegend').style.display = isRebound ? 'flex' : 'none';
      if(document.getElementById('minerviniSignalLegend')) document.getElementById('minerviniSignalLegend').style.display = isMinervini ? 'flex' : 'none';

      // VCP는 signal legend가 없음
      
      const strategyCard = document.querySelector('.strategy-card:not(.closing-strategy):not(.tomorrow-strategy):not(.rebound-strategy):not(.minervini-strategy):not(.vcp-strategy)');
      const closingStrategyCard = document.getElementById('closingStrategyCard');
      const tomorrowStrategyCard = document.getElementById('tomorrowStrategyCard');
      const reboundStrategyCard = document.getElementById('reboundStrategyCard');
      const minerviniStrategyCard = document.getElementById('minerviniStrategyCard');
      const vcpStrategyCard = document.getElementById('vcpStrategyCard');
      
      if (strategyCard) strategyCard.style.display = isMain ? 'block' : 'none';
      if (closingStrategyCard) closingStrategyCard.style.display = isClosing ? 'block' : 'none';
      if (tomorrowStrategyCard) tomorrowStrategyCard.style.display = isTomorrow ? 'block' : 'none';
      if (reboundStrategyCard) reboundStrategyCard.style.display = isRebound ? 'block' : 'none';
      if (minerviniStrategyCard) minerviniStrategyCard.style.display = isMinervini ? 'block' : 'none';
      if (vcpStrategyCard) vcpStrategyCard.style.display = isVcp ? 'block' : 'none';

      // Hide stock info bar for VCP as it uses table header
      const stockInfoBar = document.getElementById('stockInfoBar');
      if (stockInfoBar) stockInfoBar.style.display = isVcp ? 'none' : 'flex';

      if (tab.dataset.tab === 'history') loadHistory();
    });
  });
  // 검색
  let searchTO;
  const sI=document.getElementById('searchInput'),sR=document.getElementById('searchResults');
  sI.addEventListener('input',()=>{clearTimeout(searchTO);const q=sI.value.trim();
    if(q.length<1){sR.classList.remove('show');return;}
    const local=S.stocks.filter(s=>s.name.includes(q)||s.code.includes(q)).slice(0,10);
    if(local.length){
      sR.innerHTML=local.map(s=>`<div class="search-result-item" data-code="${s.code}"><span>${s.name}</span><span style="color:var(--text-muted);font-size:10px">${s.code}</span></div>`).join('');
      sR.classList.add('show');
      sR.querySelectorAll('.search-result-item').forEach(item=>{
        item.addEventListener('click',async()=>{const code=item.dataset.code;
          const stock=S.stocks.find(s=>s.code===code)||{code,name:item.querySelector('span').textContent,market:''};
          sR.classList.remove('show');sI.value='';document.getElementById('loadingOverlay').style.display='flex';
          try{const r=await fetch(`/api/chart/${code}?months=${S.months}`);const j=await r.json();
            if(j.success&&j.data.length>0){const allSig=analyzePattern(j.data,S.params,S.scanMode);
              loadMatch({stock,data:j.data,signals:allSig,allSignals:allSig,lastPrice:j.data[j.data.length-1].close,change:j.data.length>=2?((j.data[j.data.length-1].close-j.data[j.data.length-2].close)/j.data[j.data.length-2].close*100).toFixed(2):'0'});}
          }catch(e){alert('실패:'+e.message);}document.getElementById('loadingOverlay').style.display='none';
        });
      });
    }
  });
  sI.addEventListener('blur',()=>setTimeout(()=>sR.classList.remove('show'),200));
  setTimeout(()=>runScan(),300);
});
