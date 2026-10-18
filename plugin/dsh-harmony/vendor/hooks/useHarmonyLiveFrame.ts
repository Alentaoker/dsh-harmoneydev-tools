"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { consumeHarmonyVideoPackets } from "@/lib/harmony/media/browser-video-packets";
import { canStartVideoStream, screenStateSignature, type HarmonyScreenState } from "@/lib/harmony/observation/screen-state";
import { liveViewPolicy, resolveLiveViewPhase, type HarmonyLiveViewPhase } from "@/lib/harmony/observation/live-view-phase";
import { admitVideoUnit, keyframeWaitExpired, KEYFRAME_WAIT_LIMIT_MS, VideoBacklog } from "@/lib/harmony/media/video-backlog";

export type HarmonyFrameStatus = "idle" | "loading" | "live" | "error";
export type HarmonyFrameMode = "idle" | "video" | "frames";
export type { HarmonyLiveViewPhase } from "@/lib/harmony/observation/live-view-phase";

export interface HarmonyLiveFrame {
  initialPreview?:boolean;
  geometryId?: string;
  serial: string;
  generation: number;
  revision: number;
  width: number;
  height: number;
}

/**
 * Live diagnostics for the device page. Values are mutated in place so a
 * per-frame counter never causes a React render; the panel reads them whenever
 * it already re-renders for its own device poll.
 */
export interface HarmonyLiveFrameMetrics {
  channel: "video" | "frames" | "idle";
  phase: HarmonyLiveViewPhase;
  drawnFrames: number;
  /** Drawn frames per second since this connection started. */
  drawnFps: number;
  droppedFrames: number;
  firstFrameMs: number | null;
  lastRecoveryMs: number | null;
  queueDepth: number;
  backlogBytes: number;
  /** Forced reconnects used to obtain a fresh keyframe after a backlog stall. */
  resyncs: number;
  screenProbes: number;
  screenProbeFailures: number;
  screen: HarmonyScreenState | null;
}

interface UseHarmonyLiveFrameOptions {
  active: boolean;
  enabled: boolean;
  paused?: boolean;
  serial: string;
  generation?: number;
  fallbackError: string;
  chinese?: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Device list state; a device that is not online never opens a stream. */
  online?: boolean;
}

const VIDEO_CONFIG = 0x02;
const VIDEO_FRAME = 0x03;
const H264 = 0;
const RAW_RGBA = 1;
const JPEG = 2;
const STABLE_STREAM_FRAMES = 30;
const STABLE_STREAM_MS = 5_000;
/** A plain failure retries first; the compatible preview only follows afterwards. */
const MAX_VIDEO_FAILURES_BEFORE_COMPATIBLE = 3;
/** One waiting-window length before the screen state is re-evaluated. */
const UNLOCK_WAIT_WINDOW_MS = 30_000;
const BUSY_PROBE_WINDOW_MS = 10_000;
const BUSY_SCREENSHOT_INTERVAL_MS = 1_500;

type StreamConfig = {
  initialPreview?:boolean;
  changeDriven?: boolean;
  codec: number;
  width: number;
  height: number;
  fps: number;
  sps: Uint8Array;
  pps: Uint8Array;
};

type StreamAttempt = {
  geometryTimer?: number;
  geometryConfig?: StreamConfig;
  geometryRefreshing?: boolean;
  geometryId?: string;
  controller: AbortController;
  watchdog?: number;
  /** Bounded escape from waiting for a keyframe that may never arrive. */
  resyncTimer?: number;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  failure?: Error;
  startedAt: number;
  decodedFrames: number;
  jpegChain: Promise<void>;
};

async function responseError(response: Response, chinese: boolean): Promise<string> {
  return (await responseFailure(response)).messageFor(chinese);
}

async function responseFailure(response: Response): Promise<HarmonyRequestError> {
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  return new HarmonyRequestError(payload.error, response.status);
}

function startCodedUnit(unit: Uint8Array): Uint8Array {
  if ((unit[0] === 0 && unit[1] === 0 && unit[2] === 1)
    || (unit[0] === 0 && unit[1] === 0 && unit[2] === 0 && unit[3] === 1)) return unit;
  const result = new Uint8Array(unit.length + 4);
  result.set([0, 0, 0, 1]);
  result.set(unit, 4);
  return result;
}

function h264Codec(sps: Uint8Array): string {
  const unit = startCodedUnit(sps);
  const offset = unit[2] === 1 ? 3 : 4;
  const profile = unit[offset + 1] ?? 0x42;
  const compatibility = unit[offset + 2] ?? 0xe0;
  const level = unit[offset + 3] ?? 0x1f;
  return `avc1.${[profile, compatibility, level].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function keyframeData(config: StreamConfig, frame: Uint8Array): Uint8Array {
  const sps = startCodedUnit(config.sps);
  const pps = startCodedUnit(config.pps);
  const nal = startCodedUnit(frame);
  const result = new Uint8Array(sps.length + pps.length + nal.length);
  result.set(sps, 0);
  result.set(pps, sps.length);
  result.set(nal, sps.length + pps.length);
  return result;
}

function parseConfig(payload: Uint8Array): StreamConfig {
  if (payload.length < 13) throw new Error("Harmony video configuration is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const config: StreamConfig = {
    codec: view.getUint8(0),
    width: view.getUint32(1, false),
    height: view.getUint32(5, false),
    fps: view.getUint32(9, false),
    sps: new Uint8Array(),
    pps: new Uint8Array(),
  };
  if (config.width < 1 || config.height < 1 || config.width > 16_384 || config.height > 16_384) {
    throw new Error("Harmony video dimensions are invalid");
  }
  if (config.codec !== H264) {config.initialPreview=config.codec===JPEG&&payload[13]===2;return config;}
  if (payload.length < 17) throw new Error("Harmony H.264 configuration is truncated");
  let offset = 13;
  const spsLength = view.getUint16(offset, false);
  offset += 2;
  if (offset + spsLength + 2 > payload.length) throw new Error("Harmony H.264 SPS is truncated");
  config.sps = payload.slice(offset, offset + spsLength);
  offset += spsLength;
  const ppsLength = view.getUint16(offset, false);
  offset += 2;
  if (offset + ppsLength > payload.length) throw new Error("Harmony H.264 PPS is truncated");
  config.pps = payload.slice(offset, offset + ppsLength);
  config.changeDriven = payload[offset + ppsLength] === 1;
  return config;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = window.setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForDecoderCapacity(decoder: VideoDecoder, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || decoder.state !== "configured") return false;
  if (decoder.decodeQueueSize <= 8) return true;
  return new Promise((resolveCapacity) => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      decoder.removeEventListener("dequeue", check);
      signal.removeEventListener("abort", abort);
      resolveCapacity(available);
    };
    const check = () => {
      if (signal.aborted || decoder.state !== "configured") finish(false);
      else if (decoder.decodeQueueSize <= 4) finish(true);
    };
    const abort = () => finish(false);
    // Apply bounded backpressure before abandoning a dependent frame group.
    // Most short decoder bursts drain without waiting for another keyframe.
    const timer = window.setTimeout(() => finish(!signal.aborted && decoder.state === "configured" && decoder.decodeQueueSize <= 8), 1_000);
    decoder.addEventListener("dequeue", check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

function reconnectDelay(failures: number): number {
  return Math.min(8_000, 250 * (2 ** Math.min(Math.max(0, failures - 1), 5)));
}

function emptyMetrics(): HarmonyLiveFrameMetrics {
  return {
    channel: "idle", phase: "offline", drawnFrames: 0, drawnFps: 0, droppedFrames: 0,
    firstFrameMs: null, lastRecoveryMs: null, queueDepth: 0, backlogBytes: 0, resyncs: 0,
    screenProbes: 0, screenProbeFailures: 0, screen: null,
  };
}

export function useHarmonyLiveFrame(options: UseHarmonyLiveFrameOptions) {
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const previewLifecycle = useRef<AbortController | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState<HarmonyFrameStatus>("idle");
  const [mode, setMode] = useState<HarmonyFrameMode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<HarmonyLiveFrame | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [videoBlocked, setVideoBlocked] = useState(false);
  const [videoRecovery, setVideoRecovery] = useState<HarmonyRequestError['videoRecovery']>();
  const [screen, setScreen] = useState<HarmonyScreenState | null>(null);
  const [phase, setPhase] = useState<HarmonyLiveViewPhase>("offline");
  const metricsRef = useRef<HarmonyLiveFrameMetrics>(emptyMetrics());
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    const update = () => {
      if (document.hidden) previewLifecycle.current?.abort();
      // A revision also handles a hide/show pair batched into one React render.
      setVisibilityEpoch(epoch => epoch + 1);
    };
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const metrics = metricsRef.current;
    if (!options.active || !options.enabled || !options.serial || options.generation === undefined) {
      setFrame(null);
      setStatus("idle");
      setMode("idle");
      setError(null);
      setFallbackReason(null);
      setVideoBlocked(false);
      setVideoRecovery(undefined);
      setScreen(null);
      setPhase("offline");
      metrics.channel = "idle"; metrics.phase = "offline";
      return;
    }
    if (options.paused || document.hidden) {
      setFrame(current => current?.geometryId ? { ...current, geometryId: undefined } : current);
      setStatus("idle");
      setPhase("paused");
      metrics.phase = "paused";
      return;
    }

    const lifecycle = new AbortController();
    previewLifecycle.current = lifecycle;
    let disposed = false;
    let decoder: VideoDecoder | undefined;
    let decoderEpoch = 0;
    let config: StreamConfig | undefined;
    let revision = 0;
    let firstKeyframe = false;
    let failures = 0;
    let hasFrame = false;
    let activeAttempt: StreamAttempt | undefined;
    let drawingCanvas: HTMLCanvasElement | null = null;
    let drawingContext: CanvasRenderingContext2D | null = null;
    // Phase inputs are mirrored locally because React state is not readable
    // synchronously inside the reconnect loop.
    let localMode: HarmonyFrameMode = "video";
    let localStatus: HarmonyFrameStatus = "loading";
    let localBlocked = false;
    let localScreen: HarmonyScreenState | null = null;
    let screenSignature = "unknown";
    let wakeRetry: (() => void) | null = null;
    let wakeProbe: (() => void) | null = null;
    /** Increments on every unusable → usable transition. */
    let usableEpoch = 0;
    let lastUsable = false;
    const backlog = new VideoBacklog();
    /** Compressed sizes submitted to the decoder and not yet emitted. */
    const pendingSizes: number[] = [];
    let awaitingKeyframe = false;
    let awaitingSince: number | null = null;
    let queueDepth = 0;
    let publishedFirstFrame = false;
    const streamStartedAt = performance.now();
    const online = options.online !== false;

    const publishPhase = () => {
      const next = resolveLiveViewPhase({
        enabled: true, paused: false, online, awake: localScreen?.awake, locked: localScreen?.locked,
        mode: localMode, status: localStatus, videoBlocked: localBlocked,
      });
      metrics.phase = next;
      setPhase(current => current === next ? current : next);
      return next;
    };
    const updateScreenState = (next: HarmonyScreenState | null) => {
      localScreen = next;
      metrics.screen = next;
      const signature = screenStateSignature(next ?? undefined);
      if (signature !== screenSignature) {
        const previous = screenSignature;
        screenSignature = signature;
        setScreen(next);
        // The phone just became usable again: skip the remaining backoff.
        if (next && canStartVideoStream(next) && previous !== "unknown") wakeRetry?.();
      }
      const usable = Boolean(next && canStartVideoStream(next));
      if (usable && !lastUsable) {
        // Any waiting window must be able to end on this transition, including
        // the screenshot window that follows plain stream failures.
        usableEpoch += 1;
      }
      lastUsable = usable;
      publishPhase();
    };
    const policy = () => liveViewPolicy(publishPhase());
    const contextFor = (canvas: HTMLCanvasElement) => {
      if (drawingCanvas !== canvas) {
        drawingCanvas = canvas;
        drawingContext = canvas.getContext("2d", { alpha: false });
      }
      return drawingContext;
    };
    const setLocalMode = (next: HarmonyFrameMode) => { localMode = next; metrics.channel = next === "video" ? "video" : next === "frames" ? "frames" : "idle"; setMode(next); };
    const setLocalStatus = (next: HarmonyFrameStatus) => { localStatus = next; setStatus(next); };
    const closeDecoder = () => {
      // A stream can change configuration without replacing its connection.
      // Invalidate callbacks before close, which may itself deliver an error.
      decoderEpoch += 1;
      // WebCodecs closes itself after a fatal decode error.
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = undefined;
      backlog.clear();
      pendingSizes.length = 0;
      awaitingKeyframe = false;
      awaitingSince = null;
      queueDepth = 0;
    };
    const armWatchdog = (attempt: StreamAttempt,timeoutMs=15000) => {
      window.clearTimeout(attempt.watchdog);
      // This native source emits only when pixels change. Once a real frame
      // has decoded, silence alone is not evidence of a broken connection.
      // EOF, transport errors and device/geometry checks still detect loss.
      if (config?.changeDriven && attempt.decodedFrames > 0) return;
      attempt.watchdog = window.setTimeout(() => {
        if (disposed || activeAttempt !== attempt) return;
        attempt.failure = new Error("Harmony video stopped producing frames");
        attempt.controller.abort();
        void attempt.reader?.cancel(attempt.failure).catch(() => undefined);
      }, timeoutMs);
    };

    setFrame(null);
    setLocalStatus("loading");
    setLocalMode("video");
    setError(null);
    setFallbackReason(null);
    setVideoBlocked(false);
    setVideoRecovery(undefined);
    localBlocked = false;
    metrics.drawnFrames = 0; metrics.droppedFrames = 0; metrics.firstFrameMs = null;
    metrics.lastRecoveryMs = null; metrics.screenProbes = 0; metrics.screenProbeFailures = 0; metrics.resyncs = 0;
    publishPhase();
    const initialCanvas = options.canvasRef.current;
    if (initialCanvas) contextFor(initialCanvas)?.clearRect(0, 0, initialCanvas.width, initialCanvas.height);

    const refreshGeometry = async (attempt: StreamAttempt, expected: StreamConfig) => {
      const isCurrent = () => !disposed && !attempt.controller.signal.aborted && activeAttempt === attempt && attempt.geometryConfig === expected;
      if (!isCurrent() || attempt.geometryRefreshing) return;
      attempt.geometryRefreshing = true;
      let geometryId: string | undefined;
      try {
        const response = await fetch(`/api/harmony/geometry?serial=${encodeURIComponent(options.serial)}&space=video`, { cache: "no-store", signal: attempt.controller.signal });
        if (response.ok) {
          const { geometry } = await response.json();
          if (geometry?.frameWidth === expected.width && geometry?.frameHeight === expected.height && typeof geometry.geometryId === "string") geometryId = geometry.geometryId;
        }
      } catch { /* A later automatic probe can recover without reconnecting. */ }
      if (!isCurrent()) return;
      attempt.geometryId = geometryId;
      attempt.geometryRefreshing = false;
      // A static phone may not send another frame after the asynchronous probe.
      // Publish readiness (and failures) immediately, without waiting for pixels.
      setFrame(current => current && current.width === expected.width && current.height === expected.height
        && current.geometryId !== geometryId ? { ...current, geometryId } : current);
      attempt.geometryTimer = window.setTimeout(() => {
        attempt.geometryTimer = undefined;
        void refreshGeometry(attempt, expected);
      }, expected.changeDriven ? 5000 : 1500);
    };

    const publishFrame = (width: number, height: number, attempt: StreamAttempt) => {
      if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
      if (attempt.geometryConfig && !attempt.geometryRefreshing && attempt.geometryTimer === undefined) void refreshGeometry(attempt, attempt.geometryConfig);
      revision += 1;
      attempt.decodedFrames += 1;
      metrics.drawnFrames += 1;
      const elapsedSeconds = (performance.now() - streamStartedAt) / 1000;
      if (elapsedSeconds > 0.25) metrics.drawnFps = Math.round((metrics.drawnFrames / elapsedSeconds) * 10) / 10;
      if (!publishedFirstFrame) { publishedFirstFrame = true; metrics.firstFrameMs = Math.round(performance.now() - streamStartedAt); }
      armWatchdog(attempt);
      if (attempt.decodedFrames >= STABLE_STREAM_FRAMES || performance.now() - attempt.startedAt >= STABLE_STREAM_MS) {
        if (failures > 0) metrics.lastRecoveryMs = Math.round(performance.now() - attempt.startedAt);
        failures = 0;
      }
      const nextFrame = { serial: options.serial, generation: options.generation!, revision, width, height, geometryId: attempt.geometryId,initialPreview:config?.initialPreview===true };
      if (!hasFrame) {
        hasFrame = true;
        setFrame(nextFrame);
      } else {
        setFrame((current) => current && current.width === width && current.height === height && current.geometryId === nextFrame.geometryId&&current.initialPreview===nextFrame.initialPreview ? current : nextFrame);
      }
      setLocalStatus("live");
      setError(null);
      setFallbackReason(config?.initialPreview?(options.chinese?'视频通道已连接，先显示当前预览；画面变化后切入实时视频。':'Video connected; showing initial preview until the screen changes.'):null);
      if (localBlocked) { localBlocked = false; setVideoBlocked(false); setVideoRecovery(undefined); }
      publishPhase();
    };

    const drawVideoFrame = (videoFrame: VideoFrame, attempt: StreamAttempt) => {
      try {
        const canvas = options.canvasRef.current;
        if (!canvas || disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
        const width = videoFrame.displayWidth || videoFrame.codedWidth;
        const height = videoFrame.displayHeight || videoFrame.codedHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        contextFor(canvas)?.drawImage(videoFrame, 0, 0, width, height);
        publishFrame(width, height, attempt);
      } finally {
        videoFrame.close();
      }
    };

    const configureDecoder = async (next: StreamConfig, attempt: StreamAttempt) => {
      closeDecoder();
      const configuredEpoch = decoderEpoch;
      firstKeyframe = false;
      if (next.codec !== H264) return;
      if (!("VideoDecoder" in window)) throw new Error("This Piora runtime does not support hardware video decoding");
      const decoderConfig: VideoDecoderConfig = {
        codec: h264Codec(next.sps),
        codedWidth: next.width,
        codedHeight: next.height,
        optimizeForLatency: true,
        hardwareAcceleration: "prefer-hardware",
      };
      const support = await VideoDecoder.isConfigSupported(decoderConfig);
      if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || decoderEpoch !== configuredEpoch) return;
      if (!support.supported) throw new Error(`H.264 decoder ${decoderConfig.codec} is unavailable`);
      decoder = new VideoDecoder({
        output: (videoFrame) => {
          if (decoderEpoch !== configuredEpoch) {
            videoFrame.close();
            return;
          }
          // One compressed unit left the decoder queue for one emitted frame.
          const released = pendingSizes.shift() ?? 0;
          if (released) backlog.release(released);
          if (queueDepth > 0) queueDepth -= 1;
          metrics.queueDepth = queueDepth;
          metrics.backlogBytes = backlog.queuedBytes;
          drawVideoFrame(videoFrame, attempt);
        },
        error: (decodeError) => {
          if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || decoderEpoch !== configuredEpoch) return;
          const failure = new Error(decodeError.message || options.fallbackError);
          attempt.failure = failure;
          void attempt.reader?.cancel(failure).catch(() => undefined);
        },
      });
      decoder.configure(support.config ?? decoderConfig);
    };

    const drawJpeg = async (bytes: Uint8Array, next: StreamConfig, attempt: StreamAttempt) => {
      const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" }));
      try {
        const canvas = options.canvasRef.current;
        if (!canvas || disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
        if (canvas.width !== next.width || canvas.height !== next.height) {
          canvas.width = next.width;
          canvas.height = next.height;
        }
        contextFor(canvas)?.drawImage(bitmap, 0, 0, next.width, next.height);
        publishFrame(next.width, next.height, attempt);
      } finally {
        bitmap.close();
      }
    };

    const drawRgba = (bytes: Uint8Array, next: StreamConfig, attempt: StreamAttempt) => {
      if (bytes.length < 8) throw new Error("Harmony RGBA frame is truncated");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint32(0, false);
      const height = view.getUint32(4, false);
      if (width !== next.width || height !== next.height || bytes.length !== 8 + width * height * 4) {
        throw new Error("Harmony RGBA frame dimensions are invalid");
      }
      const canvas = options.canvasRef.current;
      if (!canvas || disposed || activeAttempt !== attempt) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const pixels = new Uint8ClampedArray(bytes.slice(8).buffer as ArrayBuffer);
      contextFor(canvas)?.putImageData(new ImageData(pixels, width, height), 0, 0);
      publishFrame(width, height, attempt);
    };

    const processPacket = async (type: number, payload: Uint8Array, attempt: StreamAttempt) => {
      if (type === VIDEO_CONFIG) {
        config = parseConfig(payload);
        setLocalMode(config.initialPreview?'frames':'video');
        window.clearTimeout(attempt.geometryTimer);
        attempt.geometryTimer = undefined;
        attempt.geometryConfig = config;
        attempt.geometryRefreshing = false;
        attempt.geometryId = undefined;
        setFrame(previous => previous ? { ...previous, geometryId: undefined } : previous);
        await configureDecoder(config, attempt);
        publishPhase();
        return;
      }
      if (type !== VIDEO_FRAME || !config || payload.length < 9) return;
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const keyframe = (view.getUint8(0) & 1) !== 0;
      const timestamp = Number(view.getBigUint64(1, false));
      const data = payload.subarray(9);
      if (config.codec === H264) {
        if (!decoder || decoder.state !== "configured") return;
        if (!firstKeyframe && !keyframe) return;
        queueDepth = decoder.decodeQueueSize;
        /**
         * A broken reference chain can only resume on a keyframe. This native
         * source emits nothing while the screen is static, so the wait is
         * bounded: the timer below forces a fresh IDR (reconnect) instead of
         * leaving a stale picture on screen forever.
         */
        const requestResync = () => {
          window.clearTimeout(attempt.resyncTimer);
          attempt.resyncTimer = undefined;
          awaitingSince = null;
          metrics.resyncs += 1;
          const failure = new Error("Harmony video did not resynchronise after a preview backlog");
          attempt.failure = failure;
          attempt.controller.abort();
          void attempt.reader?.cancel(failure).catch(() => undefined);
        };
        const beginKeyframeWait = () => {
          if (awaitingSince !== null) return;
          awaitingSince = performance.now();
          window.clearTimeout(attempt.resyncTimer);
          attempt.resyncTimer = window.setTimeout(() => {
            attempt.resyncTimer = undefined;
            if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
            if (awaitingKeyframe) requestResync();
          }, KEYFRAME_WAIT_LIMIT_MS);
        };
        const admission = admitVideoUnit({
          keyframe, awaitingKeyframe,
          backlog: backlog.sample(performance.now(), queueDepth),
        });
        awaitingKeyframe = admission.awaitingKeyframe;
        metrics.queueDepth = queueDepth;
        metrics.backlogBytes = backlog.queuedBytes;
        if (!admission.submit) {
          // Dependent frames may not be dropped individually. Skipping them is
          // safe only because the next keyframe restarts the reference chain;
          // the device encoder and the server recording are unaffected.
          metrics.droppedFrames += 1;
          beginKeyframeWait();
          return;
        }
        if (awaitingSince !== null && keyframeWaitExpired(awaitingSince, performance.now())) {
          // The timer was throttled (background tab) but the deadline passed.
          requestResync();
          throw attempt.failure ?? new Error("Harmony video did not resynchronise after a preview backlog");
        }
        window.clearTimeout(attempt.resyncTimer);
        attempt.resyncTimer = undefined;
        awaitingSince = null;
        if (decoder.decodeQueueSize > 8) {
          const pendingDecoder = decoder;
          const available = await waitForDecoderCapacity(pendingDecoder, attempt.controller.signal);
          if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || decoder !== pendingDecoder || decoder.state !== "configured") return;
          if (!available) {
            // Waiting for another keyframe on this connection can deadlock when
            // the producer only has dependent deltas left. Reconnect so the
            // bundled stream opens a fresh capture and requests a new IDR.
            const failure = new Error("Harmony video decoder remained overloaded");
            attempt.failure = failure;
            attempt.controller.abort();
            throw failure;
          }
        }
        const chunkData = keyframe ? keyframeData(config, data) : startCodedUnit(data);
        pendingSizes.push(chunkData.byteLength);
        backlog.push(chunkData.byteLength, performance.now());
        decoder.decode(new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp, data: chunkData }));
        if (keyframe) firstKeyframe = true;
      } else if (config.codec === JPEG) {
        attempt.jpegChain = attempt.jpegChain.then(() => drawJpeg(data, config!, attempt));
        await attempt.jpegChain;
      } else if (config.codec === RAW_RGBA) {
        drawRgba(data, config, attempt);
      } else {
        throw new Error(`Unsupported Harmony video codec ${config.codec}`);
      }
    };

    const consume = async (body: ReadableStream<Uint8Array>, attempt: StreamAttempt) => {
      const reader = body.getReader();
      attempt.reader = reader;
      try {
        await consumeHarmonyVideoPackets(reader, (type, payload) => processPacket(type, payload, attempt), { signal: attempt.controller.signal });
        throw attempt.failure ?? new Error("Harmony video connection closed");
      } finally {
        await reader.cancel().catch(() => undefined);
        if (attempt.reader === reader) attempt.reader = undefined;
        reader.releaseLock();
      }
    };

    /** Sleep that a screen-state change can cut short. */
    const waitRetry = (milliseconds: number): Promise<void> => new Promise<void>((resolveWait) => {
      if (lifecycle.signal.aborted) { resolveWait(); return; }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        lifecycle.signal.removeEventListener("abort", finish);
        if (wakeRetry === finish) wakeRetry = null;
        resolveWait();
      };
      const timer = window.setTimeout(finish, milliseconds);
      lifecycle.signal.addEventListener("abort", finish, { once: true });
      wakeRetry = finish;
    });

    /** The same short-circuit for the probing loop itself. */
    const waitProbe = (milliseconds: number): Promise<void> => new Promise<void>((resolveWait) => {
      if (lifecycle.signal.aborted) { resolveWait(); return; }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        lifecycle.signal.removeEventListener("abort", finish);
        if (wakeProbe === finish) wakeProbe = null;
        resolveWait();
      };
      const timer = window.setTimeout(finish, milliseconds);
      lifecycle.signal.addEventListener("abort", finish, { once: true });
      wakeProbe = finish;
    });

    /**
     * Screenshot fallback. The interval comes from the phase policy, so a
     * compatible preview costs 1～2 screenshots per second and a locked phone
     * costs one every two seconds. `shouldStop` lets the video channel reclaim
     * the preview as soon as the phone becomes usable again.
     */
    const pollFrames = async (settings: { intervalMs: number | (() => number); maxMs?: number; shouldStop?: () => boolean }) => {
      const startedAt = performance.now();
      let fallbackGeometry: { width: number; height: number; geometryId: string } | undefined;
      let fallbackGeometryCheckedAt = 0;
      let fallbackFailures = 0;
      setLocalMode("frames");
      closeDecoder();
      config = undefined;
      firstKeyframe = false;
      publishPhase();
      while (!lifecycle.signal.aborted) {
        if (settings.maxMs !== undefined && performance.now() - startedAt >= settings.maxMs) return;
        if (settings.shouldStop?.()) return;
        if (document.hidden) {
          await delay(1_000, lifecycle.signal);
          continue;
        }
        try {
          const response = await fetch(`/api/harmony/frame?serial=${encodeURIComponent(options.serial)}&v=${Date.now()}`, {
            cache: "no-store",
            signal: lifecycle.signal,
          });
          if (!response.ok) throw new Error(await responseError(response, Boolean(options.chinese)));
          const generation = Number(response.headers.get("X-Harmony-Generation"));
          const frameRevision = Number(response.headers.get("X-Harmony-Revision"));
          if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(frameRevision)) {
            throw new Error("Device frame metadata is invalid");
          }
          const bitmap = await createImageBitmap(await response.blob());
          try {
            const canvas = options.canvasRef.current;
            if (!canvas || disposed) return;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            contextFor(canvas)?.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
            hasFrame = true;
            metrics.drawnFrames += 1;
            if (fallbackGeometry?.width !== bitmap.width || fallbackGeometry?.height !== bitmap.height || performance.now() - fallbackGeometryCheckedAt > 1500) {
              // Keep verified geometry during a same-size refresh so polling cannot cancel an in-progress mouse gesture.
              if (fallbackGeometry?.width !== bitmap.width || fallbackGeometry?.height !== bitmap.height) fallbackGeometry = undefined;
              fallbackGeometryCheckedAt = performance.now();
              setFrame({ geometryId: fallbackGeometry?.geometryId, serial: options.serial, generation, revision: frameRevision, width: bitmap.width, height: bitmap.height });
              setLocalStatus("live");
              setError(null);
              const response = await fetch(`/api/harmony/geometry?serial=${encodeURIComponent(options.serial)}&space=screenshot`, { cache: "no-store", signal: lifecycle.signal }).catch(() => null);
              fallbackGeometry = undefined;
              if (response?.ok) {
                const { geometry } = await response.json();
                if (geometry?.frameWidth === bitmap.width && geometry?.frameHeight === bitmap.height) {
                  fallbackGeometry = { width: bitmap.width, height: bitmap.height, geometryId: geometry.geometryId };
                }
              }
            }
            if (disposed || lifecycle.signal.aborted) return;
            setFrame({
              geometryId: fallbackGeometry?.geometryId,
              serial: options.serial,
              generation,
              revision: frameRevision,
              width: bitmap.width,
              height: bitmap.height,
            });
            setLocalStatus("live");
            setError(null);
            fallbackFailures = 0;
            publishPhase();
          } finally {
            bitmap.close();
          }
          // Waiting through a wakeable sleep lets a confirmed unlock replace
          // the remaining interval instead of always paying for a full tick.
          await waitRetry(typeof settings.intervalMs === "function" ? settings.intervalMs() : settings.intervalMs);
        } catch (frameError) {
          if (lifecycle.signal.aborted || disposed) return;
          fallbackFailures += 1;
          // Agent device actions intentionally interrupt an in-flight passive
          // screenshot. Keep the last frame visible and retry instead of
          // presenting the device as unavailable while the Agent is working.
          if (!hasFrame) {
            setLocalStatus("error");
            setError(frameError instanceof Error ? frameError.message : options.fallbackError);
          } else {
            setLocalStatus("error");
            setFrame(previous => previous ? { ...previous, geometryId: undefined } : previous);
            fallbackGeometry = undefined;
            setError(frameError instanceof Error ? frameError.message : options.fallbackError);
          }
          publishPhase();
          await delay(Math.min(4_000, 250 * (2 ** Math.min(fallbackFailures - 1, 4))), lifecycle.signal);
        }
      }
    };

    const connect = async () => {
      while (!lifecycle.signal.aborted) {
        // A locked or sleeping phone cannot serve H.264. Wait in a cheap
        // preview/probe window instead of burning the failure backoff.
        if (localScreen && !canStartVideoStream(localScreen)) {
          await pollFrames({
            intervalMs: liveViewPolicy("waiting-unlock").screenshotIntervalMs,
            maxMs: UNLOCK_WAIT_WINDOW_MS,
            shouldStop: () => Boolean(localScreen && canStartVideoStream(localScreen)),
          });
          if (lifecycle.signal.aborted || disposed) return;
          continue;
        }
        const attempt: StreamAttempt = {
          controller: new AbortController(),
          startedAt: performance.now(),
          decodedFrames: 0,
          jpegChain: Promise.resolve(),
        };
        activeAttempt = attempt;
        // A previous PID describes a past rejection, not the in-flight probe.
        localBlocked = false;
        setVideoBlocked(false);
        setVideoRecovery(undefined);
        setFallbackReason(hasFrame ? (options.chinese ? '正在重新检查视频通道…' : 'Checking the video channel again…') : null);
        const abortAttempt = () => attempt.controller.abort();
        lifecycle.signal.addEventListener("abort", abortAttempt, { once: true });
        // Preparing the reusable driver and native channel has its own bounded
        // startup budget. Do not cancel it using the decoder's frame budget.
        armWatchdog(attempt,45000);
        if (!hasFrame) setLocalStatus("loading");
        publishPhase();
        try {
          const response = await fetch(`/api/harmony/video?serial=${encodeURIComponent(options.serial)}`, {
            cache: "no-store",
            headers: { Accept: "application/vnd.piora.harmony-stream" },
            signal: attempt.controller.signal,
          });
          if (disposed || lifecycle.signal.aborted || activeAttempt !== attempt || attempt.controller.signal.aborted) {
            await response.body?.cancel().catch(() => undefined);
            throw attempt.failure ?? new Error("Harmony video connection was cancelled");
          }
          if (!response.ok) throw await responseFailure(response);
          if (!response.body) throw new Error("Harmony video response has no stream body");
          // Establishing the connection and decoding its first frame each have
          // a bounded budget. Configuration packets cannot renew the latter;
          // only an actual displayed frame renews it after this transition.
          armWatchdog(attempt);
          await consume(response.body, attempt);
        } catch (streamError) {
          window.clearTimeout(attempt.watchdog);
          window.clearTimeout(attempt.geometryTimer);
          window.clearTimeout(attempt.resyncTimer);
          attempt.controller.abort();
          if (lifecycle.signal.aborted || disposed) return;
          failures += 1;
          // A failure is the first reason to ask the device about its screen.
          wakeProbe?.();
          setLocalStatus("error");
          setFrame(previous => previous ? { ...previous, geometryId: undefined } : previous);
          const failure = attempt.failure ?? streamError;
          const blocked = failure instanceof HarmonyRequestError && failure.videoBlocked;
          const reason = failure instanceof HarmonyRequestError ? failure.messageFor(Boolean(options.chinese))
            : failure instanceof Error ? failure.message : options.fallbackError;
          setError(reason);
          setFallbackReason(reason);
          localBlocked = blocked;
          setVideoBlocked(blocked);
          setVideoRecovery(failure instanceof HarmonyRequestError ? failure.videoRecovery : undefined);
          closeDecoder();
          config = undefined;
          firstKeyframe = false;
          if (activeAttempt === attempt) activeAttempt = undefined;
          // A locked screen is a known waiting state, not a decoder failure: it
          // gets a passive probe and a cheap preview, never a growing backoff.
          if (failure instanceof HarmonyRequestError && failure.code === "SCREEN_LOCKED") {
            await attempt.jpegChain.catch(() => undefined);
            updateScreenState({ awake: true, locked: true });
            continue;
          }
          if (blocked || failures >= MAX_VIDEO_FAILURES_BEFORE_COMPATIBLE) {
            // The packaged low-latency video service is not available on every
            // device/decoder combination. Fall back to the existing bounded
            // screenshot endpoint so observation remains available while the
            // Agent holds the exclusive write lease.
            await attempt.jpegChain.catch(() => undefined);
            // An external encoder is a known contention state, not a decoder
            // failure. Keep a low-rate preview and probe release every 10s.
            const windowStartEpoch = usableEpoch;
            await pollFrames(blocked
              ? { intervalMs: BUSY_SCREENSHOT_INTERVAL_MS, maxMs: BUSY_PROBE_WINDOW_MS }
              // The usual fallback window follows the phase policy, so a locked
              // phone costs one screenshot per two seconds instead of 750 ms,
              // and a confirmed unlock ends the window instead of waiting out
              // the full 30～120 s budget.
              : { intervalMs: () => policy().screenshotIntervalMs, maxMs: Math.min(120000, 30000 * 2 ** Math.min(Math.max(0, failures - 1), 2)),
                  shouldStop: () => usableEpoch !== windowStartEpoch });
            if(lifecycle.signal.aborted||disposed)return;
            setLocalMode("video");
            publishPhase();
            continue;
          }
          await attempt.jpegChain.catch(() => undefined);
          await waitRetry(reconnectDelay(failures));
        } finally {
          window.clearTimeout(attempt.watchdog);
          window.clearTimeout(attempt.geometryTimer);
          window.clearTimeout(attempt.resyncTimer);
          lifecycle.signal.removeEventListener("abort", abortAttempt);
          if (activeAttempt === attempt) activeAttempt = undefined;
        }
      }
    };

    /**
     * Passive lock-state probing.
     *
     * It stays idle until the panel has a reason to care (a failed attempt or a
     * known lock reading), so a healthy stream never pays for an extra device
     * command. While the phone is live it degrades to a slow heartbeat that only
     * notices the screen turning off.
     */
    const probeScreenState = async () => {
      while (!disposed && !lifecycle.signal.aborted) {
        // Nothing has been drawn and nothing has failed yet, so there is no
        // reason to spend a device command on the lock state.
        if (document.hidden || (!hasFrame && failures === 0 && localScreen === null)) {
          await waitProbe(30_000);
          continue;
        }
        try {
          metrics.screenProbes += 1;
          const response = await fetch(`/api/harmony/screen-state?serial=${encodeURIComponent(options.serial)}`, { cache: "no-store", signal: lifecycle.signal });
          if (response.ok) {
            const payload = await response.json() as { awake?: unknown; locked?: unknown };
            if (typeof payload?.awake === "boolean" && typeof payload?.locked === "boolean") {
              const usable = payload.awake && payload.locked === false;
              updateScreenState({ awake: payload.awake, locked: payload.locked });
              // The phone turned off mid-stream: drop the stream and wait.
              if (!usable && activeAttempt && !activeAttempt.controller.signal.aborted) {
                activeAttempt.failure = new Error("Harmony screen is no longer usable");
                activeAttempt.controller.abort();
              }
            }
          } else {
            metrics.screenProbeFailures += 1;
          }
        } catch {
          // A failed probe keeps the previous reading; it is not a device error.
          if (lifecycle.signal.aborted || disposed) return;
          metrics.screenProbeFailures += 1;
        }
        if (disposed || lifecycle.signal.aborted) return;
        await delay(policy().screenProbeIntervalMs, lifecycle.signal);
      }
    };
    void connect();
    void probeScreenState();
    return () => {
      disposed = true;
      lifecycle.abort();
      if (previewLifecycle.current === lifecycle) previewLifecycle.current = null;
      window.clearTimeout(activeAttempt?.watchdog);
      window.clearTimeout(activeAttempt?.geometryTimer);
      window.clearTimeout(activeAttempt?.resyncTimer);
      wakeRetry = null;
      wakeProbe = null;
      closeDecoder();
      void activeAttempt?.reader?.cancel().catch(() => undefined);
      void activeAttempt?.jpegChain.catch(() => undefined);
    };
  }, [options.active, options.canvasRef, options.chinese, options.enabled, options.fallbackError, options.generation, options.online, options.paused, options.serial, refreshKey, visibilityEpoch]);

  return { frame, status, mode, error, fallbackReason, videoBlocked, videoRecovery, refresh, phase, screen, metrics: metricsRef.current };
}
