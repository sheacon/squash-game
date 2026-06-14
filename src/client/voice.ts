// Walkie-talkie: tap TALK once to open the line (button stays depressed and
// red), tap again to close it. The RTC sessions pre-allocate an audio
// transceiver for voice, so the mic (acquired on first press) is wired in
// with replaceTrack and toggled with track.enabled: no renegotiation.
export class PushToTalk {
  private mic: MediaStreamTrack | null = null;
  private sender: RTCRtpSender | null = null;
  private denied = false;
  private active = false;

  constructor(
    private readonly button: HTMLElement,
    private readonly onToggle: (open: boolean) => void = () => {},
  ) {
    button.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (this.active) this.stop();
      else void this.start();
    });
    // never leave the line open when the app is backgrounded
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.stop();
    });
  }

  // Called whenever a (new) RTC session exists; re-wires an already-acquired mic.
  async attach(sender: RTCRtpSender | null): Promise<void> {
    this.sender = sender;
    if (sender && this.mic) {
      try {
        await sender.replaceTrack(this.mic);
      } catch {}
    }
  }

  private async start(): Promise<void> {
    if (this.denied) return;
    if (!this.mic) {
      this.button.classList.add("talking"); // immediate visual feedback
      try {
        const ms = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.mic = ms.getAudioTracks()[0] ?? null;
        if (this.mic) {
          this.mic.enabled = false;
          if (this.sender) await this.sender.replaceTrack(this.mic);
        }
      } catch {
        this.denied = true;
        this.button.classList.remove("talking");
        this.button.classList.add("denied");
        this.button.textContent = "MIC OFF";
        return;
      }
    }
    if (this.mic) {
      this.mic.enabled = true;
      this.active = true;
      this.button.classList.add("talking");
      this.onToggle(true);
    }
  }

  private stop(): void {
    if (this.mic) this.mic.enabled = false;
    const wasActive = this.active;
    this.active = false;
    this.button.classList.remove("talking");
    if (wasActive) this.onToggle(false);
  }

  get open(): boolean {
    return this.active;
  }
}
