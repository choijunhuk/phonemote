# PhoneMote

Android 스마트폰을 Wii 리모컨처럼 쓰는 웹 모션 게임 플랫폼.
폰이 센서 + 버튼, PC가 게임기다.

설계는 [ARCHITECTURE.md](ARCHITECTURE.md)에 있다. **코드보다 그 문서가 먼저다.**

| 역할 | 환경 | 주소 |
|---|---|---|
| Controller | Android 최신 Chrome **전용** | `https://<LAN-IP>:5174` |
| Game | PC 브라우저 (Chromium 권장) | `https://<LAN-IP>:5173` |
| Relay | Node.js 20+ | `wss://<LAN-IP>:8443` |

전 구간이 HTTPS/WSS다. `DeviceMotionEvent` / `DeviceOrientationEvent` 는
secure context에서만 발화하고, HTTPS 페이지에서 `ws://` 는 mixed content로 차단되기 때문이다.

---

## 1. 준비물

- Node.js 20 이상
- pnpm — `npm install -g pnpm`
- [mkcert](https://github.com/FiloSottile/mkcert) — `winget install FiloSottile.mkcert`
  (설치 후 새 셸을 열어야 PATH가 적용된다)
- PC와 폰이 **같은 Wi-Fi/LAN**에 있을 것

## 2. 설치와 실행

```bash
pnpm install
pnpm setup:certs      # 최초 1회, LAN IP가 바뀌면 다시
pnpm dev              # relay + controller + game 동시 실행
```

`pnpm dev` 가 출력하는 주소 중 `192.168.x.x` 형태를 쓴다.

| 명령 | 하는 일 |
|---|---|
| `pnpm dev` | 세 프로세스 동시 실행 |
| `pnpm typecheck` | 전 워크스페이스 타입 검사 |
| `pnpm test` | Vitest |
| `pnpm lint` | ESLint |
| `pnpm setup:certs` | mkcert로 개발 인증서 재생성 |

### LAN IP가 잘못 잡힐 때

서버는 사설 대역 IPv4 중 가상 인터페이스(docker, WSL, Tailscale 등)를 제외하고 첫 번째를
쓴다. 후보가 여러 개면 콘솔에 전부 출력한다. 원하는 주소를 고정하려면:

```bash
PHONEMOTE_HOST=192.168.0.2 pnpm dev
```

주소를 바꿨다면 `pnpm setup:certs` 를 다시 돌려 인증서 SAN을 갱신한다.

---

## 3. Android 폰에 루트 CA 설치하기 (필수)

`pnpm setup:certs` 가 만드는 인증서는 mkcert의 **로컬 CA**가 서명한다. PC에는 자동으로
신뢰 등록되지만 폰은 그 CA를 모르므로, 설치하지 않으면 Chrome이 경고를 띄우고
**secure context가 아니게 되어 센서 API가 아예 동작하지 않는다.**

### 3.1 루트 CA 파일 위치 확인

```bash
mkcert -CAROOT
```

출력된 폴더 안의 **`rootCA.pem`** 이 폰에 넣을 파일이다.
(`rootCA-key.pem` 은 개인키다. 절대 폰이나 외부로 보내지 말 것.)

### 3.2 폰으로 파일 받기

**가장 쉬운 방법** — `pnpm dev` 가 돌고 있으면 컨트롤러 서버가 루트 CA를 직접 내려준다.
폰 Chrome에서 접속:

```
https://<LAN-IP>:5174/rootCA.crt
```

이때는 인증서 경고가 떠도 **무시하고 계속**을 눌러 들어가면 된다. 파일이 `다운로드` 폴더에
저장된다. (컨트롤러 페이지 아래쪽의 "루트 CA 내려받기" 링크도 같은 파일이다.)

> 내려주는 건 **공개 인증서**뿐이다. 개인키(`rootCA-key.pem`)는 PC 밖으로 나가지 않는다.

USB나 메신저로 옮기고 싶다면 `mkcert -CAROOT` 폴더의 `rootCA.pem` 을 복사하면 된다.

### 3.3 인증서 설치

다운로드한 파일을 **탭해서 여는 방식은 대개 실패한다.** 반드시 설정에서 설치한다.

**설정 → 보안 및 개인정보 보호 → 추가 보안 설정 → 암호화 및 사용자 인증 정보 →
인증서 설치 → CA 인증서 → (경고 화면에서) 무시하고 설치 → 다운로드 폴더의 `rootCA.crt` 선택**

- 경로는 제조사/안드로이드 버전마다 다르다. 못 찾겠으면 설정 검색창에 **"인증서 설치"** 또는
  **"CA 인증서"** 를 입력한다.
- 삼성 One UI: 설정 → 보안 및 개인정보 보호 → 기타 보안 설정 → 인증서 설치 → CA 인증서
- 설치 후 **설정 → 보안 → 신뢰할 수 있는 자격 증명 → 사용자** 탭에 `mkcert ...` 항목이
  보이면 성공이다.
- 설치 뒤 Chrome에서 해당 탭을 **완전히 닫았다가 다시 열어야** 경고가 사라진다.

### 3.4 확인

폰 Chrome에서 `https://<LAN-IP>:5174` 접속. 판정 기준은 주소창이 아니라 페이지의
**`relay TLS`** 항목이다.

| 표시 | 의미 |
|---|---|
| `relay TLS: ok — 인증서 신뢰됨` | **통과.** 릴레이로 보낸 fetch가 성공했다는 뜻이고, WSS도 연결된다 |
| `relay TLS: 실패` | 인증서가 아직 신뢰되지 않는다. 3.3을 다시 확인 |

주소창에 "연결이 안전하지 않음" 라벨이 남아 있어도, 전체 화면 경고 없이 페이지가 열리고
`relay TLS` 가 ok면 정상이다. Android는 **사용자가 추가한 CA**로 검증된 사이트에 그 라벨을
계속 붙인다. 인증서 검증 자체는 통과한 상태다.

페이지 경고는 "무시하고 계속"으로 넘길 수 있지만 **fetch와 WebSocket은 우회 수단이 없다.**
그래서 이 항목 하나가 센서 스트리밍 가능 여부를 그대로 말해준다.

열리지 않는다면 순서대로 확인한다.

1. PC와 폰이 같은 Wi-Fi인가 (게스트 망 / AP isolation 주의)
2. Windows 방화벽에서 Node.js의 인바운드가 허용되었는가 (최초 실행 시 팝업)
3. 인증서를 다시 만든 뒤(`pnpm setup:certs`) 서버를 재시작했는가
4. `PHONEMOTE_HOST` 로 고정한 IP와 실제 접속 IP가 같은가

---

## 4. 저장소 구조

```
packages/protocol   공유 타입 · 상수 · 바이너리 코덱
apps/server         WSS 릴레이 (게임 로직 없음, 룸 라우팅만)
apps/controller     폰에서 열리는 컨트롤러 (raw 센서 송신)
apps/game           PC에서 열리는 게임 (Phaser, 모든 해석 담당)
scripts/            개발 환경 스크립트
certs/              로컬 인증서 (커밋하지 않음)
```

## 5. 노는 법

1. PC에서 `pnpm dev` → 브라우저로 `https://<LAN-IP>:5173` 를 연다. 로비에 룸 코드와 QR이 뜬다.
2. 폰 Chrome으로 QR을 찍거나 `https://<LAN-IP>:5174` 에서 룸 코드를 입력하고 **컨트롤러 시작**.
3. 폰을 **세로로** 잡는다. 화면은 나를 향하고, 폰의 **위쪽 끝이 화면(TV)을 겨눈다.**
   가로로 잡고 싶으면 컨트롤러의 "잡는 방향"에서 바꾼다.
4. 로비 메뉴에서 폰을 겨눠 게임을 고르고 **A**. PC 키보드 `↑↓` + `Enter` 로도 고를 수 있다.
5. 캘리브레이션이 필요한 게임은 정면을 겨눈 자세로 **A**. 그 자세가 중립이 된다.

| 버튼 | 하는 일 |
|---|---|
| A | 확인 / 서브 · 스윙은 폰을 휘두르기 |
| HOME | 포인터 중앙 정렬, 게임 중에는 로비로 |
| PC 키보드 `d` | 디버그 오버레이 토글 |
| PC 키보드 `1`~`4` | 오버레이에 표시할 플레이어 선택 |
| PC 키보드 `ESC` | 로비로 |
| PC 키보드 `↑↓` `Enter` `1~3` | 폰 없이 메뉴 조작 |
| PC 키보드 `r` (로비에서) | 축 측정 기록 — 아홉 가지 동작을 시키고 결과를 저장 |

### 지금 있는 게임

| 게임 | 입력 | 인원 |
|---|---|---|
| **Freeze Frame** | 화면이 부르는 자세로 폰을 들고 버티기 | 1~4명 |
| **Tennis** | 공이 라켓 근처에 왔을 때 폰을 휘두르기 | 1~2명 |
| **Pointer Test** | 기울기·자이로 포인터 확인용 도구 | 1~4명 |

디버그 오버레이는 선택한 플레이어의 **raw(폰이 보낸 값)** 와 **canonical(PC가 해석한 값)** 을
나란히 보여준다. 축 부호가 의심되면 여기를 본다.

## 6. 폰 없이 개발하기

폰을 들고 왔다 갔다 하지 않고도 대부분의 작업이 된다.

```bash
pnpm dev
```

| 주소 | 하는 일 |
|---|---|
| `https://<LAN-IP>:5173/?fake=1` | 키보드가 폰 역할. `←→↑↓` 조준, `Space` 스윙, `z/x/c` = A/B/트리거, `h` = HOME |
| `https://<LAN-IP>:5173/?fake=2` | 두 명. 둘째는 `wasd` / `q` / `e r f` / `g` |
| `https://<LAN-IP>:5173/?replay=corpus/swing-forward.pmtrace` | 녹화된 센서 스트림을 그대로 재생 |

키보드 컨트롤러도 리플레이도 **실제 파이프라인에 raw 프레임을 밀어넣는다.** GameAction을
흉내내는 게 아니라 코덱 → 정규화 → 융합 → 매핑을 전부 통과하므로, 여기서 보이는 건 진짜다.

### 축이 이상할 때 — 측정해서 기록하기

감으로 고치면 안 되는 영역이다. 로비에서 `r` 을 누르면 아홉 가지 동작(좌우로 기울이기,
끝을 위아래로, 좌우 회전, 스윙, 눕히기)을 하나씩 시키고 그동안의 **raw 값과 canonical 값을
전부** 기록해 릴레이에 보낸다.

```bash
pnpm --filter @phonemote/server run axis
```

기록을 다시 읽어 동작별로 중력 벡터, 각도, 각속도·가속도 피크를 예상값과 나란히 출력한다.
결과가 `ARCHITECTURE.md` 5.6 표와 다르면 **표를 먼저 고치고** Normalizer, 테스트 순으로 맞춘다.
기록은 `logs/sessions.jsonl` 에 계속 쌓인다.

이 방식으로 기준 자세가 가로에서 **세로**로 바뀌었다 (5.1 참조).

### 센서 트레이스

스윙은 두 번 똑같이 할 수 없어서, 임계값을 바꿔도 좋아졌는지 **기억으로** 판단하게 된다.
트레이스는 같은 동작을 매번 똑같이 재생한다.

```bash
pnpm --filter @phonemote/server run record
```

릴레이가 지나가는 모든 프레임을 `traces/<룸>-p<번호>.pmtrace` 에 기록한다 (해석은 여전히 안 한다).
녹화한 파일은 `?replay=` 로 재생하거나 골든 테스트에 넣는다.

```bash
pnpm --filter @phonemote/server run corpus
```

합성 코퍼스를 다시 만든다. `traces/corpus/` 는 커밋되며 `pnpm test` 가 이걸 돌린다 —
가만히 둔 폰과 걸어다니는 폰은 스윙 0회여야 하고, **센서가 죽은 채 가속도가 임계값 위에 얼어붙은**
트레이스도 스윙 0회에 포인터가 움직이지 않아야 한다.

## 7. 현재 상태

**Phase 0~4 + 확장 1~3단계 구현 완료.** 프로토콜 v2(이벤트 구동 전송, 센서 정지 감지),
트레이스 녹화·재생·골든 테스트, 중력 기반 자세 판정, 게임 레지스트리와 로비 메뉴, Freeze Frame.

계획과 근거는 [docs/ROADMAP.md](docs/ROADMAP.md)에 있다.

남은 것은 **실기기 확인**이다. 특히 (1) 오버레이의 canonical 부호가 `ARCHITECTURE.md` 5.6 표와
맞는지, (2) 폰을 60초 가만히 두었을 때 포인터가 얼마나 흐르는지 — 이 숫자가 다음 작업의
우선순위를 정한다. 다르면 코드가 아니라 문서를 먼저 고친다.
