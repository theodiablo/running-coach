// Web cue backend: synthesized beeps (Web Audio — no assets, CSP-safe),
// speech via speechSynthesis, vibration where the browser has it. Foreground
// only by nature: web recording already requires the screen on. Everything is
// best-effort — a cue failure must never affect recording.

import type { CueTone } from "./index";

let ctx: AudioContext | null = null;

// Create/resume the AudioContext from a user gesture (the Start tap) so later
// programmatic beeps aren't blocked by autoplay policy.
export function primeWebAudio(): void {
  try {
    ctx = ctx || new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch { /* unsupported — beeps just won't play */ }
}

// [frequency Hz, duration s, gap-before s] triplets per tone. Directional by
// meaning: rising = go/faster, falling = ease off, triple-rise = done.
const PATTERNS: Record<CueTone, [number, number, number][]> = {
  step: [[880, 0.15, 0], [1175, 0.22, 0.08]],
  done: [[880, 0.15, 0], [1046, 0.15, 0.06], [1318, 0.3, 0.06]],
  slow: [[660, 0.12, 0], [880, 0.2, 0.06]],
  fast: [[1175, 0.12, 0], [784, 0.2, 0.06]],
};

export function playWebTone(tone: CueTone): void {
  try {
    if (!ctx || ctx.state !== "running") return;
    let at = ctx.currentTime + 0.02;
    for (const [freq, dur, gap] of PATTERNS[tone]) {
      at += gap;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // Short attack/release ramps avoid clicks at the note edges.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
      gain.gain.setValueAtTime(0.4, at + dur - 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + dur + 0.01);
      at += dur;
    }
  } catch { /* best-effort */ }
}

export function speakWeb(text: string, lang: string): void {
  try {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  } catch { /* best-effort */ }
}

export function stopWebSpeech(): void {
  try { window.speechSynthesis?.cancel(); } catch { /* best-effort */ }
}

export function vibrateWeb(pattern: number[]): void {
  try { navigator.vibrate?.(pattern); } catch { /* best-effort */ }
}
