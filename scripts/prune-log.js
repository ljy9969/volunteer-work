// 지정 로그 파일에서 N일 보존 (기본 오늘+어제 = 2일치) — 그 이전 라인은 제거
// 사용법:
//   node scripts/prune-log.js <logfile>            # 기본 2일 보존
//   node scripts/prune-log.js <logfile> <N>        # N일 보존
// run-hunt.bat / run.bat가 매 회차 시작 직전(node index.js 호출 전)에 실행
// 별도 프로세스로 분리한 이유: index.js 본체가 stdout >> 로그 리다이렉션 중에 같은 파일을
//   다시 쓰면 Windows에서 핸들 충돌(EBUSY) — bat 단계에서 파일이 열리기 전에 정리하는 게 안전.
//
// log() 포맷:
//  - 회차 첫 줄: [YY-MM-DD 요일 HH:MM:SS]  → 날짜 마커
//  - 이후 줄  : [HH:MM:SS]                 → 시간만 (이전 날짜 마커의 섹션에 속함)
// 시간-only 라인의 날짜를 추정하려면 윗쪽 가장 가까운 날짜 마커를 따라가야 함 → currentSection 추적.
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
    console.error('[prune-log] usage: node scripts/prune-log.js <logfile> [retainDays=2]');
    process.exit(1);
}
const RETAIN_DAYS = Math.max(1, parseInt(process.argv[3] || '2', 10));

const LOG_PATH = path.isAbsolute(target) ? target : path.join(__dirname, '..', target);
if (!fs.existsSync(LOG_PATH)) process.exit(0);

const pad = n => String(n).padStart(2, '0');
const today = new Date();
// 보존 시작일: today - (RETAIN_DAYS - 1). RETAIN_DAYS=2면 어제부터.
const cutoffDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (RETAIN_DAYS - 1));
const cutoffStr = `${String(cutoffDate.getFullYear()).slice(2)}-${pad(cutoffDate.getMonth() + 1)}-${pad(cutoffDate.getDate())}`;

// 날짜 마커 정규식: `[YY-MM-DD ` (요일 직전 공백까지)
const dateRe = /^\[(\d{2}-\d{2}-\d{2})\s/;

try {
    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);
    let currentSection = null; // 'YY-MM-DD' or null (날짜 모름 → drop)
    const kept = lines.filter(line => {
        const m = line.match(dateRe);
        if (m) {
            currentSection = m[1];
        }
        // currentSection이 null이면 (= 파일 시작 ~ 첫 날짜 마커 사이) 추정 불가 → drop
        // 그 외엔 cutoff와 lexicographic 비교 (YY-MM-DD 형식이라 날짜순 정렬 = 문자열 정렬)
        return currentSection !== null && currentSection >= cutoffStr;
    });
    while (kept.length && kept[kept.length - 1] === '') kept.pop();
    fs.writeFileSync(LOG_PATH, kept.length ? kept.join('\n') + '\n' : '');
    console.log(`[prune-log] ${path.basename(LOG_PATH)}: kept ${kept.length} lines from ${cutoffStr} onward (${RETAIN_DAYS}-day retention)`);
} catch (e) {
    console.error(`[prune-log] error: ${e.message}`);
    process.exit(1);
}
