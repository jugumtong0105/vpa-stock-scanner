'use strict';
const URL = 'https://markets.hankyung.com/indices/kospi200';
let cached, expires = 0;
function parseConstituents(html) {
  const names = new Map([...html.matchAll(/class="stock-name ellip"><a href="\/stock\/([A-Z0-9]{6})">([^<]+)<\/a>/g)]
    .map(([,code,name]) => [code,name.replace(/&amp;/g,'&')]));
  const stocks = new Map();
  for (const [,code,name] of html.matchAll(/jmcode:"KR7([A-Z0-9]{6})[A-Z0-9]{3}",shcode:[^,]+,jmseq:[^,]+,shname:("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)/g)) {
    stocks.set(code, {code, name: names.get(code) || (name.startsWith('"') ? JSON.parse(name) : code)});
  }
  if (stocks.size < 195 || stocks.size > 205 || !stocks.has('005930') || !stocks.has('000660'))
    throw Error('코스피200 구성 목록이 불완전합니다.');
  return [...stocks.values()];
}
async function getConstituents() {
  if (cached && Date.now() < expires) return cached;
  const response = await fetch(URL, {signal: AbortSignal.timeout(12000)});
  if (!response.ok) throw Error('코스피200 목록 조회 실패');
  cached = parseConstituents(await response.text());
  expires = Date.now() + 3600000;
  return cached;
}
module.exports = { getConstituents, parseConstituents };
