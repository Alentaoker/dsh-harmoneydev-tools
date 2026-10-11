import { framePointFromClient } from "./geometry";

type Frame = { serial: string; generation: number; geometryId?: string; width: number; height: number };
type Rect = { left: number; top: number; width: number; height: number };
export type FramePointerGesture = {
  frame: Frame;
  pointerId: number;
  startedAt: number;
  startClientX: number;
  startClientY: number;
  maxDistance: number;
  startPoint: { x: number; y: number };
};

export function beginFrameGesture(frame: Frame, rect: Rect, x: number, y: number, pointerId: number, now: number): FramePointerGesture | null {
  if (!frame.geometryId) return null;
  const startPoint = framePointFromClient(x, y, rect, frame.width, frame.height);
  return startPoint ? { frame: { ...frame }, pointerId, startedAt: now, startClientX: x, startClientY: y, maxDistance: 0, startPoint } : null;
}

export function moveFrameGesture(gesture: FramePointerGesture, x: number, y: number) {
  gesture.maxDistance = Math.max(gesture.maxDistance, Math.hypot(x - gesture.startClientX, y - gesture.startClientY));
}

/** A cancelled or reoriented gesture must never become a tap on a different screen. */
export function finishFrameGesture(gesture: FramePointerGesture, frame: Frame | null, rect: Rect, x: number, y: number, now: number): Record<string, unknown> | null {
  const original = gesture.frame;
  if (!frame || frame.serial !== original.serial || frame.generation !== original.generation
    || frame.geometryId !== original.geometryId || frame.width !== original.width || frame.height !== original.height) return null;
  const point = framePointFromClient(x, y, rect, frame.width, frame.height);
  if (!point) return null;
  moveFrameGesture(gesture, x, y);
  const durationMs = Math.max(100, Math.min(10_000, Math.round(now - gesture.startedAt)));
  const coordinates = { coordinateSpace: "frame", geometryId: original.geometryId, generation: original.generation };
  if (gesture.maxDistance < 6) return { ...coordinates, action: durationMs >= 600 ? "long_press" : "tap", x: gesture.startPoint.x, y: gesture.startPoint.y };
  return { ...coordinates, action: durationMs >= 600 ? "drag" : "swipe", fromX: gesture.startPoint.x, fromY: gesture.startPoint.y, toX: point.x, toY: point.y, durationMs };
}
