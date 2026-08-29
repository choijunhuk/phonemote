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

폰 Chrome에서 `https://<LAN-IP>:5174` 접속.

- 주소창에 **경고 없이** 페이지가 열리고
- 페이지의 `secure context` 항목이 **true** 면 성공이다.

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

## 5. 현재 상태

**Phase 0 완료** — 뼈대, HTTPS, 문서.
컨트롤러/게임 페이지는 아직 연결 확인용 자리표시자다. 센서 파이프라인은 Phase 1에서 붙는다.
