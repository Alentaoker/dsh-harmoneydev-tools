"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type WheelEvent,
} from "react";
import { getContentScrollMetrics } from "@/lib/chat-scroll";

const MIN_THUMB_HEIGHT = 48;

interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

interface DragState {
  pointerId: number;
  startClientY: number;
  startScrollTop: number;
}

interface Props {
  ariaLabel: string;
  scrollContainer: RefObject<HTMLDivElement | null>;
}

const EMPTY_METRICS: ScrollMetrics = {
  clientHeight: 0,
  scrollHeight: 0,
  scrollTop: 0,
};

export function ChatScrollRail({ ariaLabel, scrollContainer }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef(0);
  const [metrics, setMetrics] = useState<ScrollMetrics>(EMPTY_METRICS);
  const [isDragging, setIsDragging] = useState(false);

  const measure = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const transientTail = scrollEl.querySelector<HTMLElement>("[data-chat-tail-spacer]");
    const contentMetrics = getContentScrollMetrics({
      clientHeight: scrollEl.clientHeight,
      scrollHeight: scrollEl.scrollHeight,
      scrollTop: scrollEl.scrollTop,
      transientTailHeight: transientTail?.offsetHeight ?? 0,
    });
    const next = {
      clientHeight: scrollEl.clientHeight,
      scrollHeight: contentMetrics.scrollHeight,
      scrollTop: contentMetrics.scrollTop,
    };
    setMetrics(previous => previous.clientHeight === next.clientHeight
      && previous.scrollHeight === next.scrollHeight && previous.scrollTop === next.scrollTop ? previous : next);
  }, [scrollContainer]);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    measure();
    scrollEl.addEventListener("scroll", scheduleMeasure, { passive: true });

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(scrollEl);
    if (scrollEl.firstElementChild) observer?.observe(scrollEl.firstElementChild);

    return () => {
      scrollEl.removeEventListener("scroll", scheduleMeasure);
      observer?.disconnect();
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [measure, scheduleMeasure, scrollContainer]);

  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const railHeight = Math.max(0, metrics.clientHeight);
  const thumbHeight = maxScrollTop === 0
    ? railHeight
    : Math.max(MIN_THUMB_HEIGHT, railHeight * metrics.clientHeight / metrics.scrollHeight);
  const thumbTravel = Math.max(0, railHeight - thumbHeight);
  const thumbTop = maxScrollTop === 0 ? 0 : metrics.scrollTop / maxScrollTop * thumbTravel;
  const scrollable = maxScrollTop > 0 && thumbTravel > 0;

  const scrollTo = useCallback((top: number, behavior: ScrollBehavior = "auto") => {
    scrollContainer.current?.scrollTo({
      top: Math.min(maxScrollTop, Math.max(0, top)),
      behavior,
    });
  }, [maxScrollTop, scrollContainer]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!scrollable || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();

    const rail = railRef.current;
    const scrollEl = scrollContainer.current;
    if (!rail || !scrollEl) return;

    let startScrollTop = scrollEl.scrollTop;
    const clickedThumb = event.target instanceof Element && event.target.closest("[data-chat-scroll-thumb]");
    if (!clickedThumb) {
      const pointerOffset = event.clientY - rail.getBoundingClientRect().top;
      const nextThumbTop = Math.min(thumbTravel, Math.max(0, pointerOffset - thumbHeight / 2));
      startScrollTop = nextThumbTop / thumbTravel * maxScrollTop;
      scrollTo(startScrollTop);
    }

    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startScrollTop,
    };
    setIsDragging(true);
  }, [maxScrollTop, scrollContainer, scrollTo, scrollable, thumbHeight, thumbTravel]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || thumbTravel === 0) return;
    event.preventDefault();
    const delta = event.clientY - drag.startClientY;
    scrollTo(drag.startScrollTop + delta / thumbTravel * maxScrollTop);
  }, [maxScrollTop, scrollTo, thumbTravel]);

  const finishDrag = useCallback((pointerId: number) => {
    if (dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const lineStep = 56;
    const pageStep = Math.max(lineStep, scrollEl.clientHeight * 0.85);
    let nextTop: number | null = null;
    if (event.key === "ArrowUp") nextTop = scrollEl.scrollTop - lineStep;
    else if (event.key === "ArrowDown") nextTop = scrollEl.scrollTop + lineStep;
    else if (event.key === "PageUp") nextTop = scrollEl.scrollTop - pageStep;
    else if (event.key === "PageDown") nextTop = scrollEl.scrollTop + pageStep;
    else if (event.key === "Home") nextTop = 0;
    else if (event.key === "End") nextTop = scrollEl.scrollHeight;
    if (nextTop === null) return;
    event.preventDefault();
    scrollTo(nextTop);
  }, [scrollContainer, scrollTo]);

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    event.preventDefault();
    scrollTo(scrollEl.scrollTop + event.deltaY);
  }, [scrollContainer, scrollTo]);

  if (!scrollable) return null;

  const valueNow = Math.round(metrics.scrollTop);
  const valueMax = Math.round(maxScrollTop);
  const percent = valueMax === 0 ? 0 : Math.round(valueNow / valueMax * 100);

  return (
    <div
      ref={railRef}
      className={`chat-column-scroll-rail${isDragging ? " is-dragging" : ""}`}
      role="scrollbar"
      aria-controls="chat-scroll-container"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      aria-valuetext={`${percent}%`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerCancel={(event) => finishDrag(event.pointerId)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finishDrag(event.pointerId)}
      onLostPointerCapture={(event) => finishDrag(event.pointerId)}
      onWheel={onWheel}
    >
      <span
        className="chat-column-scroll-thumb"
        data-chat-scroll-thumb=""
        style={{ height: thumbHeight, transform: `translateY(${thumbTop}px)` }}
        aria-hidden="true"
      />
    </div>
  );
}
