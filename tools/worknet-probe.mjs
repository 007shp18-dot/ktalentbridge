#!/usr/bin/env node
// Answers the one question the public docs do not: how much text does the
// Worknet recruitment API actually hand back per posting?
//
// Everything about the visa column depends on it. Structured fields alone
// (회사명, 급여, 지역, 직종코드) carry no sponsorship signal — the signal lives in
// prose. If the detail call returns a body, the column is parseable. If it
// returns only short metadata plus a URL, the text is on the Worknet web page
// and reaching it is a different decision with different rules.
//
//   node tools/worknet-probe.mjs <key> [엔드포인트URL]
//
// The same Worknet data is published in two places and they do not take the same
// key. work24.go.kr is the original but is 기업회원 전용 with a staff review;
// data.go.kr republishes it and issues a key to an ordinary account. Pass the
// endpoint the portal shows you and this picks the right key parameter for it,
// so whichever key arrives first can be used immediately.
//
// Reads nothing, writes nothing, changes nothing. Two GET calls, then it prints
// what came back.

const KEY = process.argv[2] || process.env.WORKNET_KEY;
const BASE = process.argv[3]
  || process.env.WORKNET_ENDPOINT
  || 'https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do';

if (!KEY) {
  console.error('사용법: node tools/worknet-probe.mjs <key> [엔드포인트URL]');
  console.error('');
  console.error('  work24.go.kr 키:  node tools/worknet-probe.mjs <authKey>');
  console.error('  data.go.kr 키:    node tools/worknet-probe.mjs <serviceKey> <포털에_표시된_엔드포인트>');
  process.exit(1);
}

// data.go.kr calls it serviceKey; work24 calls it authKey. Same idea, different
// name, and the wrong one just returns an auth error that looks like a bug.
const isDataGoKr = /data\.go\.kr/i.test(BASE);
const KEY_PARAM = isDataGoKr ? 'serviceKey' : 'authKey';

// data.go.kr hands out the key twice, URL-encoded and not. Encoding an already
// encoded key is the single most common reason these calls fail, so detect it
// rather than let it look like a rejected key.
const LOOKS_ENCODED = /%[0-9A-Fa-f]{2}/.test(KEY);

// Field discovery only — a real parser comes later, once we know the shape.
// Leaf elements only. A pattern that allows '<' inside the body lets the
// outermost container match the whole document and swallow every field in it.
function elements(xml) {
  const found = new Map();
  const leaf = /<([A-Za-z][\w:.-]*)\s*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  for (const [, name, cdata, plain] of xml.matchAll(leaf)) {
    const value = (cdata !== undefined ? cdata : (plain || '')).trim();
    if (!found.has(name)) found.set(name, []);
    found.get(name).push(value);
  }
  return found;
}

const VISA_HINT = /비자|체류|외국인|국적|스폰서|sponsor|visa/i;

function describe(label, xml) {
  console.log(`\n${'='.repeat(64)}\n${label}\n${'='.repeat(64)}`);
  console.log(`응답 길이: ${xml.length.toLocaleString()}자`);

  const fields = elements(xml);
  if (!fields.size) {
    console.log('필드를 못 찾았어. 원문 앞부분:\n' + xml.slice(0, 600));
    return fields;
  }

  const rows = [...fields.entries()].map(([name, values]) => {
    const longest = values.reduce((max, value) => Math.max(max, value.length), 0);
    return { name, count:values.length, longest, sample:values.find(Boolean) || '' };
  }).sort((a, b) => b.longest - a.longest);

  console.log(`\n필드 ${rows.length}개 (긴 순):\n`);
  for (const row of rows) {
    const flag = row.longest >= 100 ? ' ← 본문급' : '';
    console.log(`  ${row.name.padEnd(24)} 최대 ${String(row.longest).padStart(5)}자  ×${row.count}${flag}`);
    if (row.sample) console.log(`  ${' '.repeat(24)} "${row.sample.replace(/\s+/g, ' ').slice(0, 90)}"`);
  }

  const bodyish = rows.filter(row => row.longest >= 100);
  console.log(`\n100자 넘는 필드: ${bodyish.length ? bodyish.map(r => r.name).join(', ') : '없음'}`);

  const mentioning = rows.filter(row => VISA_HINT.test(row.sample));
  console.log(`비자/외국인 언급 필드: ${mentioning.length ? mentioning.map(r => r.name).join(', ') : '없음 (이 표본에서는)'}`);

  return fields;
}

async function call(params, label) {
  const query = new URLSearchParams({ returnType:'XML', ...params });
  // URLSearchParams would re-encode an already-encoded key, so append it raw
  // when it arrives that way.
  const url = LOOKS_ENCODED
    ? `${BASE}?${KEY_PARAM}=${KEY}&${query}`
    : `${BASE}?${new URLSearchParams({ [KEY_PARAM]:KEY, ...Object.fromEntries(query) })}`;
  console.log(`\n요청: ${url.replace(KEY, `<${KEY_PARAM}>`)}`);
  const response = await fetch(url, { headers:{ 'User-Agent':'ktalentbridge-probe/1.0' } });
  const text = await response.text();
  console.log(`HTTP ${response.status} ${response.headers.get('content-type') || ''}`);
  if (!response.ok) {
    console.log(text.slice(0, 600));
    return null;
  }
  return describe(label, text);
}

(async () => {
  const list = await call(
    { callTp:'L', startPage:'1', display:'10' },
    '1) 목록 호출 (callTp=L)'
  );
  if (!list) return;

  const authNo = (list.get('wantedAuthNo') || list.get('wantedAuthNoI') || [])[0];
  if (!authNo) {
    console.log('\n구인인증번호를 못 찾아서 상세 호출을 건너뛰어. 위 필드 목록에서 인증번호 필드명을 찾아 알려줘.');
    return;
  }

  await call(
    { callTp:'D', wantedAuthNo:authNo },
    `2) 상세 호출 (callTp=D, wantedAuthNo=${authNo})`
  );

  console.log(`
${'='.repeat(64)}
판단 기준
${'='.repeat(64)}
· 상세 응답에 '본문급' 필드가 있으면  → 파싱 가능. 예정대로 진행.
· 짧은 필드 + URL 뿐이면            → 본문이 API에 없다는 뜻.
                                      워크넷 웹페이지를 긁는 건 별개 결정이야.
· '우대조건' 필드에 뭐가 들어있는지가 제일 중요해. 비자 문구는 보통 거기 있어.
`);
})();
