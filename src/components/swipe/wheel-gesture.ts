// Turns the stream of `wheel` events from a two-finger trackpad swipe into
// discrete swipe actions. Pure (no DOM), so it can be unit tested.
//
// The hard part is the inertia tail: after a swipe, macOS keeps sending
// decaying wheel events for a second or more. That tail must not fire again,
// but a NEW swipe started while the tail is still running must. Clicking
// stops momentum, which is why a click used to "unstick" repeated swipes.

export type WheelSwipe = "left" | "right" | "up" | "down";

export type WheelInput = {
  deltaX: number;
  deltaY: number;
  timeStamp: number;
};

// How much travel before a gesture counts.
const THRESHOLD = 60;
// A pause longer than this means fingers lifted: next event is a new gesture.
const GAP_MS = 140;
// A move this strong in a different direction is a deliberate new swipe.
const REARM = 35;
// Inertia only ever decays. Once the tail has dropped to half its peak, a
// clear rise (at least double the lowest point and RISE_ABS more) can only be
// fingers back on the trackpad starting another swipe the same way.
const DECAY_RATIO = 0.5;
const RISE_ABS = 10;

export function createWheelGesture() {
  let accX = 0;
  let accY = 0;
  let fired = false;
  let lastTime = -Infinity;
  let firedAxis: "x" | "y" = "x";
  let firedSign = 0;
  let peak = 0;
  let trough = Infinity;
  let decaying = false;

  const reset = () => {
    accX = 0;
    accY = 0;
    fired = false;
  };

  return (event: WheelInput): WheelSwipe | null => {
    if (event.timeStamp - lastTime > GAP_MS) reset();
    lastTime = event.timeStamp;

    if (fired) {
      const absX = Math.abs(event.deltaX);
      const absY = Math.abs(event.deltaY);
      const axis: "x" | "y" = absX >= absY ? "x" : "y";
      const sign = Math.sign(axis === "x" ? event.deltaX : event.deltaY);
      const mag = axis === "x" ? absX : absY;

      if (axis !== firedAxis || sign !== firedSign) {
        if (mag > REARM) reset();
        else return null;
      } else {
        // Same direction: inertia tail, unless it starts rising again.
        peak = Math.max(peak, mag);
        if (!decaying && mag <= peak * DECAY_RATIO) decaying = true;
        if (decaying) {
          trough = Math.min(trough, mag);
          const rising = mag >= trough * 2 && mag >= trough + RISE_ABS;
          if (!rising) return null;
          reset();
        } else {
          return null;
        }
      }
    }

    accX += event.deltaX;
    accY += event.deltaY;
    if (Math.abs(accX) < THRESHOLD && Math.abs(accY) < THRESHOLD) return null;

    const horizontal = Math.abs(accX) > Math.abs(accY);
    fired = true;
    firedAxis = horizontal ? "x" : "y";
    firedSign = Math.sign(horizontal ? accX : accY);
    peak = Math.abs(horizontal ? event.deltaX : event.deltaY);
    trough = Infinity;
    decaying = false;

    // Natural scrolling: fingers moving right produce negative deltaX, and
    // fingers moving up produce positive deltaY.
    if (horizontal) return accX < 0 ? "right" : "left";
    return accY > 0 ? "up" : "down";
  };
}
