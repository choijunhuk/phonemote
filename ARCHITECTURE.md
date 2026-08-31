# PhoneMote — Architecture

> Android 스마트폰을 Wii 리모컨(센서 + 버튼)으로, PC를 게임기(렌더링 + 게임 로직)로 쓰는
> 웹 기반 모션 게임 플랫폼의 설계 문서.
>
> **이 문서가 코드보다 먼저다.** 구조가 바뀌면 코드보다 이 문서를 먼저 고친다.
> 특히 5장(좌표계)의 매핑표는 실기기 검증 결과로만 바뀌며, 코드에 임시 부호 반전을 넣지 않는다.

- 상태: **Phase 0~4 구현 반영됨** (실기기 좌표 검증 대기)
- 최종 갱신: Phase 4 종료 시점

---

## 1. 개요

### 1.1 한 줄 정의

폰 = 센서 소스, 서버 = 릴레이, PC = 해석기 + 게임.

### 1.2 설계 원칙 (위반 시 리뷰에서 반려)

| # | 원칙 | 의미 |
|---|---|---|
| P1 | 서버는 패킷을 해석하지 않는다 | 룸 라우팅과 소켓 수명 관리만. 게임 로직·센서 해석 0줄. |
| P2 | 폰은 게임을 모른다 | raw 센서값 + 버튼 비트마스크만 보낸다. 좌표 변환·보정·필터 없음. |
| P3 | 모든 해석은 PC | 좌표계 통일 = `SensorNormalizer`, 의미 부여 = `InputMapper`. |
| P4 | Scene은 `GameAction`만 본다 | `scenes/` 에서 `SensorFrame` import 금지. Phase 3에서 lint 규칙으로 강제. |
| P5 | 단방향 파이프라인 | Raw → Canonical → GameAction. 역방향 참조·우회 경로 없음. |
| P6 | 순수 함수 우선 | Normalizer / PointerMode / SwingDetector / TiltMode 는 상태를 명시적 인자·인스턴스 필드로만 갖고 DOM·시간·네트워크를 직접 만지지 않는다(`dt`는 인자로 주입). 그래서 테스트 가능하다. |

### 1.3 지원 환경 (고정)

| 역할 | 환경 | 비고 |
|---|---|---|
| Controller | Android 최신 Google Chrome | **유일한 지원 대상.** iOS/Safari 분기 코드 작성 금지. |
| Game | PC, Chromium 계열 우선 | Phaser 3 |
| Relay | Node.js 20+ (개발 머신은 v22.16.0) | `ws` + Node `https` |

Out of scope: iOS, Android Chrome 외 모바일 브라우저, 네이티브 앱, 인터넷 원격 플레이,
계정/랭킹, 카메라·IR 포인팅.

---

## 2. 실행 토폴로지

```
  [Android Chrome]                 [Node.js]                    [PC Browser]
  controller app                   relay server                  game app
  https://<LAN-IP>:5174   ──WSS──> wss://<LAN-IP>:8443 <──WSS──  https://<LAN-IP>:5173
        (Vite)                    (https + ws)                      (Vite)
```

- **모든 통신은 secure context.** `http://`, `ws://` 는 어디에도 쓰지 않는다.
  - 이유 1: `DeviceMotionEvent` / `DeviceOrientationEvent` 는 secure context에서만 발화한다.
  - 이유 2: HTTPS 페이지에서 `ws://` 를 열면 mixed content로 차단된다.
- 세 프로세스 모두 같은 mkcert 인증서(LAN IP를 SAN에 포함)를 쓴다.
- Vite 두 앱 모두 `server.host: '0.0.0.0'`, `server.https: { key, cert }`.

### 2.1 LAN IP 결정 규칙 (`apps/server/src/lanIp.ts`)

1. 환경변수 `PHONEMOTE_HOST` 가 있으면 무조건 그 값을 쓴다.
2. 없으면 `os.networkInterfaces()` 중 IPv4 · non-internal · 사설 대역(`10.`, `172.16~31.`, `192.168.`)만 후보.
3. 인터페이스 이름에 `docker`, `veth`, `vmnet`, `vEthernet`, `tailscale`, `wsl`, `br-` 가
   포함되면 제외 (대소문자 무시).
4. 후보가 여러 개면 전부 콘솔에 출력하고 첫 번째를 사용, `PHONEMOTE_HOST` 로 고정하라는 안내를 출력한다.

이 개발 머신에서의 실제 결과 (참고):

| 인터페이스 | IPv4 | 판정 |
|---|---|---|
| `Tailscale` | 100.100.28.127 | 제외 (이름 필터 + CGNAT 대역) |
| `이더넷 2` | 192.168.0.2 | **채택** |
| `vEthernet (WSL (Hyper-V firewall))` | 172.28.192.1 | 제외 (이름 필터) |

---

## 3. 폴더 구조

리포지토리 루트 = 프로젝트 폴더 그 자체다. 별도 `phonemote/`
하위 폴더를 만들지 않는다. → 13.1 결정 D1.

```
<repo root>/
├── ARCHITECTURE.md
├── README.md                      # Android 루트 CA 신뢰 절차 포함
├── .gitignore                     # certs/, .env, node_modules, dist
├── package.json                   # 워크스페이스 루트 + dev/typecheck/test/lint 스크립트
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── certs/                         # gitignore. mkcert 산출물
├── scripts/
│   └── setup-certs.sh             # mkcert 래퍼 (LAN IP를 SAN에)
├── packages/
│   └── protocol/                  # @phonemote/protocol
│       └── src/
│           ├── messages.ts        # JSON 제어 메시지 타입 + 타입 가드
│           ├── frame.ts           # SensorFrame 타입
│           ├── binary.ts          # encodeSensor / decodeSensor
│           ├── trace.ts          # .pmtrace 포맷 (녹화/재생)
│           ├── constants.ts       # 버튼 비트, 룸코드 문자셋, 포트, 색상, 필드 인덱스
│           └── index.ts
└── apps/
    ├── server/src/                # 릴레이 (게임 로직 0)
    │   ├── index.ts               # https 서버 + ws 업그레이드 + 메시지 라우팅 + 하트비트
    │   ├── room.ts                # Room / RoomRegistry / 재접속 유예
    │   ├── lanIp.ts
    │   ├── certHosts.ts           # 인증서 SAN 목록 출력 (setup-certs.sh용)
    │   ├── recorder.ts            # --record 트레이스 기록 + /traces 서빙
    │   ├── makeCorpus.ts          # 합성 트레이스 코퍼스 생성
    │   ├── throughput.ts          # 60Hz 파이프 측정 하네스 (개발 전용)
    │   └── https.ts               # 인증서 로드, 부재 시 친절한 에러
    ├── controller/src/            # 폰
    │   ├── main.ts                # 부트스트랩
    │   ├── sensors.ts             # capability check + raw 값 캐시 (변환 없음)
    │   ├── transport.ts           # WSS 송신, 재연결, pong
    │   ├── identity.ts            # localStorage clientId (재접속 복구)
    │   ├── ui.ts                  # 룸코드 폼, 버튼, 상태 표시, 진동
    │   ├── debug.ts               # raw 값 표시 (Phase 1)
    │   └── wakelock.ts
    └── game/src/                  # PC
        ├── main.ts                # Phaser 부트 + 씬 등록
        ├── session.ts             # 소켓 + 입력 파이프라인 ↔ Scene 경계
        ├── games.ts               # 게임 레지스트리 (씬이 아니라 배선)
        ├── dev/
        │   ├── FakeController.ts  # 키보드 → raw 프레임 (?fake=1)
        │   └── replay.ts          # 트레이스 재생 (?replay=이름)
        ├── net/
        │   ├── client.ts          # WSS, 메시지 → 이벤트
        │   └── latency.ts         # ping/pong RTT 통계
        ├── input/
        │   ├── types.ts           # CanonicalSensorFrame, GameAction
        │   ├── SensorNormalizer.ts
        │   ├── ComplementaryFilter.ts
        │   ├── pose.ts            # 중력 방향 자세 판정
        │   ├── InputMapper.ts
        │   ├── PointerMode.ts
        │   ├── SwingDetector.ts
        │   ├── TiltMode.ts
        │   └── __tests__/
        ├── scenes/
        │   ├── LobbyScene.ts
        │   ├── CalibrationScene.ts
        │   └── games/
        │       ├── PointerTest.ts
        │ FreezeFrame.ts
        │       ├── tennisState.ts  # 규칙 (Phaser 비의존, 단위 테스트 대상)
        │       └── Tennis.ts
        └── ui/
            ├── DebugOverlay.ts
            └── audio.ts            # Web Audio 합성 효과음
```

의존 방향: `protocol` ← `server`, `protocol` ← `controller`, `protocol` ← `game`.
`server` 는 `controller`/`game` 을 import 하지 않는다. `game/scenes` 는 `game/input` 의
**공개 타입(`GameAction`, `PlayerId`)만** import 한다.

---

## 4. 데이터 흐름

```
Android Chrome
  DeviceOrientationEvent { alpha, beta, gamma }
  DeviceMotionEvent { rotationRate{alpha,beta,gamma}, acceleration{x,y,z} }
  screen.orientation.type / 버튼 DOM
        │  (변환 없음 · 최신값 캐시)
        ▼
  rAF 루프, 최대 60Hz  →  SensorFrame (raw)
        │  encodeSensor() → 56 byte ArrayBuffer
        ▼
  WSS ──────────────► Relay Server ──────────────► WSS
        (해석 없이 같은 룸의 game 소켓으로 그대로 전달)
                                                    │ decodeSensor()
                                                    ▼
                                              SensorFrame (raw)
                                                    │
                                          SensorNormalizer.normalize()
                                          (screenOrientation 보정만)
                                                    ▼
                                          CanonicalSensorFrame
                                            orientation      { yaw, pitch, roll }   deg
                                            angularVelocity  { yaw, pitch, roll }   deg/s
                                            acceleration     { x, y, z }            m/s^2
                                            buttons, playerId, seq, dt
                                                    │
                                          InputMapper.update(frame)
                                    ┌───────────────┼───────────────┐
                                 PointerMode    SwingDetector    TiltMode
                                    └───────────────┼───────────────┘
                                                    ▼
                                             GameAction[]
                                                    ▼
                                            Phaser Scene  (여기서만 소비)
                                                    │ 게임 이벤트
                                                    ▼
                              game → server → controller → navigator.vibrate()
```

---

## 5. 좌표계 — 이 프로젝트의 핵심

**여기가 틀리면 나머지가 전부 틀린다.** 실기기 결과가 이 표와 다르면,
코드에 임시 부호 반전을 넣지 말고 **이 장을 먼저 고친 뒤** Normalizer와 테스트를 고친다.

### 5.1 기준 자세 (canonical pose) — **세로가 기본**

- 폰을 **세로(portrait)** 로 쥔다. 사람이 폰을 잡는 그 자세다.
- 화면은 플레이어를 향한다. 따라서 **겨냥 방향은 폰의 뒷면 쪽**(`−Z`)이고, TV를 향한다.
  "위쪽 끝으로 겨눈다"가 아니다 — 이 표현이 모호해서 측정 단계에서 실제로 오해가 났다.
- 이 자세는 `portrait-primary` (angle 0)이며, 이때 canonical 축 = 기기 축이다.

> **실기기 측정으로 바뀐 항목이다.** 초안은 가로를 기준으로 삼았는데, 실제로는 아무도
> 그렇게 잡지 않았다. 축 측정 세션(`pnpm --filter @phonemote/server run axis`)의 기록:
>
> | 단계 | raw beta / gamma | canonical up |
> |---|---|---|
> | 정면 유지 | 57 / **−13** | (−0.8, 0.1, 0.5) |
> | 오른쪽 90° | −2 / **+81** | (0.0, −1.0, 0.2) |
> | 왼쪽 90° | −7 / **−83** | (0.1, 1.0, 0.1) |
>
> 가로로 쥐었다면 정면 유지에서 `gamma ≈ −90` 이어야 하는데 −13이었고, 좌우 90°에서 gamma가
> ±82로 갈렸다. 즉 **세로로 쥔 상태에서 좌우 가로로 눕힌 것**이다. 같은 측정의 `up` 을 기기
> 좌표로 되돌리면 (0.1, 0.8, 0.5) — 세로로 들고 30° 뒤로 기운, 정확히 사람이 폰 드는 자세다.
>
> 각도 자체는 맞게 계산되고 있었고 **프레임만 90° 돌아가 있었다.** 그래서 "각도는 얼추 맞는데
> 축이 이상하다"로 느껴졌다.

### 5.2 Canonical 축 (오른손 좌표계)

| 축 | 방향 (세로로 쥔 기준 자세에서) |
|---|---|
| `+X` | 플레이어 기준 **오른쪽** (폰의 오른쪽 변) |
| `+Y` | **위** (폰의 위쪽 끝) |
| `+Z` | 화면 밖, **플레이어 쪽** |

`X × Y = Z` 인 오른손계. 겨냥 방향(폰이 가리키는 곳, TV 쪽)은 `−Z` 다.

### 5.3 각도 부호 규약 (aviation body convention)

canonical 각도는 항공기 관례를 쓴다. body 축은
**forward `f = −Z`, right `r = +X`, down `d = −Y`** (이 셋도 오른손계: `f × r = d`).

| 각/각속도 | 회전축 | 양(+)의 의미 | 물리적 확인 방법 |
|---|---|---|---|
| `pitch` | `r = +X` | 겨냥 방향이 **위로** | 폰 뒷면을 천장 쪽으로 들면 `pitch +` |
| `yaw` | `d = −Y` | 겨냥 방향이 **오른쪽으로** | 몸을 축으로 폰을 오른쪽으로 돌리면 `yaw +` |
| `roll` | `f = −Z` | 폰의 **오른쪽 변이 아래로** (플레이어 시점 시계방향) | 손목을 오른쪽으로 비틀면 `roll +` |

canonical XYZ 축 성분(`ω_x, ω_y, ω_z`)으로 쓰면:

```
pitch =  +ω_x
yaw   =  −ω_y
roll  =  −ω_z
```

이 규약 덕분에 `PointerMode` 의 `x += yawRate·dt·s`, `y −= pitchRate·dt·s`
(화면 y는 아래가 +) 공식이 직관과 일치한다.

### 5.4 Android(W3C) 기기 좌표계 — 입력 원본

W3C DeviceOrientation Event 스펙 기준. Chrome/Android는 **화면 회전에 따라 축을 돌려주지 않고**
기기 몸체(자연 방향 = portrait) 기준 값을 그대로 준다. 그래서 우리가 보정해야 한다.

| 기기 축 | portrait로 세워 들었을 때 방향 |
|---|---|
| `+x_d` | 화면 오른쪽 |
| `+y_d` | 화면 위쪽 |
| `+z_d` | 화면 밖(사용자 쪽) |

- `DeviceOrientationEvent`: `alpha` = z축 회전(0~360), `beta` = x축 회전(−180~180),
  `gamma` = y축 회전(−90~90). 회전 순서는 intrinsic **Z–X'–Y''**.
- `DeviceMotionEvent.rotationRate`: `alpha` = z축 각속도, `beta` = x축, `gamma` = y축
  (deg/s, 오른손 법칙).
- `DeviceMotionEvent.acceleration`: 기기 축 `x, y, z` 성분, 중력 제외, m/s².

벡터로 다룰 때:
`a_d = (ax, ay, az)`, `ω_d = (rotationRate.beta, rotationRate.gamma, rotationRate.alpha)`.

### 5.5 화면 회전 보정 (Normalizer의 전부)

화면 회전은 항상 기기 z축 회전이므로, canonical 변환은 **z축 회전 한 번**이다.

```
v_canonical = Rz(θ) · v_device ,   θ = 화면 회전각
Rz(θ) : (x, y, z) → (x·cosθ − y·sinθ,  x·sinθ + y·cosθ,  z)
```

`θ` 는 프레임 인덱스 13의 `screenOrientation` 열거값에서 얻는다.

> **실기기 이슈 — 화면 회전 잠금**: 회전 잠금이 켜져 있으면 폰을 물리적으로 어떻게 들든
> Chrome은 계속 `portrait-primary` 를 보고한다. 그래서 컨트롤러에 "잡는 방향"
> (세로 고정 / 가로 고정 / 자동) 선택을 두고 **기본값을 세로 고정**으로 한다.
> canonical 자세가 세로이므로(5.1) 세로 고정은 `θ = 0`, 즉 canonical 축 = 기기 축이다.
> OS가 갱신을 거부하는 값을 믿는 것보다 플레이어의 선언을 쓰는 쪽이 더 정확하다.
> 디버그 패널에는 "보냄"과 "폰보고" 값을 모두 표시해 어긋남을 눈으로 확인할 수 있게 한다.

| enum | `screen.orientation.type` | θ |
|---|---|---|
| 0 | `portrait-primary` | 0° |
| 1 | `landscape-primary` | 90° |
| 2 | `portrait-secondary` | 180° |
| 3 | `landscape-secondary` | 270° |

> **가정 A1**: 기기의 자연 방향이 portrait 이다(일반적인 Android 폰). 자연 방향이 landscape인
> 태블릿에서는 이 enum↔θ 표가 어긋난다. 대안은 `screen.orientation.angle / 90` 을 그대로
> 싣는 것이며, Phase 1 Manual 검증에서 어긋나면 그때 표(와 인코딩)를 바꾼다. → 13.3 Q3

### 5.6 매핑표 — **실기기 확정됨**

`Rz(θ)` 를 전개한 결과. **세로 기준(θ = 0)으로 실기기 측정 완료.**

측정 기록 (`pnpm --filter @phonemote/server run axis`, 세로 고정, `screen 0`, 정지 구간 평균):

| 동작 | 측정된 `up` | 예상 | |
|---|---|---|---|
| 정면 유지 | (0.1, **1.0**, 0.2) | (0, 1, 0) | ✅ |
| 오른쪽 90° 기울임 | (**−1.0**, 0.0, 0.3) | (−1, 0, 0) | ✅ `roll +92` |
| 왼쪽 90° 기울임 | (**1.0**, 0.0, 0.2) | (1, 0, 0) | ✅ `roll −92` |
| 화면을 하늘로 눕힘 | (0.1, 0.0, **1.0**) | (0, 0, 1) | ✅ |
| 오른쪽으로 회전 | yaw rate **+247** | + | ✅ |
| 왼쪽으로 회전 | yaw rate **−60** | − | ✅ |
| 앞으로 스윙 | accel z **−45** | 큰 음수 | ✅ |

모든 `|up|` 이 1.00 이었다(자세가 하나로 유지됐다는 뜻). 부호 규약(5.3)과 각속도 표가
실기기와 일치한다. **여기까지가 Phase 1의 Manual DoD였고, 이제 통과했다.**

> 처음 측정에서 `화면을 바닥으로` 와 `화면을 하늘로` 두 항목만 어긋났는데, 원인은 축이 아니라
> **문구였다.** 당시 문구가 "끝을 하늘로"여서 플레이어는 폰의 위쪽 끝을 위로 향하게 했고,
> 그건 세로 기준 자세 그 자체다. 측정값이 정면 유지와 동일하게 나온 것이 그 증거다.
> 자세 이름은 전부 **화면이 어디를 보는지**로 바꿨다. 축을 의심하기 전에 말을 의심할 것.

**가속도** `acceleration` (canonical X, Y, Z):

| screenOrientation | canonical X | canonical Y | canonical Z |
|---|---|---|---|
| 0 portrait-primary | `+ax` | `+ay` | `+az` |
| 1 landscape-primary | `−ay` | `+ax` | `+az` |
| 2 portrait-secondary | `−ax` | `−ay` | `+az` |
| 3 landscape-secondary | `+ay` | `−ax` | `+az` |

**각속도** `angularVelocity` (5.3의 부호 규약까지 적용한 최종값).
`α, β, γ` 는 `rotationRate.alpha/beta/gamma`:

| screenOrientation | `pitch` (= +ω_x) | `yaw` (= −ω_y) | `roll` (= −ω_z) |
|---|---|---|---|
| 0 portrait-primary | `+β` | `−γ` | `−α` |
| 1 landscape-primary | `−γ` | `−β` | `−α` |
| 2 portrait-secondary | `−β` | `+γ` | `−α` |
| 3 landscape-secondary | `+γ` | `+β` | `−α` |

`roll` 축은 화면 회전축과 같으므로 항상 `−α` 다 (좋은 자체 검산 포인트).

**기준 자세(portrait-primary, θ = 0) 손검산**: 이 자세에서 canonical 축 = 기기 축이므로
표의 첫 줄이 그대로 적용된다. 폰을 오른쪽으로 겨누는 동작은 세계 연직축 = canonical `+Y`
= 기기 `+y_d` 축 둘레의 회전이고, 겨냥이 오른쪽으로 가려면 그 축 둘레로 음의 회전
→ `γ < 0` → `yaw = −γ > 0`. 규약(오른쪽 겨눔 = `yaw +`)과 일치. ✔

### 5.7 자세각(orientation) 변환

`alpha/beta/gamma` 는 벡터가 아니라 오일러각이므로 축 치환으로 끝나지 않는다.
회전행렬을 만들어 canonical body 축을 세계 좌표로 옮긴 뒤 각을 다시 뽑는다.
세계 좌표계는 W3C 정의(`X`=동, `Y`=북, `Z`=천정).

```
R_dw = Rz(alpha) · Rx(beta) · Ry(gamma)          // device → world (W3C)
R_cw = R_dw · Rz(−θ)                             // canonical → world

f = R_cw · ( 0,  0, −1)      // forward (겨냥 방향)
r = R_cw · ( 1,  0,  0)      // right
d = R_cw · ( 0, −1,  0)      // down

pitch = asin( clamp(f.z, −1, 1) )
roll  = atan2( −r.z, −d.z )
yaw   = atan2(  f.x,  f.y )     // 북 기준. 절대값 아님 → 상대값으로만 사용
```

- `pitch`, `roll` 은 중력 기준이라 **절대적으로 신뢰 가능**하다.
- `yaw` 는 Chrome Android의 비-absolute `deviceorientation` 에서 기준점이 임의이고 드리프트가
  있다. **게임 로직은 yaw 절대값에 의존하지 않는다.** 좌우 겨눔은 `angularVelocity.yaw`
  적분(PointerMode) + 캘리브레이션 오프셋으로 처리한다. Phase 4에서 상보 필터를 도입한다.

### 5.8 중력 방향 (`up`) — 각도보다 먼저 보는 값

`pitch`/`roll`/`yaw` 는 사람이 읽기 좋지만 **특이점이 있다.**

- 폰을 평평하게 눕히거나 수직으로 세우면 겨냥 방향이 연직이 되어 `roll` 이 무의미해진다
  (`atan2(-r.z, -d.z)` 의 두 인자가 동시에 0으로 수렴한다).
- 그 근방에서는 물리적으로 아주 작은 움직임이 각도를 크게 튀게 만든다.

그래서 Normalizer는 **세계의 위 방향을 canonical 좌표로 표현한 단위벡터 `up`** 을 함께 낸다.

```
up.x =  r.z        // canonical +X 축의 세계 z 성분
up.y = -d.z
up.z = -f.z
```

`up` 은 특이점이 없다. 자세 판정(`poseMatch`)은 목표 `up` 과 측정된 `up` 사이의 **각도 하나**로
하며, 축별 허용오차나 각도 되감기(wrap) 처리가 필요 없다. 자세를 다루는 게임은 각도가 아니라
이 벡터를 쓴다.

| 자세 | `up` |
|---|---|
| 기준 자세(가로, 수평) | `(0, 1, 0)` |
| 오른쪽으로 90° 기울임 | `(-1, 0, 0)` 쪽 |
| 화면이 하늘을 보게 눕힘 | `(0, 0, 1)` 쪽 |
| 정면을 겨눔(수직으로 세움) | `(0, 0, -1)` 쪽 |

---

### 5.9 8방향 (`direction8`)

스윙 피크 시점의 canonical 가속도를 `X–Y` 평면에 투영해 결정한다.
`angle = atan2(a.y, a.x)` (deg), 45° 섹터:

| 섹터 중심 | 0° | 45° | 90° | 135° | 180° | −135° | −90° | −45° |
|---|---|---|---|---|---|---|---|---|
| `direction8` | `E` | `NE` | `N` | `NW` | `W` | `SW` | `S` | `SE` |

`N` = canonical `+Y`(위), `E` = canonical `+X`(오른쪽). 화면 좌표가 아니라 **항상 canonical 기준**.

---

## 6. 프로토콜 (`packages/protocol`)

### 6.1 제어 메시지 — JSON (텍스트 프레임)

```ts
// client → server
type ClientHello =
  | { type: 'hello'; role: 'game' }
  | {
      type: 'hello';
      role: 'controller';
      roomCode: string;
      name?: string;
      /** localStorage에 보관하는 폰 고유 id. 재접속 시 같은 슬롯 복구용 */
      clientId?: string;
    };

// server → client
type ServerMsg =
  | { type: 'room'; roomCode: string; wsUrl: string; controllerUrl: string }   // → game
  | { type: 'joined'; playerId: number; color: string; resumed?: boolean }     // → controller
  | { type: 'player_join'; playerId: number; name: string; color: string; resumed?: boolean }
  | { type: 'player_leave'; playerId: number }                                 // → game
  | { type: 'error'; code: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'GAME_LEFT'; message: string };

// 지연 측정: game → server → controller, controller는 즉시 그대로 pong
type Ping = { type: 'ping'; id: number; playerId: number };
type Pong = { type: 'pong'; id: number; playerId: number };

// 피드백: game → server → controller
type Feedback = { type: 'vibrate'; playerId: number; pattern: number[] };
```

- `controllerUrl` = `https://<LAN-IP>:5174/?room=XXXX`. **LobbyScene은 URL을 조립하지 않고
  서버가 준 값을 그대로 QR로 만든다.** 룸코드 직접 입력 경로도 같은 URL 형식으로 수렴한다.
- 플레이어 색상은 서버가 슬롯 순서대로 고정 배정: `#FF4757`, `#3742FA`, `#2ED573`, `#FFA502`.

### 6.2 센서 패킷 — 바이너리 (`Float32Array(17)`, 68 byte, little-endian)

| idx | 필드 | 단위 / 비고 |
|---|---|---|
| 0 | `playerId` | 1~4 |
| 1 | `seq` | 폰이 증가시킴. 유실 감지용 |
| 2 | `timestamp` | 폰 `performance.now()` ms. **프레임 간 dt 전용, 기기 간 비교 금지** |
| 3~5 | `orientation.alpha/beta/gamma` | deg, raw |
| 6~8 | `rotationRate.alpha/beta/gamma` | deg/s, raw |
| 9~11 | `acceleration.x/y/z` | m/s², 중력 제외, raw |
| 12 | `buttons` | 비트마스크 |
| 13 | `screenOrientation` | 0~3 (5.5 표) |
| 14 | `version` | 프레임 포맷 버전. 현재 2 |
| 15 | `motionSeq` | `devicemotion` 이벤트 카운터. **센서 정지 감지의 근거** |
| 16 | `flags` | 비트마스크. `LINEAR_ACCEL=1`(중력 제외 가속도 사용 가능), `ROTATION_RATE=2`, `ORIENTATION=4`, `HOLD_OVERRIDE=8` |

**v2에서 바뀐 것과 이유**

- `timestamp`(idx 2)는 이제 **송신 시각이 아니라 `DeviceMotionEvent.timeStamp`** 다. 폰은
  rAF가 아니라 `devicemotion` 이벤트에서 전송한다. 예전 방식은 센서가 멎어도 캐시값을 60Hz로
  재전송하면서 타임스탬프만 계속 전진시켰고, PC는 **죽은 각속도를 살아있는 dt로 적분**했다
  (500ms 스톨 = 화면폭 0.42의 유령 이동). 두 값 모두 `performance.now()` 원점이라 폰 안에서는
  비교 가능하고, 기기 간 비교 금지 규칙은 그대로다.
- `motionSeq`가 값-동일성 추측을 대체한다. 같은 값이 두 번 오는 것은 정상일 수 있지만
  같은 `motionSeq`가 두 번 오는 것은 정지다.
- `flags`는 기기가 무엇을 실제로 제공하는지 알린다. 중력 제외 가속도가 없는 기기에서
  스윙이 영영 감지되지 않는 상황을 **조용히 실패하는 대신 표시**하기 위한 것이다.

버튼 비트: `A=1, B=2, TRIGGER=4, MINUS=8, PLUS=16, HOME=32`.

`binary.ts` API: `encodeSensor(frame: SensorFrame): ArrayBuffer`,
`decodeSensor(buf: ArrayBuffer): SensorFrame`. 디코더는 **68 byte(v2)와 56 byte(v1)를 모두**
받는다. v1은 녹화된 트레이스를 계속 읽기 위한 것이며, 없는 필드는 기본값으로 채운다.
라운드트립 테스트 필수(Float32 정밀도 허용오차 사용).
센서값이 `null` 인 경우(초기 프레임 등)는 `0` 으로 인코딩한다.

> `seq`/`playerId`/`buttons` 를 Float32에 담는 것은 스펙 고정 사항이다. Float32는 정수를
> 2^24 까지 정확히 표현하므로 `seq` 는 약 46시간(60Hz) 동안 안전하다. 그 이상은 wrap 시킨다.

### 6.3 지연시간 측정

- 폰과 PC의 `performance.now()` 는 원점이 다르다.
  **one-way latency를 timestamp 차이로 계산하지 않는다.**
- `latency.ts`: 1초마다 `ping`, RTT의 median / p95 산출. **100 샘플 이상 모인 뒤에만 보고**한다.
- `seq` 갭 → 유실률. 수신 `timestamp` 간격 → 폰의 실제 전송 Hz.

---

## 7. 모듈 책임

### 7.1 Server (`apps/server`)

- `https.ts`: `certs/` 에서 key/cert 로드. 없으면 `scripts/setup-certs.sh` 안내와 함께 즉시 종료.
- `room.ts`
  - 룸코드: 문자셋 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (혼동 문자 I, O, 0, 1 제외) 4자리,
    `do { code = gen() } while (rooms.has(code))`.
  - 룸당 game 소켓 1개, controller 최대 4개. 초과 시 `ROOM_FULL` 후 close.
  - `playerId` 는 1~4 슬롯. 슬롯 인덱스가 색상 인덱스.
  - game 소켓이 끊기면 룸 삭제 + 남은 controller에 `GAME_LEFT` 전송 후 close.
  - controller가 끊기면 game에 `player_leave`.
- `index.ts` 라우팅 규칙
  - binary 프레임 → 같은 룸의 game 소켓으로 그대로 전달(파싱하지 않는다).
  - `ping` (game→) → 대상 playerId의 controller.
  - `pong`, 센서 프레임 (controller→) → game.
  - `vibrate` (game→) → 대상 controller.
- **재접속 복구 (Phase 4)**: controller가 끊기면 `clientId` 기준으로 슬롯을 `REJOIN_GRACE_MS`
  (10초) 동안 예약해 둔다. 같은 `clientId` 가 그 안에 돌아오면 같은 `playerId`·색상·이름으로
  복귀하고 `resumed: true` 가 실린다. `clientId` 가 없는 폰은 항상 새 플레이어다.
- **하트비트**: 15초마다 WebSocket ping. 다음 주기까지 응답이 없으면 `terminate()`.
  Wi-Fi가 끊긴 폰의 소켓은 여기서만 정리된다(close 이벤트가 오지 않는다).

### 7.2 Controller (`apps/controller`) — 폰

- `sensors.ts`: 부팅 시 `'DeviceMotionEvent' in window` / `'DeviceOrientationEvent' in window`
  capability check. 없으면 UI에 명확한 오류. **iOS 권한 분기(`requestPermission`) 없음.**
  이벤트 핸들러는 최신값을 캐시만 하고, 전송은 rAF 루프에서 최대 60Hz.
- `transport.ts`: WSS 연결, 1초 간격 재연결, 백프레셔 방지를 위해
  `ws.bufferedAmount` 가 임계값 이상이면 해당 프레임 드롭.
- `ui.ts`: 룸코드 입력 폼(`?room=` 있으면 자동 채움), 버튼(A/B/TRIGGER/±/HOME),
  연결 상태 표시, `if ('vibrate' in navigator) navigator.vibrate(pattern)`.
  진동이 없어도 게임은 정상 진행.
- `wakelock.ts`: `navigator.wakeLock.request('screen')`, `visibilitychange` 시 재획득 (Phase 2).
- 버튼 입력은 `pointerdown` / `pointerup` + `touch-action: none` + `user-select: none`.

### 7.3 Game 입력 레이어 (`apps/game/src/input`)

| 모듈 | 입력 | 출력 | 상태 |
|---|---|---|---|
| `SensorNormalizer` | `SensorFrame` | `CanonicalSensorFrame` | 없음(순수 함수) |
| `PointerMode` | canonical yawRate/pitchRate, `dt` | `{x, y}` 0~1 | 커서 위치 |
| `SwingDetector` | canonical acceleration, `t` | swing 이벤트 | 윈도우/쿨다운 |
| `TiltMode` | canonical pitch/roll | `{x, y}` −1~1 | 캘리브레이션 오프셋 |
| `ComplementaryFilter` | canonical 자세 + 각속도 | 융합 자세 | 이전 pitch/roll/yaw |
| `InputMapper` | `SensorFrame` | `GameAction[]` | 플레이어별 모드 + 이전 buttons |

```ts
type GameAction =
  | { kind: 'pointer_move'; playerId: number; x: number; y: number }
  | { kind: 'swing'; playerId: number; strength: number;
      direction: { x: number; y: number; z: number };
      direction8: 'N'|'NE'|'E'|'SE'|'S'|'SW'|'W'|'NW'; timestamp: number }
  | { kind: 'tilt'; playerId: number; x: number; y: number }
  | { kind: 'button_down'; playerId: number; button: ButtonName }
  | { kind: 'button_up'; playerId: number; button: ButtonName };
```

- **버튼 edge는 `InputMapper` 가 만든다** (이전 프레임 비트마스크와 XOR). 폰은 레벨만 보낸다.
- `PointerMode` 기본값: `sensitivity` = 화면폭의 1/60 per deg, 데드존 `|rate| < 2 deg/s`,
  `HOME` → 중앙(0.5, 0.5) 리셋, 0~1 클램프.
- `SwingDetector` — **각속도(|ω|)로 구간을 나눈다.** 가속도가 아니다.
  - 스윙은 어깨와 손목의 회전이고 `|a|` 는 그 증인으로 부적합하다. 500 deg/s · 팔 0.6m면
    구심 가속도가 **45 m/s², 진행 방향이 아니라 어깨 쪽**을 가리킨다. 게다가 팔은 가속보다
    감속이 세서 버스트 최대 `|a|` 가 종종 **정반대 방향의 종단 감속**이다. 그리고 `|a|` 는
    많은 폰에서 8g에 클리핑되지만 `|ω|` 는 2000 deg/s 헤드룸이 있다.
  - `|ω|` 는 **폰이 가장 빠른 순간**에 최대가 된다. 공을 맞히는 순간이 거기이므로, 그 감쇠에
    반응하면 이벤트가 접촉 직후 수십 ms에 나온다. 고정 윈도우를 기다릴 때의 ~190ms 지연이 사라진다.
  - 상수: `SWING_OMEGA_ON 300 deg/s`(의도적 느린 회전이 247까지 나왔다), `SWING_OMEGA_MAX 900`
    (실측 스윙 피크 914), `SWING_DECAY_RATIO 0.8`, `SWING_ARM_SAMPLES 2`(스파이크 1개는 스윙이 아니다),
    `SWING_MIN_WINDOW 20ms`, `SWING_CAPTURE_WINDOW 400ms`(가라앉지 않는 버스트의 보호장치),
    `SWING_COOLDOWN 80ms`.
  - **방향은 회전축이 아니라 폰의 먼 끝이 간 곳**이고, 그 수평 성분은 **yaw + roll** 이다.
    포인터처럼 쥐면 먼 끝이 겨냥축(−Z)이라 yaw가, 라켓처럼 쥐면 먼 끝이 위쪽 변(+Y)이라 roll이
    수평 스윕을 만든다. 실측 스윙은 **roll 피크 1157 / yaw 357, 순 회전 roll 85° / yaw 47°** 로
    roll이 우세했고, yaw만 보면 그 스윙이 "6도 이동, 방향 없음"으로 읽혔다. 둘을 더하면 두 그립을
    모두 포용하고 중간으로 쥔 손은 양쪽에서 몫을 받는다. pitch는 어느 그립이든 상하 성분이다. 겨냥 축(`−Z`) 위의 점은 `ω × r` 로 움직이고,
    이는 canonical X-Y에서 `(yaw, pitch)` 가 된다. 오른쪽으로 돌리면 끝이 오른쪽으로 쓸린다.
    버스트 전체를 적분해서 쓰므로 한 샘플의 운에 좌우되지 않는다.
  - `phase`: 최근의 더 약한 버스트를 **반대 방향으로 뒤집은** 버스트는 `'strike'` 다.
    백스윙은 일어나는 시점에는 라벨을 붙일 수 없고(약한 스윙과 구분되지 않는다) 정타가 도착할 때
    비로소 알 수 있다. 지연을 숨기려는 게임은 아무 버스트에서 애니메이션을 시작하고
    `'strike'` 에서 확정하면 된다.
- `TiltMode`: canonical `pitch`/`roll` → −1~1, 캘리브레이션 시점 오프셋, 데드존 5%, 지수 커브 옵션.
- 시간 기준: 스윙 윈도우/쿨다운은 **폰 timestamp(idx 2)** 로 잰다. 같은 기기 안에서는 단조 증가라
  안전하고, PC 수신 지터의 영향을 받지 않는다.
- `ComplementaryFilter` (Phase 4, 기본 켜짐): pitch/roll은 자이로 적분에 중력 기준값을 가중치
  0.02로 계속 끌어당긴다(스파이크 억제 + 드리프트 제거). yaw는 끌어당길 절대 기준이 없으므로
  순수 적분이며 상대값으로만 쓴다. dt가 0.25초를 넘으면 적분을 버리고 절대값에서 다시 시작한다.
  **DebugOverlay는 융합 전 canonical 값을 그대로 보여준다** — 축 검증이 필터에 오염되면 안 된다.
- `session.ts` 가 소켓·정규화·매핑을 모두 소유하고 Scene에는 `GameAction` 만 넘긴다.
  P4를 코드 구조로 강제하는 지점이다.

### 7.4 Game Scene (`apps/game/src/scenes`)

- `LobbyScene`: 룸코드 표시, QR(Phase 2), 플레이어 슬롯 4개.
- `CalibrationScene`(Phase 2): "폰을 화면 중앙으로 향하고 A" → 오프셋 저장.
- `games/PointerTest`(Phase 1): 기울기로 원 이동, A로 색 변경.
- `games/Tennis`(Phase 3): 상태 머신 `serve → rally → point → gameover`.
- `ui/DebugOverlay`: 선택 플레이어의 raw ↔ canonical 값 나란히 표시, RTT median/p95, Hz, 유실률.

---

## 8. 테스트 전략

| 대상 | 방식 | Phase |
|---|---|---|
| `binary.ts` 라운드트립 | Vitest, 무작위 값 + 경계값 | 1 |
| `SensorNormalizer` 축 부호 | Vitest, 4개 orientation × 6개 축 케이스 (5.6 표가 기대값의 근거) | 1 |
| 룸 생성 / 코드 충돌 / `ROOM_FULL` / `GAME_LEFT` | Vitest + 인메모리 소켓 더블 | 1 |
| 전송 Hz | Node 가짜 controller가 60Hz 송신 → game 수신 ≥ 55Hz | 1 |
| `PointerMode` | 고정 각속도 1초 이동량, 데드존, HOME 리셋, 클램프 | 2 |
| `SwingDetector` | 1스윙=1이벤트, 쿨다운 무시, 임계 미만 무반응, strength 경계(15→0, 40→1, 50→1) | 2 |
| Tennis 상태 머신 | Vitest (serve→rally→point→gameover, 벽치기 포함) | 3 |
| P4 (Scene의 `SensorFrame` import 금지) | ESLint `@typescript-eslint/no-restricted-imports` | 3 |
| **골든 트레이스** | `traces/corpus/*.pmtrace` 를 실제 파이프라인에 재생 | 확장 1단계 |
| 센서 정지 | 가속도가 임계값 위에 얼어붙은 트레이스 → 스윙 0, 포인터 정지 | 확장 1~2단계 |
| 중력 자세 (`up`) | 4개 자세의 벡터 부호 + roll 특이점 근방 안정성 | 확장 3단계 |
| 게임 레지스트리 | 레지스트리 key == 씬 key (Phaser 모킹) | 확장 3단계 |
| **실기기 트레이스** | 측정 세션을 `.pmtrace` 로 승격(`trace-from-log`) → 실제 스윙 1회 감지, 정지 0회 | 확장 4단계 |
| QR 라운드트립 | `qrcode` 로 렌더 → `jsqr` 로 디코딩 == `controllerUrl` | 2 |
| 재접속 유예 | 주입한 시계로 10초 경계 검증 | 4 |
| 상보 필터 | 스파이크 억제 / 수렴 / yaw 적분 / 스톨 후 리셋 | 4 |

**트레이스가 이 표의 절반을 실기기 없이 재현 가능하게 만든다.** 릴레이의 `--record` 로 실제
세션을 기록하고 골든 테스트에 넣으면, 임계값 변경이 무엇을 얻고 무엇을 잃었는지 숫자로 나온다.
합성 코퍼스는 그중 **음성 사례**(가만히 둔 폰, 걷는 폰, 죽은 센서)를 담당한다.

**여전히 실기기·사람의 체감·물리 센서가 필요한 항목은 자동 검증 대상이 아니다.** 각 Phase 보고에서
`Automated` / `Manual` 로 나누고, Manual 항목은 확인 절차를 함께 적는다.

---

## 9. 개발 환경

### 9.1 인증서

`scripts/setup-certs.sh` 가 mkcert로 `localhost`, `127.0.0.1`, `<LAN-IP>` 를 SAN에 넣은
인증서를 `certs/` 에 생성한다. `certs/` 는 커밋하지 않는다.

Android에서 경고 없이 열려면 **폰에 mkcert 루트 CA를 설치**해야 한다. 클릭해서 경고를
통과하면 페이지 자체는 열리고 `isSecureContext` 도 `true` 지만, **WSS 핸드셰이크에는
우회 화면이 없어서** 센서 스트림이 그냥 실패한다. 즉 CA 설치는 선택이 아니다.

파일 전달을 쉽게 하려고 `setup-certs.sh` 가 루트 CA **공개 인증서만**
`apps/controller/public/rootCA.crt` 로 복사하고, 컨트롤러 Vite 서버가 이를
`application/x-x509-ca-cert` + `Content-Disposition: attachment` 로 내려준다.
폰에서 `https://<LAN-IP>:5174/rootCA.crt` 를 열면 다운로드된다.
개인키(`rootCA-key.pem`)는 절대 복사하지 않는다. 이 복사본도 gitignore 대상이다.

설치는 반드시 **설정 → 보안 → 암호화 및 사용자 인증 정보 → 인증서 설치 → CA 인증서**
경로로 한다(파일을 탭해서 여는 방식은 대개 실패한다). 상세 절차는 README 3장.

### 9.2 실행

```
pnpm install
pnpm setup:certs      # 최초 1회
pnpm dev              # server + controller + game 동시 실행
pnpm typecheck / pnpm test / pnpm lint
```

TypeScript는 **strict + `noUncheckedIndexedAccess`**, `any` 금지(ESLint 에러).

---

## 10. Git 규칙 (요약)

- Conventional Commits. 의미 있는 작업 단위마다 커밋(Phase 끝에 몰아서 하지 않는다).
- 커밋 전 그 시점에 존재하는 `typecheck` / `test` / `lint` 실행.
  실패 상태를 정상 커밋으로 남기지 않는다.
- `certs/`, `.env`, `node_modules`, `dist` 커밋 금지.
- `git reset --hard` / force push / rebase 등 history 변경은 사용자 승인 없이 하지 않는다.
- push 시점: ARCHITECTURE 승인 직후, 스캐폴딩 후, 핵심 기능 단위 후, 각 Phase 종료 후,
  큰 리팩터링 직전/직후.

---

## 11. Phase 로드맵

| Phase | 목표 | 산출물 | 상태 |
|---|---|---|---|
| 0 | 뼈대와 문서 | ARCHITECTURE, 모노레포, HTTPS, README | ✅ |
| 1 | 파이프라인 검증 + **좌표계 확정** | protocol, 릴레이, raw 전송, Normalizer, TiltMode, PointerTest, DebugOverlay | ✅ (5.6 실기기 확정) |
| 2 | 입력 레이어 완성 + 페어링 UX | PointerMode, SwingDetector, QR, 캘리브레이션, 리모컨 UI, 진동 | ✅ |
| 3 | 첫 게임: 테니스 | Tennis, P4 lint 강제 | ✅ |
| 4 | 정밀도와 안정성 | 상보 필터, 재접속 identity 복구, 하트비트 | ✅ |
| 5 | (선택) 확장 | WebRTC DataChannel, 두 번째 게임, 포인터 메뉴 | 미착수 |

Phase 1의 Manual 검증에서 5.6 매핑표가 틀린 것으로 드러나면,
`docs: confirm android sensor axis mapping` 커밋으로 이 문서를 먼저 고친 뒤 코드를 고친다.

---

## 12. 알려진 Web API 제약

| 항목 | 내용 | 대응 |
|---|---|---|
| Secure context | 센서 이벤트는 HTTPS에서만 발화 | 전 구간 HTTPS/WSS + mkcert |
| 이벤트 주기 | Chrome Android의 devicemotion은 약 60Hz 상한 | 설계 목표 자체가 60Hz |
| `alpha` 기준점 | 비-absolute `deviceorientation` 의 alpha는 기준 임의 + 드리프트 | yaw 절대값 미사용, 각속도 적분 + 캘리브레이션 |
| 시계 | 폰/PC `performance.now()` 원점 상이 | one-way latency 계산 금지, RTT만 사용 |
| `navigator.vibrate` | 기기·설정에 따라 무시될 수 있음 | 있으면 호출, 없어도 게임 진행 |
| Wake Lock | 백그라운드 진입 시 해제됨 | `visibilitychange` 에서 재획득 |
| 화면 회전 | Chrome은 센서 축을 화면 회전에 맞춰 돌려주지 않음 | 5.5 보정이 Normalizer의 존재 이유 |

---

## 13. 결정 · 가정 · 미해결 질문

### 13.1 스스로 결정한 것

| # | 결정 | 이유 |
|---|---|---|
| D1 | 리포 루트 = 현재 폴더(`wii project`). `phonemote/` 하위 폴더를 만들지 않음 | 폴더가 비어 있고 이미 프로젝트 전용. 경로에 공백이 있으므로 스크립트에서 경로를 항상 따옴표로 감싼다 |
| D2 | 브랜치 이름 `main` | 신규 저장소 |
| D3 | 각도 부호를 aviation 관례로 명문화 (5.3) | 스펙의 Manual DoD(오른쪽 기울임 = roll+, 위 겨눔 = pitch+)와 PointerMode 공식이 동시에 성립하는 유일한 일관 규약 |
| D4 | 스윙 타이밍 기준을 폰 timestamp로 | 같은 기기 내 단조 증가. 네트워크 지터 영향 배제 |
| D5 | 각 패키지는 `@phonemote/*` 스코프 패키지명 | 워크스페이스 참조 명확화 |
| D6 | `noUncheckedIndexedAccess` 추가 | 바이너리 배열 인덱싱이 많음 |
| D7 | `binary.ts` 는 `Float32Array` + `DataView(little-endian)` 로 명시 인코딩 | `Float32Array` 의 바이트 순서는 플랫폼 의존이므로 엔디안을 고정 |
| D8 | TypeScript 5.9 고정 (최신은 7.0) | typescript-eslint가 TS 7.0에서 로드를 거부한다. `any` 금지를 lint로 강제하는 쪽이 최신 컴파일러보다 가치 있다 |
| D9 | `vite.config.ts` 는 protocol을 상대 경로 + `.ts` 확장자로 import | Vite 설정은 TS 변환 전에 Node가 읽으므로 워크스페이스 `.ts` 엔트리를 해석하지 못한다. 포트 상수를 복제하는 대신 esbuild가 인라인하게 한다 |
| D10 | `session.ts` 를 Scene의 유일한 창구로 | P4를 문서가 아니라 코드 구조와 lint로 강제하기 위해 |
| D11 | 상보 필터 기본 켜짐, 단 DebugOverlay는 융합 전 값 표시 | 체감은 필터가 좋지만, 축 검증은 필터에 오염되면 안 된다 |
| D12 | `throughput.ts` 를 서버 워크스페이스에 둠 | `ws` 의존성이 그 워크스페이스에만 있어 `scripts/` 에서는 해석되지 않는다 |
| D13 | 스윙 판정은 헛스윙에 벌점을 주지 않음 | 타이밍 학습 중 불필요한 좌절을 만들지 않기 위해. 놓치면 실점이라는 결과로 충분하다 |
| D14 | 스윙 임계/상한을 15·40 → 25·90 으로 재조정 | 실기기 스윙 피크가 100 m/s² 부근. 스펙 값으로는 강도 구분이 아예 되지 않았다 |
| D15 | 스윙을 피크 감쇠 시점에 즉시 발화 | 고정 100ms 대기는 모든 타격에 100ms 지연을 더한다. 타이밍 게임에서 치명적 |
| D16 | 테니스 속도 0.55~1.5 → 0.32~0.8, 히트존 0.18 → 0.26 | 플레이 결과 타이밍 창이 사람이 반응할 수 있는 폭이 아니었다 |
| D17 | 컨트롤러에 "잡는 방향" 선택 추가, **기본 세로 고정** | 회전 잠금 시 `screen.orientation` 이 거짓말을 한다. 기준 자세는 5.1에서 실측으로 세로로 확정 |
| D18 | 전송을 rAF → `devicemotion` 이벤트 구동으로, 프레임 포맷 v2 | 캐시 재전송이 죽은 센서를 살아있는 dt로 적분하게 만들었다. 스트림 통계로는 절대 보이지 않는 종류의 버그다 |
| D19 | `motionSeq` 로 센서 정지를 판정 (값 비교 휴리스틱 폐기) | 같은 값이 두 번 오는 것은 정상일 수 있지만, 같은 이벤트 카운터가 두 번 오는 것은 정지다 |
| D20 | 버튼 유지용 10Hz keep-alive | 전송이 센서 구동이 되면서 센서가 멎으면 버튼까지 죽는 부작용이 생겼다 |
| D21 | 중력 방향 `up` 을 canonical 1급 출력으로, 자세는 `pose` GameAction | 각도는 평평/수직에서 특이점이 있다. Scene이 프레임을 직접 보게 하는 대신 액션으로 올려 P4를 지켰다 |
| D22 | 게임 레지스트리를 `scenes/` 밖에 배치 | 레지스트리는 씬이 아니라 배선이다. `scenes/` 안에 두면 P4 lint에 정당하게 걸린다 |
| D23 | 트레이스 녹화를 릴레이에 배치 | 이미 모든 프레임을 보고, 해석하지 않고도 기록할 수 있으며, 폰 수정이 0이다 |
| D24 | 스윙 구간 분할을 `|a|` → `|ω|` 로 | 구심 가속도가 진행 방향이 아니라 어깨를 가리키고, 감속 스파이크가 반대 방향을 준다. `|ω|` 는 클리핑도 없고 최대 시점이 접촉 순간이다 |
| D25 | 방향을 버스트 전체 적분의 tip 이동으로 | 한 샘플의 가속도 벡터보다 훨씬 안정적이고, 플레이어가 보는 것과 일치한다 |
| D26 | 측정 도구는 시간이 아니라 **조건**으로 진행 | 첫 실측에서 스윙과 뒤집기 두 단계가 창을 벗어났다. 이제 정지하면 자세를 찍고, 움직이면 동작을 찍는다 |

### 13.2 가정

- **A1**: 폰의 자연 방향은 portrait (5.5).
- **A2**: PC와 폰이 같은 LAN에 있고, AP가 클라이언트 격리(AP isolation)를 하지 않는다.
- **A3**: Windows 방화벽에서 Node/Vite의 5173 / 5174 / 8443 인바운드가 허용된다.

### 13.3 미해결 질문 (Phase 0 구현 전 답이 필요)

- ~~**Q1 (mkcert)**~~ → 해결. `winget install FiloSottile.mkcert` 로 1.4.4 설치, `mkcert -install` 완료.
- **Q2 (GitHub 원격)**: 원격이 아직 없고 이 PC에 `gh` CLI도 없다. GitHub에서 빈 저장소를 만들어
  URL을 주면 `git remote add origin` 후 push한다. 그전까지는 로컬 커밋만 쌓는다.
- **Q3 (screenOrientation 인코딩)**: idx 13을 스펙대로 `type` 열거값으로 둘지,
  `angle / 90` 으로 둘지. 일반 Android 폰에서는 두 값이 동일하다. 기본은 스펙대로 `type`.
- ~~**Q4 (pnpm)**~~ → 해결. `corepack enable` 은 `C:\Program Files
odejs` 쓰기 권한(EPERM)으로
  실패해서 `npm install -g pnpm` 으로 설치했다 (11.24.0).
- **R2 (TypeScript 버전)**: typescript-eslint 8.68이 TS 7.0에서 로드를 거부한다
  (`Error: typescript-eslint does not support TS 7.0`). lint를 살리려고 TypeScript를 5.9로
  고정했다. typescript-eslint가 TS 7을 지원하면 올린다.
