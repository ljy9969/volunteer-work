# 강동리본센터 자원봉사 예약 자동화 🐶

> 최종 갱신: 2026-04-29 — 사이트 예약내역을 source-of-truth로 사용하는 월간 한도 enforcement + 시작 시 Discord 예약현황 보고 추가.

이 프로젝트는 **강동리본센터**의 자원봉사 사전 예약을 자동화하는 시스템입니다. 매달 15일 관리자가 수동으로 예약 폼을 오픈하면(정확한 시간이 보장되지 않으므로 새로고침 대기가 필요함) 재빨리 토요일 10시 슬롯을 확보하도록 설계되었습니다.

---

## 🤖 시스템 핵심 동작
- **실행 주기**: 매월 15일 **10:58 AM** (스케줄러 기반)
- **종료 조건은 실행 방식에 따라 다름**:
  | 실행 방식 | 판별 | 종료 조건 |
  |----------|------|-----------|
  | 스케줄러 (`run.bat`) | `SCHEDULED=true` 환경변수 세팅 | 슬롯 확보 성공 또는 **11:30 AM 도달**까지 무제한 시도 (관리자가 수동으로 슬롯 여는 시점이 예측 불가하므로) |
  | 수동 (`node index.js`) | 환경변수 없음 | 슬롯 확보 성공 또는 **시도 10회(`MAX_ATTEMPTS`) 도달**. **시간 제한 없음** — 언제 돌려도 10회까지 시도 |
  | Hunt (`run-hunt.bat`) | `CANCEL_HUNT=true` 환경변수 | **다음달 예약이 한도(`HUNT_MONTHLY_LIMIT=2`건) 도달 시 즉시 종료** + 시도 10회 후 종료 + 15일이면 즉시 종료 (Monthly와 충돌 방지) |
- **브라우저 창**: `--window-size=1920,1200` + `.env`의 `WINDOW_X`/`WINDOW_Y`로 창 위치 지정. 여러 모니터 환경에서 지정 좌표로 띄우려고 함.
- **예약 로직**: 
  - `form.php` 접속 시 현재 달인 경우, 자동으로 **다음 달(.btn-next)** 버튼을 클릭하여 이동.
  - 다음 달 달력이 정상 로드되면 매 2초마다 토요일 열의 후보 셀을 탐색.
  - 달력의 7번째 열(토요일) 내부에서 날짜로 시작하고 비활성 클래스(`off|disabled|inactive|gray`)가 아닌 셀을 후보로 수집.
  - 슬롯이 열리지 않은 경우 페이지를 새로고침하여 최신 상태를 반영하며 탐색 지속.
  - 후보 셀 클릭 → 우측 패널에서 `10:00 ... 예약가능` substring 매칭 → `1명(예약가능)` exact 매칭 → 동의 체크 → submit.
  - "예약하기" 버튼은 상단 탭에도 존재 → 가시(`offsetParent`) + 텍스트 정확 일치 후보 중 마지막(폼 하단의 실제 submit) 선택.
  - 예약 버튼 클릭 후 뜨는 알림창(Window Alert) "예약신청 하셨습니다."의 **확인(Accept)** 클릭까지 완료하여 완전히 예약을 확정.

### 📊 월간 예약 한도 + 사이트 source-of-truth (2026-04-29 추가)
- **사이트가 진실의 원천**: 시작 시 예약 페이지의 `예약내역` 탭에서 `table.list tr.future` 행을 파싱해 다음달 활성 예약 카운트를 읽어옴 (`fetchSiteReservationCount`). `tr.future` = 미래 예약(취소 가능), `tr.last` = 과거 예약 → 제외. 상태값 `신청|확정|대기` 만 카운트.
- **state.json은 백업**: 사이트 조회 실패 시 fallback. `reservations: { "YYYY-MM": [{ day, time, reservedAt }] }` 형식으로 예약 기록 저장. 사이트와 어긋나면 사이트 기준으로 진행.
- **Hunt 모드만 한도 enforcement**: `CANCEL_HUNT=true` 일 때 다음달 카운트가 `HUNT_MONTHLY_LIMIT=2` 도달 시 즉시 종료. Monthly/Manual은 카운트만 보고 진행 (사용자가 직접 통제).
- **모든 모드에서 시작 시 Discord 보고**: 다음달 예약 현황 + 미래 예약 전체 리스트(요일 포함) 발송.

### ⚙️ `.env` 환경 변수
```
USER_ID=ljy9969
USER_PW=...
DRY_RUN=false      # true → 스크린샷만 저장하고 실제 예약 버튼은 누르지 않음
WINDOW_X=973       # 브라우저 창 X 좌표 (가상 데스크톱 기준)
WINDOW_Y=1454      # 브라우저 창 Y 좌표
DISCORD_WEBHOOK=...# 예약 성공/실패/오류 알림 (미설정 시 알림 없음)
```

### 🔔 Discord 알림

모든 메시지 앞에 **`[🐶 Volunteer]`** 프리픽스가 붙습니다. songpa-tennis-auto와 같은 Discord 채널에 보낼 때 출처 구분용.

**알림 정책 (2026-04-30 노이즈 축소)**: 성공 또는 사용자 대응이 필요한 오류만 발송. 시작 시 현황 보고, 카운트 조회 fallback/오류, 가용 슬롯 0건 등 정보성 알림은 제거됨 (콘솔 로그에만 기록).

| 이벤트 | 메시지 (프리픽스 생략) | 해당 모드 |
|-------|-------|----------|
| 예약 성공 ✅ | `🎉 봉사 예약 완료 (M월 D일 토요일 10시) — YYYY-MM 누적 N건` | 모든 모드 |
| 예약 버튼 미발견 ❌ | `🚨 예약 버튼 미발견 — 수동 확인 필요` (슬롯 선택까진 성공했으나 최종 submit 요소 탐색 실패) | 모든 모드 |
| 로그인 실패 ❌ | `🚨 로그인 실패 — 아이디/비밀번호 확인 필요` | 모든 모드 |
| 로그인 오류 ❌ | `⚠️ 로그인 중 오류: ...` | 모든 모드 |
| Monthly 11:30 종료 ⏰ | `🕒 Monthly 스케줄 종료 — 11:30 도달, 이번 달 예약 실패` (당일 예약 실패 confirm) | Monthly만 |

**제거된 알림 (콘솔 로그만 보존)**: 시작 시 예약 현황 보고 / 사이트 카운트 조회 실패 fallback / 카운트 체크 오류 / 10회 시도 실패 / Hunt 한도 도달 / Hunt 15일 회피. 상세 내역은 `logs/hunt.log` 등에서 조회.

---

## 💻 셋업 및 스케줄러 등록 가이드

1. **테스트 (연습 모드)**
   `D:\source\JEON2\volunteer-work`에서 `.env` 파일의 `DRY_RUN`이 `true`인지 확인합니다. 이 모드에서는 동의 체크까지만 한 뒤 실제 예약 버튼은 누르지 않고, 화면 스크린샷만 저장합니다.
   ```powershell
   node index.js
   ```

2. **Windows 스케줄러 등록 (2 트랙)**
   아래 명령어를 **관리자 PowerShell**에서 실행하세요.
   ```powershell
   # Monthly: 매월 15일 10:58 (관리자가 수동 오픈한 슬롯 선착 예약, run.bat은 SCHEDULED=true 세팅)
   schtasks /Create /TN "RebornVolunteer_Monthly" /TR "D:\source\JEON2\volunteer-work\run.bat" /SC MONTHLY /D 15 /ST 10:58 /F /RL HIGHEST

   # Hunt: 평일 09:00~17:30, 30분 간격 (취소 슬롯 사냥, headless + cmd 창 숨김, 15일은 자동 skip)
   #   → run-hunt.vbs가 run-hunt.bat을 창 숨김 모드로 호출. 모니터에 cmd 창 깜빡임 없음.
   schtasks /Create /TN "RebornVolunteer_Hunt" /TR "wscript.exe D:\source\JEON2\volunteer-work\run-hunt.vbs" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 09:00 /RI 30 /DU 0009:00 /F /RL HIGHEST
   ```

   | 스케줄 | 트리거 | bat | 모드 |
   |--------|-------|-----|------|
   | `RebornVolunteer_Monthly` | 매월 15일 10:58 | `run.bat` (`SCHEDULED=true`) | Monthly — 11:30까지 무제한 시도, UI 표시 |
   | `RebornVolunteer_Hunt` | 평일 09:00~17:30 30분 간격 | `run-hunt.bat` (`CANCEL_HUNT=true`) | Hunt — 10회 시도 후 종료, headless, **15일은 자동 skip** (Monthly와 충돌 방지) |

3. **실전 세팅 (DRY RUN 비활성화)**
   스케줄러 등록이 완료되었다면 다음 예약일 전엔 꼭 `D:\source\JEON2\volunteer-work\.env` 파일을 열고, `DRY_RUN`을 `false`로 바꿔주세요.

### 🗂 로그 자동 정리 (2026-04-30~)
- 매 실행 시작 시 `logs/*.log` 파일의 mtime이 자정 이전이면 truncate(당일 로그만 보존). 단일 누적 파일이라 파일은 유지되고 내용만 비워짐. 다음 날 첫 fire에서 어제 로그가 사라짐.

### 🔔 주의사항
- 스크립트가 실행될 때는 PC가 켜져 있어야 하며, 절전 모드이면 동작하지 않습니다. (노트북의 경우 절전 모드 설정 해제 권장)
