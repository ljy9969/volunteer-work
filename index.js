const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
require('dotenv').config();

chromium.use(stealth);

// ── 영속 상태 관리 (월별 예약 건수 추적) ────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');
const HUNT_MONTHLY_LIMIT = 2; // Hunt 모드 — 한 달 2건 도달 시 자동 종료

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

function getMonthCount(monthKey) {
    const s = readState();
    return (s.reservations[monthKey] || []).length;
}

function recordReservation(monthKey, day, time) {
    const s = readState();
    if (!s.reservations[monthKey]) s.reservations[monthKey] = [];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const reservedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    s.reservations[monthKey].push({ day, time, reservedAt });
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

const CONFIG = {
    ID: process.env.USER_ID,
    PW: process.env.USER_PW,
    LOGIN_URL: 'http://www.reborncenter.org/bbs/login.php',
    RESERVE_URL: 'http://www.reborncenter.org/plugin/tl_HR/form.php',
    TARGET_DAY: 6, // 0:일, 1:월, ..., 6:토
    TARGET_TIME_TEXT: '10:00', // 오전 10시
    TARGET_PEOPLE: 1, // 1명
    DRY_RUN: process.env.DRY_RUN === 'false' ? false : true,
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
        // prune-log.js가 today 라인을 제거할 때 두 패턴 모두 매칭함
        const ts = `${String(d.getFullYear()).slice(2)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${dayKr} ${time}`;
        console.log(`[${ts}] ${msg}`);
        _logFirstEmitted = true;
    } else {
        console.log(`[${time}] ${msg}`);
    }
}

const DISCORD_PREFIX = '[🐶 Volunteer]';
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
    log(`🔥 리본센터 봉사 예약 시스템 시작 `);
    log(`🔥 현재 실행 모드: ${CONFIG.DRY_RUN ? '연습 모드 (DRY_RUN=true)' : '🚨 실제 예약 모드 (DRY_RUN=false)'}`);
    log(`===========================================`);

    if (!CONFIG.ID || !CONFIG.PW) {
        log('오류: .env 파일에 USER_ID 또는 USER_PW가 없습니다.');
        return;
    }

    const CANCEL_HUNT = process.env.CANCEL_HUNT === 'true';

    // Hunt 모드 + 오늘이 15일이면 월간 스케줄과 충돌 방지를 위해 즉시 종료
    if (CANCEL_HUNT && new Date().getDate() === 15) {
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
    const isHeadless = CANCEL_HUNT; // Hunt는 백그라운드(headless)
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
                log(`[State] state.json(${localCount}건) ≠ 사이트(${result.count}건) — 사이트 기준으로 진행`);
            }
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

            let currentMonthText = await page.$eval('.cal-navi h2', el => el.innerText).catch(() => '');

            // 달력 이동 로직 (AJAX 기반이므로 페이지 로딩 없이 클릭만)
            if (!currentMonthText.includes(expectedText)) {
                log(`현재 달력: ${currentMonthText || '(알수없음)'}. ${expectedText}로 이동을 시도합니다.`);
                
                // Playwright 네이티브 클릭 사용 (더 신뢰도 높음)
                const nextBtn = await page.$('.btn-next');
                if (nextBtn) {
                    await nextBtn.click();
                    await page.waitForTimeout(1500); // AJAX 로딩 대기
                    currentMonthText = await page.$eval('.cal-navi h2', el => el.innerText).catch(() => '');
                } else {
                    log('🚨 다음달 버튼(.btn-next)을 찾을 수 없습니다. 페이지를 새로고침합니다.');
                    needsFullReload = true;
                    continue;
                }
            }

            if (!currentMonthText.includes(expectedText)) {
                log(`[대기 중] 달력이 ${expectedText}로 넘어가지 않았습니다. (현재: ${currentMonthText || '(읽기 실패)'})`);
                log(`${CONFIG.RELOAD_INTERVAL / 1000}초 후 다시 시도합니다.`);
                
                // 계속 안 넘어가면 5회마다 페이지 전체 새로고침
                if (attempts % 5 === 0) {
                    log('지속적으로 달력 이동에 실패하여 페이지를 새로고침합니다.');
                    needsFullReload = true;
                }
                
                await page.waitForTimeout(CONFIG.RELOAD_INTERVAL);
                continue;
            }

            // 달력 진입 성공 — 토요일 후보 탐색
            // 토요일 열의 모든 td를 후보로 (비활성/off 제외 필터는 아래에서 텍스트 기반으로 판단)
            const satCells = await page.$$('table tbody tr td:nth-child(7)');
            const satInfos = [];
            for (let i = 0; i < satCells.length; i++) {
                const info = await satCells[i].evaluate(td => ({
                    text: (td.innerText || '').replace(/\s+/g, ' ').trim(),
                    className: td.className
                }));
                // 숫자(날짜)로 시작하고, 명시적 비활성 클래스가 아닌 셀만
                if (/^\d{1,2}/.test(info.text) && !/off|disabled|inactive|gray/i.test(info.className)) {
                    satInfos.push({ handle: satCells[i], ...info });
                }
            }
            let slotFound = false;

            if (satInfos.length > 0) {
                log(`[알림] 토요일 후보 셀 ${satInfos.length}개 탐색 시작`);
                // await notifyDiscord(`🔔 **토요일 후보 탐색** (${satInfos.length}건)`);

                for (const slot of satInfos) {
                    log(`후보 클릭: "${slot.text}" (class="${slot.className}")`);
                    await slot.handle.click();
                    await page.waitForTimeout(600); // AJAX 로딩 대기

                    // 우측 패널에서 "10:00" 포함 요소 찾기 (exact match 대신 substring)
                    const times = await page.$$('text=/10:00/');
                    let timeClicked = false;
                    for (const t of times) {
                        const tText = (await t.innerText()).replace(/\s+/g, ' ').trim();
                        if (tText.includes('10:00') && tText.includes('예약가능')) {
                            log(`[성공] 10시 예약가능 슬롯 발견! (${tText})`);
                            await t.click();
                            timeClicked = true;
                            break;
                        }
                    }
                    if (!timeClicked) { log('이 날짜엔 10시 예약가능 없음 — 다음 후보'); continue; }
                    await page.waitForTimeout(300);

                    // 인원 선택: "1명(예약가능)" leaf 요소만 정확 매칭 (부모 컨테이너 매칭 시 "불가" 포함되어 실패하던 버그)
                    const persons = await page.$$('text=/1명/');
                    for (const p of persons) {
                        const pText = (await p.innerText()).replace(/\s+/g, ' ').trim();
                        // 정확한 매칭: "1명(예약가능)" 만 — 부모/조상 컨테이너 제외
                        if (/^1명\s*\(\s*예약가능\s*\)$/.test(pText)) {
                            await p.click();
                            log(`[성공] 1명 인원 선택 완료 (${pText})`);
                            slotFound = true;
                            break;
                        }
                    }
                    if (!slotFound) { log('1명 예약가능 없음 — 다음 후보'); continue; }

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
                    page.removeAllListeners('dialog');
                    page.on('dialog', async d => {
                        log(`[예약 결과 dialog] ${d.message()}`);
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
                        await page.screenshot({ path: 'volunteer_success.png' });
                        const reservedDay = (slot.text.match(/^\d{1,2}/) || [''])[0];
                        const reservedMonth = targetMonthDate.getMonth() + 1;
                        const monthKey = `${targetMonthDate.getFullYear()}-${String(reservedMonth).padStart(2, '0')}`;
                        recordReservation(monthKey, reservedDay, '10:00');
                        const newCount = getMonthCount(monthKey);
                        log(`[State] ${monthKey} 예약 ${newCount}건 기록됨`);
                        await notifyDiscord(`🎉 **봉사 예약 완료** (${reservedMonth}월 ${reservedDay}일 토요일 10시) — ${monthKey} 누적 ${newCount}건`);
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
                log(`[시도 ${attempts}] ${expectedText} 슬롯 없음 — ${CONFIG.RELOAD_INTERVAL / 1000}초 후 재시도`);
                await page.waitForTimeout(CONFIG.RELOAD_INTERVAL);
                needsFullReload = true; // 슬롯이 안 보일 때는 페이지 전체를 새로고침하여 최신 데이터 로딩
            }

        } catch (err) {
            log(`탐색 중 오류: ${err.message}. ${CONFIG.RELOAD_INTERVAL / 1000}초 후 재시도...`);
            await page.waitForTimeout(CONFIG.RELOAD_INTERVAL);
        }
    }
}

start().catch(e => log('심각한 에러: ' + e));
