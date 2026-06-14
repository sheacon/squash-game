import { FIRE1, FIRE2, PAD } from "./buttons";

export type InputSink = (id: number, value: 0 | 1) => void;

export function isTouchDevice(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

// Shared touch controls for BOTH host and guest: a 360-degree joystick
// bottom-left, two unlabeled fire buttons bottom-right, COIN/START pills
// bottom-center. The sink receives RetroPad (id, value) changes; the host
// wires it to simulateInput for Player 1, the guest forwards it over the
// DataChannel.
//
// The nub tracks the thumb continuously; the cabinet's stick is digital
// 8-way, so the angle quantizes to the 8 directions the game can read.
export class TouchControls {
  private joyPointer: number | null = null;
  private held = new Set<number>();
  private joy: HTMLElement;
  private nub: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly sink: InputSink,
  ) {
    this.joy = root.querySelector<HTMLElement>(".joy")!;
    this.nub = root.querySelector<HTMLElement>(".joy-nub")!;
    const joy = this.joy;

    joy.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      joy.setPointerCapture(e.pointerId);
      this.joyPointer = e.pointerId;
      joy.classList.add("active");
      this.nub.classList.remove("homing");
      this.updateJoy(e);
    });
    // pointerrawupdate (where supported) delivers digitizer-rate samples
    // without rAF alignment, so direction changes leave up to a frame earlier
    const moveEvent = "onpointerrawupdate" in joy ? "pointerrawupdate" : "pointermove";
    joy.addEventListener(moveEvent, (e) => {
      const pe = e as PointerEvent;
      if (pe.pointerId === this.joyPointer) this.updateJoy(pe);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.joyPointer) return;
      this.joyPointer = null;
      joy.classList.remove("active");
      this.nub.classList.add("homing");
      this.moveNub(0, 0);
      this.setDirections(new Set());
    };
    joy.addEventListener("pointerup", end);
    joy.addEventListener("pointercancel", end);

    this.bindButton(".btn-fire1", FIRE1);
    this.bindButton(".btn-fire2", FIRE2);
    this.bindButton(".btn-coin", PAD.SELECT);
    this.bindButton(".btn-start", PAD.START);
  }

  private bindButton(selector: string, id: number): void {
    const el = this.root.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.set(id, 1);
      el.classList.add("pressed");
    });
    const up = () => {
      this.set(id, 0);
      el.classList.remove("pressed");
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  private updateJoy(e: PointerEvent): void {
    const r = this.joy.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const maxR = r.width * 0.34;
    const len = Math.hypot(dx, dy);
    if (len > maxR) {
      dx = (dx / len) * maxR;
      dy = (dy / len) * maxR;
    }
    this.moveNub(dx, dy);

    const dead = r.width * 0.12;
    const want = new Set<number>();
    if (len > dead) {
      const angle = Math.atan2(dy, dx); // screen coords: +y down
      const oct = Math.round(angle / (Math.PI / 4));
      if (oct === 0) want.add(PAD.RIGHT);
      else if (oct === 1) { want.add(PAD.RIGHT); want.add(PAD.DOWN); }
      else if (oct === 2) want.add(PAD.DOWN);
      else if (oct === 3) { want.add(PAD.DOWN); want.add(PAD.LEFT); }
      else if (oct === 4 || oct === -4) want.add(PAD.LEFT);
      else if (oct === -3) { want.add(PAD.LEFT); want.add(PAD.UP); }
      else if (oct === -2) want.add(PAD.UP);
      else if (oct === -1) { want.add(PAD.UP); want.add(PAD.RIGHT); }
    }
    this.setDirections(want);
  }

  private moveNub(dx: number, dy: number): void {
    this.nub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  private setDirections(want: Set<number>): void {
    for (const id of [PAD.UP, PAD.DOWN, PAD.LEFT, PAD.RIGHT]) {
      const on = want.has(id);
      const was = this.held.has(id);
      if (on && !was) this.set(id, 1);
      else if (!on && was) this.set(id, 0);
    }
  }

  private set(id: number, value: 0 | 1): void {
    if (value) this.held.add(id);
    else this.held.delete(id);
    this.sink(id, value);
  }

  releaseAll(): void {
    for (const id of [...this.held]) this.set(id, 0);
  }
}

// Desktop fallback: arrows = stick, Z/X = fire, C = coin, Enter = start.
export function bindKeyboard(sink: InputSink): void {
  const map: Record<string, number> = {
    arrowup: PAD.UP,
    arrowdown: PAD.DOWN,
    arrowleft: PAD.LEFT,
    arrowright: PAD.RIGHT,
    z: FIRE1,
    x: FIRE2,
    c: PAD.SELECT,
    enter: PAD.START,
  };
  const held = new Set<string>();
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k in map && !held.has(k)) {
      held.add(k);
      sink(map[k], 1);
    }
  });
  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    if (k in map) {
      held.delete(k);
      sink(map[k], 0);
    }
  });
}
