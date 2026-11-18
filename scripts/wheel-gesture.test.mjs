import test from 'node:test'
import assert from 'node:assert/strict'
import { createWheelGesture } from '../src/components/swipe/wheel-gesture.ts'

// Build a stream of wheel events, 16ms apart, from a list of deltaY values
// (or [dx, dy] pairs). Returns the actions it fired.
const run = (deltas, { start = 0, gesture = createWheelGesture() } = {}) => {
  const fired = []
  deltas.forEach((d, i) => {
    const [deltaX, deltaY] = Array.isArray(d) ? d : [0, d]
    const action = gesture({ deltaX, deltaY, timeStamp: start + i * 16 })
    if (action) fired.push(action)
  })
  return fired
}

// A swipe down (natural scrolling: negative deltaY) that ramps up, then the
// long decaying inertia tail macOS sends after the fingers lift.
const swipeDown = [-4, -12, -30, -55, -70]
const inertia = Array.from({ length: 60 }, (_, i) => -Math.max(1, Math.round(70 * 0.93 ** i)))

test('one swipe with a long inertia tail fires once', () => {
  assert.deepEqual(run([...swipeDown, ...inertia]), ['down'])
})

test('second swipe the same way during the inertia tail fires again', () => {
  // Fingers go back down mid-tail: no pause, so only the rise reveals it.
  const tail = inertia.slice(0, 30)
  assert.deepEqual(run([...swipeDown, ...tail, ...swipeDown, ...inertia]), ['down', 'down'])
})

test('three swipes down in a row (undo, undo, undo) fire three times', () => {
  const tail = inertia.slice(0, 25)
  const stream = [...swipeDown, ...tail, ...swipeDown, ...tail, ...swipeDown, ...inertia]
  assert.deepEqual(run(stream), ['down', 'down', 'down'])
})

test('deltas still rising after it fires do not fire twice', () => {
  assert.deepEqual(run([-5, -15, -45, -90, -120, -100, ...inertia]), ['down'])
})

test('small jitter in the inertia tail does not fire', () => {
  const jittery = [-40, -20, -10, -5, -3, -4, -3, -6, -4, -2, -3, -1]
  assert.deepEqual(run([...swipeDown, ...jittery]), ['down'])
})

test('a pause between swipes starts a new gesture', () => {
  const gesture = createWheelGesture()
  const first = run([...swipeDown, ...inertia.slice(0, 5)], { gesture })
  const second = run(swipeDown, { gesture, start: 5000 })
  assert.deepEqual([...first, ...second], ['down', 'down'])
})

test('a strong swipe the other way during the tail fires immediately', () => {
  const swipeUp = [4, 12, 30, 55, 70]
  assert.deepEqual(run([...swipeDown, ...inertia.slice(0, 10), ...swipeUp]), ['down', 'up'])
})

test('horizontal swipes map to funny (right) and not funny (left)', () => {
  const g = createWheelGesture()
  const right = run([[-10, 0], [-30, 0], [-40, 0]], { gesture: g })
  const left = run([[10, 0], [30, 0], [40, 0]], { gesture: g, start: 5000 })
  assert.deepEqual([...right, ...left], ['right', 'left'])
})
