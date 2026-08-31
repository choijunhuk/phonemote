import { BUTTON, type ButtonName } from '@phonemote/protocol';
import type { HoldMode } from './sensors.js';
import type { ConnectionState } from './transport.js';

/**
 * Controller UI (ARCHITECTURE.md 7.2).
 *
 * Laid out for the canonical pose: the phone held in landscape with the screen
 * facing the player, so A sits under the right thumb and the small buttons
 * under the left.
 */

export interface JoinRequest {
  readonly roomCode: string;
  readonly name: string;
}

const HOLD_LABELS: ReadonlyArray<{ mode: HoldMode; label: string }> = [
  { mode: 'portrait', label: '세로로 들기' },
  { mode: 'landscape', label: '가로로 들기' },
  { mode: 'auto', label: '자동' },
];

const BUTTON_LAYOUT: ReadonlyArray<{
  name: ButtonName;
  label: string;
  className: string;
}> = [
  { name: 'MINUS', label: '−', className: 'small' },
  { name: 'HOME', label: 'HOME', className: 'small home' },
  { name: 'PLUS', label: '+', className: 'small' },
  { name: 'TRIGGER', label: 'B\ntrigger', className: 'trigger' },
  { name: 'A', label: 'A', className: 'primary' },
  { name: 'B', label: 'B', className: 'secondary' },
];

const STATE_TEXT: Record<ConnectionState, string> = {
  idle: '대기 중',
  connecting: '연결 중…',
  joined: '연결됨',
  reconnecting: '재연결 중…',
  failed: '연결 실패',
};

export class ControllerUi {
  private readonly root: HTMLElement;
  private readonly statusEl = document.createElement('div');
  private readonly joinSection = document.createElement('form');
  private readonly padSection = document.createElement('section');
  private readonly debugSection = document.createElement('pre');
  private readonly roomInput = document.createElement('input');
  private readonly nameInput = document.createElement('input');
  private readonly holdControl = document.createElement('div');

  private buttons = 0;
  /**
   * Buttons pressed and released between two frames would vanish entirely if
   * only the level were sampled, and a dropped frame widens that window from
   * one sensor tick to however long the drop lasted.
   */
  private latched = 0;
  private joinHandler: ((request: JoinRequest) => void) | null = null;
  private prefilledRoom = '';
  private holdMode: HoldMode = 'portrait';
  private onHoldChange: ((mode: HoldMode) => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.replaceChildren();
    this.statusEl.className = 'status';
    this.debugSection.className = 'debug';
    this.padSection.className = 'pad hidden';
    this.joinSection.className = 'join';
    this.holdControl.className = 'hold-holder hidden';
    this.root.append(
      this.statusEl,
      this.joinSection,
      this.padSection,
      this.holdControl,
      this.debugSection,
    );
    this.buildPad();
  }

  /**
   * The mask to send: everything held right now, plus anything pressed since
   * the last frame even if it has already been let go.
   */
  takeButtonMask(): number {
    const mask = this.buttons | this.latched;
    this.latched = 0;
    return mask;
  }

  /**
   * The hold control stays reachable after joining: rotation lock is invisible
   * from in here, so the player has to be able to fix it while playing.
   */
  onHoldModeChange(listener: (mode: HoldMode) => void): void {
    this.onHoldChange = listener;
    listener(this.holdMode);
  }

  private buildHoldControl(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'hold';

    const caption = document.createElement('span');
    caption.className = 'hold-caption';
    caption.textContent = '잡는 방향';
    row.append(caption);

    for (const { mode, label } of HOLD_LABELS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hold-option';
      button.textContent = label;
      button.dataset['mode'] = mode;
      button.classList.toggle('selected', mode === this.holdMode);

      button.addEventListener('click', () => {
        this.holdMode = mode;
        for (const other of row.querySelectorAll('.hold-option')) {
          other.classList.toggle('selected', other === button);
        }
        this.onHoldChange?.(mode);
      });
      row.append(button);
    }
    return row;
  }

  /** The room is gone; put the player back where they can pick another. */
  showJoinAgain(reason: string): void {
    this.padSection.classList.add('hidden');
    this.holdControl.classList.add('hidden');
    this.joinSection.classList.remove('hidden');
    this.setStatus('failed', reason);
    if (this.joinHandler) this.showJoinForm(this.prefilledRoom, this.joinHandler);
  }

  showJoinForm(prefilledRoom: string, onJoin: (request: JoinRequest) => void): void {
    this.joinHandler = onJoin;
    this.prefilledRoom = prefilledRoom;
    this.joinSection.classList.remove('hidden');
    const title = document.createElement('h1');
    title.textContent = 'PhoneMote';

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'PC 화면의 4자리 룸 코드를 입력하세요.';

    this.roomInput.className = 'room-code';
    this.roomInput.value = prefilledRoom;
    this.roomInput.placeholder = 'ABCD';
    this.roomInput.maxLength = 4;
    this.roomInput.autocapitalize = 'characters';
    this.roomInput.autocomplete = 'off';
    this.roomInput.spellcheck = false;
    this.roomInput.inputMode = 'text';

    this.nameInput.className = 'name';
    this.nameInput.placeholder = '이름 (선택)';
    this.nameInput.maxLength = 12;
    this.nameInput.autocomplete = 'off';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'start';
    submit.textContent = '컨트롤러 시작';

    // Kept on the join screen so a second phone can fix its own trust without
    // anyone going back to the PC (README 3).
    const caLink = document.createElement('a');
    caLink.className = 'ca-link';
    caLink.href = '/rootCA.crt';
    caLink.textContent = '인증서 경고가 뜬다면: 루트 CA 내려받기';

    this.joinSection.replaceChildren(
      title,
      hint,
      this.roomInput,
      this.nameInput,
      this.buildHoldControl(),
      submit,
      caLink,
    );
    this.joinSection.addEventListener('submit', (event) => {
      event.preventDefault();
      const roomCode = this.roomInput.value.trim().toUpperCase();
      if (roomCode.length !== 4) {
        this.setStatus('failed', '룸 코드는 4자리입니다');
        return;
      }
      onJoin({ roomCode, name: this.nameInput.value.trim() });
    });
  }

  showPad(color: string, playerId: number): void {
    this.joinSection.classList.add('hidden');
    this.padSection.classList.remove('hidden');
    this.holdControl.replaceChildren(this.buildHoldControl());
    this.holdControl.classList.remove('hidden');
    document.body.style.setProperty('--player', color);
    this.setStatus('joined', `P${playerId}`);
  }

  setStatus(state: ConnectionState, detail?: string): void {
    this.statusEl.textContent = detail ? `${STATE_TEXT[state]} · ${detail}` : STATE_TEXT[state];
    this.statusEl.dataset['state'] = state;
  }

  setDebugText(text: string): void {
    this.debugSection.textContent = text;
  }

  vibrate(pattern: number[]): void {
    // Optional everywhere: if the phone will not buzz, the game plays on.
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  }

  private buildPad(): void {
    for (const { name, label, className } of BUTTON_LAYOUT) {
      const bit = BUTTON[name];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn ${className}`;
      button.textContent = label;
      button.dataset['button'] = name;

      const press = (event: PointerEvent): void => {
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        this.buttons |= bit;
        this.latched |= bit;
        button.classList.add('down');
      };
      const release = (event: PointerEvent): void => {
        event.preventDefault();
        this.buttons &= ~bit;
        button.classList.remove('down');
      };

      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('contextmenu', (event) => event.preventDefault());
      this.padSection.append(button);
    }
  }
}
