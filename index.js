const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
require('dotenv').config();

chromium.use(stealth);

// ── 영속 상태 관리 (월별 예약 건수 추적) ────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');
const HUNT_MONTHLY_LIMIT = 1; // Hunt 모드 — 한 달 1건 도달 시 자동 종료

function readState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return { reservations: {} };
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        if (!s.reservations) s.reservations = {};
        return s;
    } catch (e) {
        console.log(`[State] 읽기 실패 → 기본값: ${e.message}`);
        return { reservations: {} };
    }
}

function writeState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { console.log(`[State] 쓰기 실패: ${e.message}`); }
}

// env 값은 trim — cmd의 `set NAME=value && ...` 패턴은 trailing space를 값에 포함시켜 비교 실패를 유발.
const _env = (k, dflt = '') => (process.env[k] != null ? String(process.env[k]).trim() : dflt);

// Hunt 모드 강제 종료 안전장치 — browser.close가 hang하면 node가 안 죽고 Task Scheduler가 "이미 실행 중"으로 다음 fires를 skip시키는 구조적 사고 방지.
// 5분 안에 정상 종료 못 하면 process.exit(2)로 즉시 kill. Monthly(SCHEDULED) 모드는 11:30까지 폴링이라 제외.
if (_env('CANCEL_HUNT') === 'true') {
    const FORCE_EXIT_MS = 5 * 60 * 1000;
    setTimeout(() => {
        console.log(`[안전장치] ${FORCE_EXIT_MS / 60000}분 경과 — 강제 종료 (browser.close hang 가능성)`);
        process.exit(2);
    }, FORCE_EXIT_MS).unref();
}

// state.json은 동물별로 키를 분리해 충돌 방지 — dog는 기존 형식 유지(prefix 없음), cat는 "cat-" prefix.
const ANIMAL_TYPE = (_env('ANIMAL_TYPE', 'dog')).toLowerCase();
const STATE_KEY_PREFIX = ANIMAL_TYPE === 'cat' ? 'cat-' : '';

function getMonthCount(monthKey) {
    const s = readState();
    return (s.reservations[STATE_KEY_PREFIX + monthKey] || []).length;
}

function recordReservation(monthKey, day, time) {
    const s = readState();
    const key = STATE_KEY_PREFIX + monthKey;
    if (!s.reservations[key]) s.reservations[key] = [];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const reservedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    s.reservations[key].push({ day, time, reservedAt });
    writeState(s);
}

// 사이트 예약내역 탭에서 특정 월 활성 예약 카운트 — source of truth
// 테이블 구조 (table.list):
//  td[0]: 등록번호  /  td[1]: 예약자명  /  td[2]: <span>휴대폰</span><span>예약일</span>
//  td[3]: <span>작성일</span><span>예약상태</span>  /  td[4]: 관리(취소 버튼)
async function fetchSiteReservationCount(page, monthKey) {
    try {
        // 예약내역 탭 클릭
        const tabSelectors = [
            'a:has-text("예약내역")',
            'button:has-text("예약내역")',
            'li:has-text("예약내역")',
            '[role="tab"]:has-text("예약내역")',
        ];
        let tabClicked = false;
        for (const sel of tabSelectors) {
            const t = page.locator(sel).first();
            if (await t.isVisible({ timeout: 800 }).catch(() => false)) {
                await t.click({ force: true }).catch(() => {});
                tabClicked = true;
                break;
            }
        }
        log(`[State] 예약내역 탭 클릭: ${tabClicked ? '✓' : '실패'}`);

        // table.list 로드 대기
        await page.waitForSelector('table.list tbody tr', { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(300);

        const result = await page.evaluate((monthKey) => {
            // 월별 한도 산정은 future/last 구분 없이 — 이미 진행한 봉사도 그달 정원을 채운다(2026-05-02처럼 오늘 기준 과거여도 5월 2건 한도에 포함).
            // 취소된 예약만 제외하면 충분: 활성 상태('신청','확정','대기')인 모든 행을 카운트.
            const rows = document.querySelectorAll('table.list tbody tr');
            const all = [];          // 활성 상태 예약 (월 무관)
            const monthOnly = [];    // 타겟월만
            for (const r of rows) {
                const tds = r.querySelectorAll('td');
                if (tds.length < 4) continue;
                const dateSpans = tds[2].querySelectorAll('span');
                const statusSpans = tds[3].querySelectorAll('span');
                const date = (dateSpans[dateSpans.length - 1]?.textContent || '').trim();
                const status = (statusSpans[statusSpans.length - 1]?.textContent || '').trim();
                if (!date) continue;
                if (!['신청', '확정', '대기'].includes(status)) continue;
                const item = { date, status };
                all.push(item);
                if (date.startsWith(monthKey)) {
                    monthOnly.push(item);
                }
            }
            return { count: monthOnly.length, monthOnly, all };
        }, monthKey);

        log(`[State] 진단: 활성 ${result.all.length}건 (전체), ${result.count}건 (${monthKey})`);
        return { count: result.count, monthOnly: result.monthOnly, all: result.all, source: 'site' };
    } catch (e) {
        return { count: null, monthOnly: [], all: [], source: 'error', error: e.message };
    }
}

// 요일 헬퍼 (Discord 메시지용)
function dayOfWeekKr(dateStr) {
    // "2026-05-02 10:00" → "토"
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    return ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
}

// 동물별 차이: dog=강아지(tl_HR, 1명 기본), cat=고양이(cl_HR, 2명 기본)
const ANIMAL_LABEL = ANIMAL_TYPE === 'cat' ? '고양이' : '강아지';
const ANIMAL_EMOJI = ANIMAL_TYPE === 'cat' ? '🐱' : '🐶';
const CONFIG = {
    ID: process.env.USER_ID,
    PW: process.env.USER_PW,
    LOGIN_URL: 'http://www.reborncenter.org/bbs/login.php',
    RESERVE_URL: ANIMAL_TYPE === 'cat'
        ? 'http://www.reborncenter.org/plugin/cl_HR/form.php'
        : 'http://www.reborncenter.org/plugin/tl_HR/form.php',
    TARGET_DAY: 6, // 0:일, 1:월, ..., 6:토
    TARGET_TIME_TEXT: '10:00', // 오전 10시
    // 인원수: env > 동물 기본값. cat=2명, dog=1명
    TARGET_PEOPLE: _env('TARGET_PEOPLE') ? parseInt(_env('TARGET_PEOPLE'), 10) : (ANIMAL_TYPE === 'cat' ? 2 : 1),
    DRY_RUN: _env('DRY_RUN') === 'false' ? false : true,
    RELOAD_INTERVAL: 2000, // 2초 대기
    MAX_ATTEMPTS: 10 // 시도 10회 후 종료
};

let _logFirstEmitted = false;
async function log(msg) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (!_logFirstEmitted) {
        const dayKr = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
        // 회차 첫 줄만 [YY-MM-DD 요일 HH:MM:SS] — 이후 라인은 [HH:MM:SS]만
        // 앞에 빈 줄 1개 — 이전 회차/날짜와 시각적 구분 (날짜 경계 가독성)
        const ts = `${String(d.getFullYear()).slice(2)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${dayKr} ${time}`;
        console.log('');
        console.log(`[${ts}] ${msg}`);
        _logFirstEmitted = true;
    } else {
        console.log(`[${time}] ${msg}`);
    }
}

const DISCORD_PREFIX = ANIMAL_TYPE === 'cat' ? '[🐱 Volunteer Cat]' : '[🐶 Volunteer]';
async function notifyDiscord(content) {
    const url = process.env.DISCORD_WEBHOOK;
    if (!url) return;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `${DISCORD_PREFIX} ${content}` })
        });
        if (!res.ok) log(`Discord 응답 ${res.status}`);
    } catch (e) {
        log(`Discord 오류: ${e.message}`);
    }
}

async function start() {
    log(`===========================================`);
    log(`🔥 리본센터 ${ANIMAL_LABEL} 봉사 예약 시스템 시작 ${ANIMAL_EMOJI}`);
    log(`🔥 현재 실행 모드: ${CONFIG.DRY_RUN ? '연습 모드 (DRY_RUN=true)' : '🚨 실제 예약 모드 (DRY_RUN=false)'}`);
    log(`===========================================`);

    if (!CONFIG.ID || !CONFIG.PW) {
        log('오류: .env 파일에 USER_ID 또는 USER_PW가 없습니다.');
        return;
    }

    const CANCEL_HUNT = _env('CANCEL_HUNT') === 'true';

    // SPECIFIC_DATE: 특정 날짜만 노리는 일회성 hunt 모드 (예: 2026-06-20). 그 외 후보는 모두 제외.
    const SPECIFIC_DATE = _env('SPECIFIC_DATE');
    const _sdMatch = SPECIFIC_DATE.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const SPECIFIC_DAY = _sdMatch ? parseInt(_sdMatch[3], 10) : null;
    if (SPECIFIC_DATE && !_sdMatch) {
        log(`[경고] SPECIFIC_DATE 형식 오류 (${SPECIFIC_DATE}) — 무시하고 일반 hunt 진행`);
    }

    // EXCLUDE_DATES: 잡지 않을 날짜 블랙리스트 (yyyy-mm-dd, 콤마 구분). 예: "2026-06-06,2026-06-15"
    // 공휴일/연휴라 사용자가 안 가는 날을 자동 회피.
    const EXCLUDE_DATES = _env('EXCLUDE_DATES')
        .split(',')
        .map(s => s.trim())
        .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));

    // Hunt 모드 + 오늘이 15일이면 월간 스케줄(dog Monthly)과 충돌 방지를 위해 즉시 종료. cat은 Monthly 없음 → 영향 없음.
    if (CANCEL_HUNT && ANIMAL_TYPE === 'dog' && new Date().getDate() === 15) {
        log('[hunt] 오늘은 15일 (월간 스케줄 실행일) — RebornVolunteer와 충돌 방지 위해 종료');
        return;
    }

    // 타겟 month key — 매달 15일부터는 다음달, 1~14일은 현재 달 (사이트는 15일 이후 다음달 예약 오픈)
    const _today = new Date();
    const _targetMonth = _today.getDate() >= 15
        ? new Date(_today.getFullYear(), _today.getMonth() + 1, 1)
        : new Date(_today.getFullYear(), _today.getMonth(), 1);
    const _targetMonthKey = `${_targetMonth.getFullYear()}-${String(_targetMonth.getMonth() + 1).padStart(2, '0')}`;

    const winX = process.env.WINDOW_X ?? '973';
    const winY = process.env.WINDOW_Y ?? '1454';
    // Hunt는 기본 headless. HUNT_HEAD=true 면 검증용으로 화면 띄움.
    const HUNT_HEAD = _env('HUNT_HEAD') === 'true';
    const isHeadless = CANCEL_HUNT && !HUNT_HEAD;
    log(`브라우저 실행... headless=${isHeadless}, window-size=1920,1200, window-position=${winX},${winY}`);
    const browser = await chromium.launch({
        headless: isHeadless,
        args: [
            '--window-size=1920,1200',
            `--window-position=${winX},${winY}`
        ]
    });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1920, height: 1200 });

    // 1. 로그인
    try {
        log('로그인 페이지 접속 중...');
        // 초기 로딩 시 delay 원인이었던 networkidle 방지
        await page.goto(CONFIG.LOGIN_URL, { waitUntil: 'domcontentloaded' });
        
        // 로그인 폼 입력
        await page.fill('input[name="mb_id"]', CONFIG.ID);
        await page.fill('input[name="mb_password"]', CONFIG.PW);
        
        log('로그인 버튼 클릭...');
        
        let loginFailed = false;
        // 얼럿(경고창)이 뜨면 로그인 실패로 간주하도록 클릭 전 미리 세팅
        page.on('dialog', async d => { 
            log(`[시스템 메시지]: ${d.message()}`);
            if (d.message().includes('비밀번호') || d.message().includes('가입') || d.message().includes('로그인')) {
                loginFailed = true;
            }
            await d.accept(); 
        });

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
            // 명확하게 로그인 버튼(input element)만 지정하여 숨겨진 검색 아이콘 등과 충돌 방지
            page.click('input[type="submit"][value="로그인"], input.btn_submit')
        ]);

        // 로그인 이후에도 여전히 로그인 페이지이거나 얼럿이 떴다면 실패한 것
        if (loginFailed || page.url().includes('/login.php')) {
            log('🚨 로그인 실패! 등록하신 아이디와 비밀번호를 확인해주세요.');
            await notifyDiscord('🚨 **로그인 실패** — 아이디/비밀번호 확인 필요');
            log('예약을 진행할 수 없어 프로그램을 안전하게 종료합니다.');
            await browser.close();
            return;
        }

        log('로그인 성공 및 폼 이동 준비 완료');
    } catch (e) {
        log('로그인 중 오류 발생: ' + e.message);
        await notifyDiscord(`⚠️ 로그인 중 오류: ${e.message}`);
        await browser.close();
        return;
    }

    // 2. 예약 폼으로 이동 및 대기 (11시 30분까지)
    log(`예약 페이지 접속: ${CONFIG.RESERVE_URL}`);

    // === 모든 모드 — 사이트 예약내역 조회로 다음달 카운트 체크 (가시성 + Hunt enforcement) ===
    // 사이트가 source of truth (state.json은 외부 변경 미감지). state.json은 backup.
    // 카운트 조회는 모든 모드에서 실행 → 콘솔에 항상 현재 상태 표시
    // 2건 한도 enforcement는 Hunt 모드(CANCEL_HUNT=true)에만 적용
    const SCHEDULED_FOR_LABEL = process.env.SCHEDULED === 'true';
    const _modeLabel = CANCEL_HUNT ? 'Hunt' : (SCHEDULED_FOR_LABEL ? 'Monthly' : 'Manual');
    let _siteCount = null;
    try {
        log(`[State] 타겟월(${_targetMonthKey}) 예약 현황 조회 중...`);
        await page.goto(CONFIG.RESERVE_URL, { waitUntil: 'domcontentloaded' });
        const result = await fetchSiteReservationCount(page, _targetMonthKey);
        if (result.count == null) {
            const fallback = getMonthCount(_targetMonthKey);
            log(`[State] 사이트 조회 실패(${result.error}) → state.json fallback: ${fallback}건`);
            _siteCount = fallback;
        } else {
            _siteCount = result.count;
            log(`[State] 사이트 ${_targetMonthKey} 활성 예약: ${result.count}건 (한도 ${HUNT_MONTHLY_LIMIT}건)`);
            const localCount = getMonthCount(_targetMonthKey);
            if (localCount !== result.count) {
                log(`[State] state.json(${localCount}건) ≠ 사이트(${result.count}건) — 사이트 데이터로 sync`);
            }
            // 사이트 데이터로 state.json 해당 월 덮어쓰기 — 사용자가 사이트에서 취소한 경우 자동 반영
            const _s = readState();
            const _key = STATE_KEY_PREFIX + _targetMonthKey;
            _s.reservations[_key] = (result.monthOnly || []).map(item => {
                const m = item.date.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
                return {
                    day: m ? m[3] : '',
                    time: m && m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : '',
                    status: item.status,
                    syncedAt: new Date().toLocaleString('sv-SE').slice(0, 19)
                };
            });
            writeState(_s);
        }
    } catch (e) {
        log(`[State] 카운트 체크 오류: ${e.message} (진행 강행)`);
    }

    // Hunt 모드만 한도 enforcement
    if (CANCEL_HUNT && _siteCount != null && _siteCount >= HUNT_MONTHLY_LIMIT) {
        log(`[hunt] ${_targetMonthKey} 한도(${HUNT_MONTHLY_LIMIT}건) 도달 → Hunt 종료`);
        await browser.close();
        return;
    }

    let attempts = 0;
    let needsFullReload = true;

    const SCHEDULED = process.env.SCHEDULED === 'true';
    // Monthly(SCHEDULED=true, CANCEL_HUNT=false)만 11:30까지 무제한, 나머지는 MAX_ATTEMPTS 제한
    const unlimitedAttempts = SCHEDULED && !CANCEL_HUNT;
    log(`실행 방식: ${unlimitedAttempts ? 'Monthly 스케줄 (11:30까지 무제한)' : CANCEL_HUNT ? `Hunt 스케줄 (${CONFIG.MAX_ATTEMPTS}회 후 종료, headless)` : `수동 (${CONFIG.MAX_ATTEMPTS}회 후 종료)`}`);

    while (true) {
        attempts++;

        // Monthly가 아닌 경우(수동/Hunt) 시도 횟수 제한
        // 가용 슬롯 없음은 일반적 비-이벤트라 Discord 미발송 (콘솔 로그만)
        if (!unlimitedAttempts && attempts > CONFIG.MAX_ATTEMPTS) {
            log(`🛑 최대 시도 횟수(${CONFIG.MAX_ATTEMPTS}회) 도달 — 프로그램을 종료합니다.`);
            await browser.close();
            return;
        }

        // 11시 30분 컷오프는 Monthly 실전 실행일 때만 (수동/Hunt는 시간 제한 없음)
        const now = new Date();
        if (unlimitedAttempts && !CONFIG.DRY_RUN && now.getHours() >= 11 && now.getMinutes() >= 30) {
            log('🕒 11시 30분이 되었습니다. 더 이상 예약 슬롯이 오픈되지 않는 것으로 판단하여 프로그램을 종료합니다.');
            await notifyDiscord('🕒 **Monthly 스케줄 종료** — 11:30 도달, 이번 달 예약 실패');
            await browser.close();
            return;
        }

        const tag = `[${attempts}/${CONFIG.MAX_ATTEMPTS}]`;
        try {
            if (needsFullReload) {
                await page.goto(CONFIG.RESERVE_URL, { waitUntil: 'domcontentloaded' });
                needsFullReload = false;
            }

            // 타겟 월 계산 — 15일 이후는 다음달, 1~14일은 현재 달 (사이트 오픈 정책)
            const today = new Date();
            const targetMonthDate = today.getDate() >= 15
                ? new Date(today.getFullYear(), today.getMonth() + 1, 1)
                : new Date(today.getFullYear(), today.getMonth(), 1);
            const expectedText = `${targetMonthDate.getFullYear()}.${String(targetMonthDate.getMonth() + 1).padStart(2, '0')}`;
            // 타겟 월의 토요일 day 목록 (예: 2026-06 → [6, 13, 20, 27])
            const targetSaturdays = (() => {
                const arr = [];
                const lastDay = new Date(targetMonthDate.getFullYear(), targetMonthDate.getMonth() + 1, 0).getDate();
                for (let d = 1; d <= lastDay; d++) {
                    if (new Date(targetMonthDate.getFullYear(), targetMonthDate.getMonth(), d).getDay() === 6) arr.push(d);
                }
                return arr;
            })();

            // 첫 회차에 hunt config 한 번 노출
            if (attempts === 1) {
                const filterDesc = SPECIFIC_DAY != null ? `${SPECIFIC_DATE}만` : '모든 토요일';
                const excludeDesc = EXCLUDE_DATES.length ? ` | 제외 ${EXCLUDE_DATES.join(',')}` : '';
                log(`📍 타겟 ${expectedText} | ${filterDesc}${excludeDesc} | 10시 ${CONFIG.TARGET_PEOPLE}명 | MAX_ATTEMPTS=${CONFIG.MAX_ATTEMPTS}`);
            }

            // 달력 navi h2가 렌더링될 때까지 우선 대기 (페이지 첫 로드 직후 누락 방지)
            await page.waitForSelector('.cal-navi h2', { timeout: 5000 }).catch(() => {});
            let currentMonthText = await page.$eval('.cal-navi h2', el => el.innerText).catch(() => '');

            // 달력 이동 로직 — AJAX 클릭. h2뿐 아니라 table cells도 target month의 토요일을 모두 표시해야
            // "진짜 이동 성공"으로 판정 (race 차단). 한 회차 내 최대 3번 click + polling 대기.
            if (!currentMonthText.includes(expectedText)) {
                let navOk = false;
                let navFailReason = '';
                for (let navAttempt = 0; navAttempt < 3; navAttempt++) {
                    const btn = page.locator('.btn-next').first();
                    try {
                        await btn.waitFor({ state: 'visible', timeout: 2000 });
                    } catch (e) {
                        navFailReason = 'noBtn';
                        break;
                    }
                    await btn.click({ timeout: 2000 }).catch(() => {});
                    // h2 + cells 모두 target month로 동기화될 때까지 polling
                    try {
                        await page.waitForFunction(
                            ({ exp, expectedSat }) => {
                                const h2 = document.querySelector('.cal-navi h2');
                                if (!h2 || !h2.innerText.includes(exp)) return false;
                                const tds = document.querySelectorAll('table tbody tr td:nth-child(7)');
                                const days = new Set();
                                for (const td of tds) {
                                    const m = (td.innerText || '').trim().match(/^(\d{1,2})/);
                                    if (m && !/off|disabled|inactive|gray/i.test(td.className)) days.add(parseInt(m[1], 10));
                                }
                                return expectedSat.every(d => days.has(d));
                            },
                            { exp: expectedText, expectedSat: targetSaturdays },
                            { timeout: 5000 }
                        );
                        navOk = true;
                        currentMonthText = expectedText;
                        break;
                    } catch (e) {
                        currentMonthText = await page.$eval('.cal-navi h2', el => el.innerText).catch(() => '');
                    }
                }
                if (!navOk) {
                    if (navFailReason === 'noBtn') {
                        log(`${tag} .btn-next 미발견 → 페이지 새로고침`);
                    } else {
                        log(`${tag} 달력 이동 실패 (h2='${currentMonthText || '읽기 실패'}', cells 미동기화) → 페이지 새로고침`);
                    }
                    needsFullReload = true;
                    await page.waitForTimeout(CONFIG.RELOAD_INTERVAL);
                    continue;
                }
            }

            // 달력 진입 성공 판정 — 토요일 후보 수집.
            // navi h2와 table cells를 한 evaluate 안에서 atomic snapshot으로 읽음. h2 텍스트만 보고
            // "이동 성공"으로 판단하면 사이트의 AJAX timing race로 cells는 아직 이전 월 데이터인 경우가 있음
            // (예: h2="2026.06"인데 cells는 5월의 [2,9,16,23,30,6] — 5월 토요일 5개를 "후보 5건"으로 잡고 매번 클릭 실패).
            // 후보는 target month의 토요일 day set과 정확히 매칭되는 것만 채택 (그룹화 휴리스틱 폐기).
            const snap = await page.evaluate(() => {
                const navText = document.querySelector('.cal-navi h2')?.innerText?.trim() || '';
                const tds = document.querySelectorAll('table tbody tr td:nth-child(7)');
                const cells = [];
                for (const td of tds) {
                    const text = (td.innerText || '').replace(/\s+/g, ' ').trim();
                    const m = text.match(/^(\d{1,2})/);
                    if (!m) continue;
                    if (/off|disabled|inactive|gray/i.test(td.className)) continue;
                    cells.push({ day: parseInt(m[1], 10), text, className: td.className });
                }
                return { navText, cells };
            });

            // h2 sync 재검증 — nav 클릭 후 h2가 잠시 바뀌었다가 다시 돌아오는 race 방지
            if (!snap.navText.includes(expectedText)) {
                log(`${tag} 달력 동기화 실패 (h2='${snap.navText}') → 페이지 새로고침`);
                needsFullReload = true;
                await page.waitForTimeout(CONFIG.RELOAD_INTERVAL);
                continue;
            }

            // cells 동기화 검증 — target month 토요일이 cells에 모두 포함되어야 진짜 target grid임을 보장.
            // (h2만 6월로 잠시 바뀌었고 cells는 아직 5월 grid인 race 상태에서 6/6 visible cell 클릭 시
            //  사이트가 내부 selectedDate를 5월 인덱스로 처리하여 submit에서 "예약일 값이 유효하지 않습니다" reject되는 사고 방지)
            const cellDays = new Set(snap.cells.map(c => c.day));
            const missingTargetSats = targetSaturdays.filter(d => !cellDays.has(d));
            if (missingTargetSats.length > 0) {
                // cells=[]는 td 자체가 없거나 모두 off/disabled로 필터된 비정상 상태 — 진단 정보를 첫 회차에 dump
                if (snap.cells.length === 0 && attempts === 1) {
                    const dbg = await page.evaluate(() => {
                        const trs = document.querySelectorAll('table tbody tr');
                        const sample = [];
                        for (const tr of trs) {
                            const sat = tr.querySelector('td:nth-child(7)');
                            if (!sat) continue;
                            sample.push({ text: (sat.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20), cls: sat.className });
                            if (sample.length >= 6) break;
                        }
                        return { trCount: trs.length, sample };
                    }).catch(() => ({ trCount: -1, sample: [] }));
                    const sampleStr = dbg.sample.map(s => `'${s.text}'/${s.cls || '(no-class)'}`).join(' | ');
                    log(`${tag} [debug] table tr=${dbg.trCount}, 토요일 td 샘플: ${sampleStr || '(none)'}`);
                }
                log(`${tag} 달력 cells 동기화 실패 (target sat ${missingTargetSats.join(',')}일 미표시, cells=[${[...cellDays].sort((a,b)=>a-b).join(',')}]) → 새로고침`);
                needsFullReload = true;
                await page.waitForTimeout(CONFIG.RELOAD_INTERVAL);
                continue;
            }

            // target month의 토요일 day와 정확히 매칭되는 후보만 — 인접월 cell 자동 제외
            const targetSatSet = new Set(targetSaturdays);
            let satInfos = snap.cells.filter(c => targetSatSet.has(c.day));
            const droppedDays = snap.cells.filter(c => !targetSatSet.has(c.day)).map(c => c.day);

            // EXCLUDE_DATES — 타겟월 안의 제외일만 골라 적용
            const _targetMonthPrefix = `${targetMonthDate.getFullYear()}-${String(targetMonthDate.getMonth() + 1).padStart(2, '0')}`;
            const _excludeDays = EXCLUDE_DATES
                .filter(d => d.startsWith(_targetMonthPrefix))
                .map(d => parseInt(d.slice(-2), 10));
            if (_excludeDays.length) satInfos = satInfos.filter(s => !_excludeDays.includes(s.day));

            if (SPECIFIC_DAY != null) satInfos = satInfos.filter(s => s.day === SPECIFIC_DAY);

            let slotFound = false;
            // 'noTime' = 10시 슬롯 자체 없음, 'noPeople' = 10시 ✓ but 인원 매진
            let bestOutcome = 'noTime';

            if (satInfos.length > 0) {
                for (const slot of satInfos) {
                    // fresh DOM 매칭 click — handle 보관 시 stale 발생
                    const clicked = await page.evaluate((targetDay) => {
                        const tds = document.querySelectorAll('table tbody tr td:nth-child(7)');
                        for (const td of tds) {
                            const m = (td.innerText || '').trim().match(/^(\d{1,2})/);
                            if (m && parseInt(m[1], 10) === targetDay) { td.click(); return true; }
                        }
                        return false;
                    }, slot.day);
                    if (!clicked) continue;
                    await page.waitForTimeout(600); // AJAX 로딩 대기

                    // 우측 패널에서 "10:00" 포함 요소 찾기 (exact match 대신 substring)
                    const times = await page.$$('text=/10:00/');
                    let timeClicked = false;
                    for (const t of times) {
                        const tText = (await t.innerText()).replace(/\s+/g, ' ').trim();
                        if (tText.includes('10:00') && tText.includes('예약가능')) {
                            log(`${tag} [발견] ${slot.text}일 10시 예약가능 — 클릭 (${tText})`);
                            await t.click();
                            timeClicked = true;
                            break;
                        }
                    }
                    if (!timeClicked) continue;
                    if (bestOutcome === 'noTime') bestOutcome = 'noPeople';
                    await page.waitForTimeout(800); // 인원 패널 렌더링 대기 — 300ms은 부족했음

                    // 인원 선택 — site의 N명 button이 일반 div with onclick인 경우가 많아 button/a 태그로 못 찾음.
                    // 전략: leaf의 own text가 정확히 "N명"인 element 찾고, 거기서 위로 올라가며 "N명" + "예약가능"
                    // 둘 다 포함하고 다른 인원 숫자(N±1 등)는 포함 안 하는 가장 작은 ancestor를 click 타겟으로.
                    const peopleN = CONFIG.TARGET_PEOPLE;
                    const peopleClick = await page.evaluate((targetN) => {
                        const all = Array.from(document.querySelectorAll('*'));
                        for (const el of all) {
                            const own = (Array.from(el.childNodes)
                                .filter(n => n.nodeType === 3)
                                .map(n => n.textContent).join('') || '').trim();
                            if (!new RegExp(`(^|[^\\d])${targetN}명($|[^\\d])`).test(own)) continue;
                            // leaf 부터 6단계 위까지: 가장 작은 ancestor 중 (N명 단독 + 예약가능 + 예약불가 아님)
                            let target = el;
                            for (let i = 0; i < 6 && target; i++) {
                                const t = (target.innerText || '').replace(/\s+/g, ' ');
                                const peopleNums = [...t.matchAll(/(\d+)명/g)].map(m => parseInt(m[1], 10));
                                const onlyTargetN = peopleNums.length > 0 && peopleNums.every(n => n === targetN);
                                const hasOk = /예약가능/.test(t);
                                const hasNotOk = /(예약\s*불가|예약불가능|불가능)/.test(t);
                                if (onlyTargetN && hasOk && !hasNotOk) {
                                    target.click();
                                    return { ok: true, text: t.slice(0, 80), tag: target.tagName, depth: i };
                                }
                                target = target.parentElement;
                            }
                        }
                        // fallback — leaf 자체 click이라도 시도 (bubble로 onclick handler trigger)
                        for (const el of all) {
                            const own = (Array.from(el.childNodes)
                                .filter(n => n.nodeType === 3)
                                .map(n => n.textContent).join('') || '').trim();
                            if (own !== `${targetN}명`) continue;
                            // 같은 줄(부모)의 텍스트가 "(예약가능)"으로 끝나면 클릭
                            const parentText = (el.parentElement?.innerText || '').replace(/\s+/g, ' ');
                            if (/예약가능/.test(parentText) && !/(예약\s*불가|예약불가능|불가능)/.test(parentText)) {
                                el.click();
                                return { ok: true, text: parentText.slice(0, 80), tag: 'leaf-' + el.tagName, depth: -1 };
                            }
                        }
                        return { ok: false };
                    }, peopleN);
                    if (peopleClick.ok) {
                        log(`[성공] ${peopleN}명 인원 선택 완료 (depth=${peopleClick.depth}, ${peopleClick.tag}: ${peopleClick.text.trim()})`);
                        slotFound = true;
                    }
                    if (!slotFound) continue;

                    await page.waitForTimeout(300);

                    // 동의 체크박스 클릭
                    const agreeCheck = await page.$('input[type="checkbox"]');
                    if (agreeCheck) {
                        await agreeCheck.check();
                        log('[성공] 약관 동의 체크 완료');
                    }

                    if (CONFIG.DRY_RUN) {
                        log('[DRY RUN] 연습 모드이므로 실제 예약을 진행하지 않고 스크린샷을 저장합니다.');
                        await page.screenshot({ path: 'volunteer_dry_run.png' });
                        await browser.close();
                        return;
                    }

                    // 기존 dialog 핸들러 제거 후 submit 결과용 리스너 등록 (double-accept 방지)
                    // 메시지에 실패 키워드(유효하지/불가/실패/오류/이미)가 있으면 reservationFailed=true 로 표시
                    let reservationFailed = false;
                    let reservationFailMessage = '';
                    page.removeAllListeners('dialog');
                    page.on('dialog', async d => {
                        const msg = d.message();
                        log(`[예약 결과 dialog] ${msg}`);
                        if (/유효하지\s*않|예약\s*불가|예약불가|실패|오류|에러|이미\s*예약|초과|오류가\s*발생/.test(msg)) {
                            reservationFailed = true;
                            reservationFailMessage = msg;
                        }
                        await d.accept();
                    });

                    // "예약하기" 문자열은 상단 탭에도 있으므로, 보이는 버튼/submit 후보 중
                    // 마지막(폼 하단의 실제 submit) 것을 선택
                    await page.evaluate(() => {
                        const cands = Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"]'))
                            .filter(el => el.offsetParent !== null && ((el.innerText || el.value || '').trim() === '예약하기'));
                        if (cands.length === 0) return;
                        cands[cands.length - 1].setAttribute('data-submit-target', '1');
                    });
                    const submitBtn = await page.$('[data-submit-target="1"]');
                    if (submitBtn) {
                        await submitBtn.scrollIntoViewIfNeeded();
                        await submitBtn.click();
                        log('🎉 예약하기 버튼 클릭 완료!');

                        await page.waitForTimeout(3500); // 팝업창 및 화면 처리 대기
                        if (reservationFailed) {
                            // 사이트가 dialog로 reject — 기록하지 않고 다음 회차에서 재시도
                            log(`🚨 사이트가 예약 거부: "${reservationFailMessage}" — state.json 미기록`);
                            await notifyDiscord(`🚨 **${ANIMAL_LABEL} 예약 거부** (${slot.day}일 10시): "${reservationFailMessage}"`);
                            // 이번 후보는 실패 → 다음 후보로
                            slotFound = false;
                            needsFullReload = true;
                            continue;
                        }
                        await page.screenshot({ path: 'volunteer_success.png' });
                        const reservedDay = (slot.text.match(/^\d{1,2}/) || [''])[0];
                        const reservedMonth = targetMonthDate.getMonth() + 1;
                        const monthKey = `${targetMonthDate.getFullYear()}-${String(reservedMonth).padStart(2, '0')}`;
                        recordReservation(monthKey, reservedDay, '10:00');
                        const newCount = getMonthCount(monthKey);
                        log(`[State] ${monthKey} 예약 ${newCount}건 기록됨`);
                        await notifyDiscord(`🎉 **${ANIMAL_LABEL} 봉사 예약 완료** (${reservedMonth}월 ${reservedDay}일 토요일 10시, ${CONFIG.TARGET_PEOPLE}명) — ${monthKey} 누적 ${newCount}건`);
                        log('프로그램을 종료합니다.');
                        await browser.close();
                        return;
                    } else {
                        log('🚨 예약 버튼을 찾지 못했습니다.');
                        await notifyDiscord('🚨 예약 버튼 미발견 — 수동 확인 필요');
                    }

                    if (slotFound) break; // 이번 달력에서 예약에 성공했다면 종료
                }
            }

            if (!slotFound) {
                let summary;
                if (satInfos.length === 0) {
                    summary = '후보 0건';
                } else if (bestOutcome === 'noPeople') {
                    summary = `후보 ${satInfos.length}건 10시 ✓ / ${CONFIG.TARGET_PEOPLE}명 매진`;
                } else {
                    summary = `후보 ${satInfos.length}건 모두 10시 마감`;
                }
                const dropTag = (attempts === 1 && droppedDays.length) ? ` (인접월 ${droppedDays.join(',')}일 제외)` : '';
                log(`${tag} ${expectedText} ${summary}${dropTag}`);
                await page.waitForTimeout(CONFIG.RELOAD_INTERVAL);
                needsFullReload = true; // 슬롯이 안 보일 때는 페이지 전체를 새로고침하여 최신 데이터 로딩
            }

        } catch (err) {
            log(`${tag} 오류: ${err.message}`);
            await page.waitForTimeout(CONFIG.RELOAD_INTERVAL);
        }
    }
}

start().catch(e => log('심각한 에러: ' + e));
