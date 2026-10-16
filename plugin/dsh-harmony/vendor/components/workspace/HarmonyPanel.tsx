"use client";

import { brandText } from "@/lib/branding";

import { Component, useCallback, useEffect, useId, useMemo, useRef, useState, type ErrorInfo, type ReactNode, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useApplicationShortcuts } from "@/hooks/useApplicationShortcuts";
import { formatShortcutBinding, isMacPlatform, shortcutMatchesEvent, shouldPreserveApplicationShortcut } from "@/lib/keyboard-shortcuts";
import { useHarmonyManualControl } from "@/hooks/useHarmonyManualControl";
import { useHarmonyLiveFrame } from "@/hooks/useHarmonyLiveFrame";
import { beginFrameGesture, moveFrameGesture, finishFrameGesture, type FramePointerGesture } from "@/lib/harmony/observation/frame-gesture";
import { formatHarmonyDeviceLabel } from "@/lib/harmony/device-label";
import { currentHarmonyResponseSample, normalizeHarmonyResponseSample, type HarmonyResponseSample } from "@/lib/harmony/device-connection";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { copyText } from "@/lib/clipboard";
import { AliIcon } from "../AliIcon";
import { HarmonyLogViewer } from "./HarmonyLogViewer";
import { WorkbenchTools } from "./harmony/WorkbenchTools";
import { MediaHistory } from "./harmony/MediaHistory";
import { TcpDeviceConnection } from "./harmony/TcpDeviceConnection";
import styles from "./HarmonyPanel.module.css";

type RuntimeProfile = "normal" | "device-control";
type HarmonyDevice = {
  serial: string;
  state: "online" | "unauthorized" | "offline" | "unknown";
  connectionIssue?: "hdc-channel-not-ready";
  transport?: "usb" | "tcp" | "unknown";
  transportEvidence?: "hdc" | "endpoint" | "unavailable";
  responseSample?: HarmonyResponseSample;
  name?: string;
  model?: string;
  product?: string;
  osVersion?: string;
  generation: number;
  capabilities: Record<string, boolean>;
};
type PublicLease = { serial: string; owner: { kind: "agent" | "manual"; id: string; sessionId?: string }; expiresAt: string };
type HarmonyState = {
  runtime: { status: string; hdcPath?: string; error?: { code?: string; message?: string } };
  devices: HarmonyDevice[];
  leases: PublicLease[];
  controls: Array<{ serial: string; status: "stopping" | "recovering" }>;
  snapshots: Array<{ serial: string; generation: number; revision: number; capturedAt: string; hasTree: boolean; hasScreenshot: boolean }>;
};
type RecordingState = { serial: string; recordingId: string; startedAt: string; ownerId: string };
type MediaArtifact = { kind: "screenshot" | "recording"; path: string; filename: string; size: number; serial?: string; createdAt?: string; width?: number; height?: number };
type MediaNotice = {
  message: string;
  purpose?: "mirror-initialization";
  artifact?: MediaArtifact;
  copyStatus?: "copying" | "copied" | "failed";
  pathStatus?: "copying" | "copied" | "failed";
};
type RuntimeCandidate = { hdcPath: string; sdkPath: string; source: "selection" | "environment" | "config" | "deveco" | "path" | "bundled" };
type VisionModel = { provider: string; modelId: string; name: string };
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeDevices(value: unknown): HarmonyDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = recordOf(item);
    const serial = optionalString(source?.serial);
    if (!source || !serial) return [];
    const rawState = source.state;
    const state: HarmonyDevice["state"] = rawState === "online" || rawState === "unauthorized" || rawState === "offline"
      ? rawState
      : "unknown";
    const rawCapabilities = recordOf(source.capabilities);
    const capabilities = Object.fromEntries(
      Object.entries(rawCapabilities ?? {}).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
    return [{
      serial,
      state,
      ...(state === "unknown" && source.connectionIssue === "hdc-channel-not-ready" ? { connectionIssue: source.connectionIssue } : {}),
      transport: source.transport === "usb" || source.transport === "tcp" ? source.transport : "unknown",
      transportEvidence: source.transportEvidence === "hdc" || source.transportEvidence === "endpoint" ? source.transportEvidence : "unavailable",
      responseSample: normalizeHarmonyResponseSample(source.responseSample),
      ...(optionalString(source.name) ? { name: optionalString(source.name) } : {}),
      ...(optionalString(source.model) ? { model: optionalString(source.model) } : {}),
      ...(optionalString(source.product) ? { product: optionalString(source.product) } : {}),
      ...(optionalString(source.osVersion) ? { osVersion: optionalString(source.osVersion) } : {}),
      generation: typeof source.generation === "number" && Number.isFinite(source.generation) ? source.generation : 0,
      capabilities,
    }];
  });
}

function normalizeHarmonyState(value: unknown, fallbackDevices: HarmonyDevice[] = []): HarmonyState {
  const source = recordOf(value);
  const runtimeSource = recordOf(source?.runtime);
  const errorSource = recordOf(runtimeSource?.error);
  const leases = Array.isArray(source?.leases) ? source.leases.flatMap((item) => {
    const lease = recordOf(item);
    const owner = recordOf(lease?.owner);
    const serial = optionalString(lease?.serial);
    const ownerId = optionalString(owner?.id);
    const expiresAt = optionalString(lease?.expiresAt);
    if (!lease || !owner || !serial || !ownerId || !expiresAt) return [];
    const kind: PublicLease["owner"]["kind"] | null = owner.kind === "agent" ? "agent" : owner.kind === "manual" ? "manual" : null;
    if (!kind) return [];
    return [{ serial, expiresAt, owner: { kind, id: ownerId, ...(optionalString(owner.sessionId) ? { sessionId: optionalString(owner.sessionId) } : {}) } }];
  }) : [];
  const snapshots = Array.isArray(source?.snapshots) ? source.snapshots.flatMap((item) => {
    const snapshot = recordOf(item);
    const serial = optionalString(snapshot?.serial);
    const capturedAt = optionalString(snapshot?.capturedAt);
    if (!snapshot || !serial || !capturedAt) return [];
    return [{
      serial,
      generation: typeof snapshot.generation === "number" ? snapshot.generation : 0,
      revision: typeof snapshot.revision === "number" ? snapshot.revision : 0,
      capturedAt,
      hasTree: snapshot.hasTree === true,
      hasScreenshot: snapshot.hasScreenshot === true,
    }];
  }) : [];
  return {
    runtime: {
      status: optionalString(runtimeSource?.status) ?? "unavailable",
      ...(optionalString(runtimeSource?.hdcPath) ? { hdcPath: optionalString(runtimeSource?.hdcPath) } : {}),
      ...(errorSource ? { error: { code: optionalString(errorSource.code), message: optionalString(errorSource.message) } } : {}),
    },
    devices: Array.isArray(source?.devices) ? normalizeDevices(source.devices) : fallbackDevices,
    leases,
    controls: Array.isArray(source?.controls) ? source.controls.flatMap(item => {
      const control = recordOf(item);
      const serial = optionalString(control?.serial);
      const status = control?.status;
      return serial && (status === "stopping" || status === "recovering") ? [{ serial, status }] : [];
    }) : [],
    snapshots,
  };
}

function normalizeRuntimeCandidates(value: unknown): RuntimeCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = recordOf(item);
    const hdcPath = optionalString(source?.hdcPath);
    const sdkPath = optionalString(source?.sdkPath);
    if (!source || !hdcPath || !sdkPath) return [];
    const validSources: RuntimeCandidate["source"][] = ["selection", "environment", "config", "deveco", "path", "bundled"];
    const candidateSource = validSources.includes(source.source as RuntimeCandidate["source"])
      ? source.source as RuntimeCandidate["source"]
      : "path";
    return [{ hdcPath, sdkPath, source: candidateSource }];
  });
}

function normalizeVisionModels(value: unknown): VisionModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = recordOf(item);
    const provider = optionalString(source?.provider);
    const modelId = optionalString(source?.modelId);
    if (!source || !provider || !modelId) return [];
    return [{ provider, modelId, name: optionalString(source.name) ?? modelId }];
  });
}

function messageOf(error: unknown, fallback: string, chinese: boolean): string {
  return error instanceof HarmonyRequestError ? error.messageFor(chinese) : error instanceof Error ? error.message : fallback;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string } | string } & T;
  if (!response.ok) {
    throw new HarmonyRequestError(payload.error, response.status);
  }
  return payload;
}

type HarmonyPanelProps = {
  openLogRequest?: number;
  active: boolean;
  maximized?: boolean;
  onMaximizedChange?: (maximized: boolean) => void;
  sessionRunning?: boolean;
  cwd?: string | null;
  onOpenLocalTerminal?: () => void;
  onGuideAgent?: ((prompt?: string) => void) | undefined;
  onSnapshot?: (fingerprint: number) => void;
  pluginVersion?: string;
};

type FrameZoom = "fit" | "100" | "150" | "200";

export function HarmonyPanel({ active, maximized = false, onMaximizedChange, sessionRunning = false, cwd, onOpenLocalTerminal, onGuideAgent, onSnapshot, pluginVersion, openLogRequest }: HarmonyPanelProps) {
  const { locale } = useI18n();
  const chinese = locale === "zh-CN";
  const copy = useCallback((zh: string, en: string) => chinese ? zh : en, [chinese]);
  const { bindings } = useApplicationShortcuts();
  const screenshotBinding = bindings["harmony.screenshot"];
  const screenshotShortcutLabel = formatShortcutBinding(screenshotBinding, isMacPlatform(typeof window === "undefined" ? undefined : window.piDesktop?.platform));
  const panelRef = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState<RuntimeProfile | "web">("web");
  const [devices, setDevices] = useState<HarmonyDevice[]>([]);
  const [managerState, setManagerState] = useState<HarmonyState | null>(null);
  const [selectedSerial, setSelectedSerial] = useState("");
  const [sdkPath, setSdkPath] = useState("");
  const [videoProvider, setVideoProvider] = useState<"native" | "hos-scrcpy">("native");
  const [videoQuality, setVideoQuality] = useState<"efficient" | "balanced" | "smooth">("balanced");
  const [hosPackageDirectory, setHosPackageDirectory] = useState("");
  const [javaPath, setJavaPath] = useState("");
  const [runtimeCandidates, setRuntimeCandidates] = useState<RuntimeCandidate[]>([]);
  const [visionModels, setVisionModels] = useState<VisionModel[]>([]);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionModelKey, setVisionModelKey] = useState("");
  const [shareScreenshot, setShareScreenshot] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolTab, setToolTab] = useState<"apps" | "files" | "databases" | "commands" | "scenarios" | "voice" | "logs" | "history" | "tasks" | "diagnostics" | "inputs">("logs");
  const [databaseSelection, setDatabaseSelection] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsVisited, setToolsVisited] = useState(false);
  const [logLayout, setLogLayout] = useState<"side" | "bottom" | "focus">(() => {
    try { const value = localStorage.getItem("dshHarmony.logLayout"); return value === "bottom" || value === "focus" ? value : "side"; } catch { return "side"; }
  });
  const [logRatio, setLogRatio] = useState(() => {
    try { const value = Number(localStorage.getItem("dshHarmony.logRatio")); return value >= 32 && value <= 85 ? value : 70; } catch { return 70; }
  });
  const workspaceRef = useRef<HTMLElement>(null);
  const resizingLog = useRef<number>();
  useEffect(() => { try { localStorage.setItem("dshHarmony.logLayout", logLayout); localStorage.setItem("dshHarmony.logRatio", String(logRatio)); } catch {} }, [logLayout, logRatio]);
  const drawerId = useId();
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const drawerBodyRef = useRef<HTMLDivElement>(null);
  const drawerScrollPositions = useRef<Record<string, number>>({});
  const [frameZoom, setFrameZoom] = useState<FrameZoom>("fit");
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const [tree, setTree] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorPurpose, setErrorPurpose] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const visibleError = error ?? deviceError;
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [mediaNotice, setMediaNotice] = useState<MediaNotice | null>(null);
  const frameRef = useRef<HTMLCanvasElement>(null);
  const frameViewportRef = useRef<HTMLDivElement>(null);
  const framePanRef = useRef<{ pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const frameGestureRef = useRef<FramePointerGesture | null>(null);

  useEffect(() => {
    void jsonRequest<{ profile: RuntimeProfile }>("/api/harmony/profile")
      .then((result) => setProfile(result.profile))
      .catch(() => setProfile(window.piDesktop ? "normal" : "web"));
  }, []);

  const selected = useMemo(
    () => devices.find((device) => device.serial === selectedSerial) ?? null,
    [devices, selectedSerial],
  );
  const selectedOnline = selected?.state === "online";
  const desktopAvailable = profile !== "web";
  const selectedGeneration = selected?.generation;
  const canScreenshot = Boolean(selectedOnline && selected?.capabilities.screenshot);

  useEffect(() => { setDatabaseSelection(""); }, [selectedSerial]);

  const holder = managerState?.leases.find((item) => item.serial === selectedSerial);
  const controlStatus = managerState?.controls.find(item => item.serial === selectedSerial)?.status;
  const { lease, ownerId, clearControl, ensureControl, canControl, blocked } = useHarmonyManualControl({
    active: active && desktopAvailable, serial: selectedSerial,
    online: Boolean(selectedOnline), holder, chinese, controlStatus,
  });
  const changeToolTab = (tab: typeof toolTab) => {
    if (toolsOpen && drawerBodyRef.current) drawerScrollPositions.current[`${selectedSerial}:${toolTab}`] = drawerBodyRef.current.scrollTop;
    setToolTab(tab);
  };
  const openTools = (tab = toolTab) => { changeToolTab(tab); setToolsVisited(true); setToolsOpen(true); setSettingsOpen(false); };
  useEffect(() => { if (openLogRequest) openTools("logs"); }, [openLogRequest]);
  const closeTools = () => { setToolsOpen(false); toolsButtonRef.current?.focus(); };
  useEffect(() => {
    if (toolsOpen && drawerBodyRef.current) drawerBodyRef.current.scrollTop = drawerScrollPositions.current[`${selectedSerial}:${toolTab}`] ?? 0;
  }, [selectedSerial, toolTab, toolsOpen]);
  useEffect(() => {
    if (!toolsOpen) return;
    const tab = ["diagnostics", "inputs"].includes(toolTab) ? "apps" : toolTab;
    document.getElementById(`${drawerId}-${tab}`)?.focus({ preventScroll: true });
  }, [toolsOpen, toolTab, drawerId]);

  // Tell the isolating boundary whenever a fresh poll replaced the panel data
  // so it can automatically retry rendering after transient bad payloads.
  useEffect(() => {
    if (!onSnapshot) return;
    const fingerprint = devices.reduce((acc, device) => acc + device.serial.length + device.generation, 0)
      + (managerState?.runtime.status.length ?? 0)
      + (managerState?.leases.length ?? 0)
      + (managerState?.snapshots.length ?? 0);
    onSnapshot(fingerprint);
  }, [devices, managerState, onSnapshot]);
  const {
    frame: liveFrame,
    status: frameStatus,
    mode: frameMode,
    error: frameLoadError,
    fallbackReason: frameFallbackReason,
    videoBlocked: frameVideoBlocked,
    videoRecovery: frameVideoRecovery,
    refresh: requestFrame,
  } = useHarmonyLiveFrame({
    active: active && desktopAvailable,
    enabled: Boolean(selectedOnline),
    serial: selectedSerial,
    generation: selectedGeneration,
    canvasRef: frameRef,
    chinese,
    fallbackError: copy("投屏暂不可用，请检查设备授权与 HDC。", "Live view unavailable. Check device authorization and HDC."),
  });

  useEffect(() => {
    setFrameSize(liveFrame ? { width: liveFrame.width, height: liveFrame.height } : null);
  }, [liveFrame]);

  const currentNativeVideoLive = active && desktopAvailable && selectedOnline
    && frameMode === "video" && frameStatus === "live"
    && liveFrame?.serial === selectedSerial && liveFrame?.generation === selectedGeneration;
  useEffect(() => {
    if (currentNativeVideoLive && mediaNotice?.purpose === "mirror-initialization") {
      setMediaNotice(current => current?.purpose === "mirror-initialization" ? null : current);
    }
  }, [currentNativeVideoLive, mediaNotice?.purpose]);
  useEffect(() => {
    if (currentNativeVideoLive && errorPurpose === "mirror-initialization") {
      setError(null); setErrorPurpose(null);
    }
  }, [currentNativeVideoLive, errorPurpose]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!desktopAvailable) return;
    try {
      const devicePayload = await jsonRequest<unknown>("/api/harmony/devices", { signal });
      const payloadRecord = recordOf(devicePayload);
      const stateRecord = recordOf(payloadRecord?.state);
      const rawDevices = Array.isArray(payloadRecord?.devices) ? payloadRecord.devices : stateRecord?.devices;
      if (!Array.isArray(rawDevices)) throw new Error(copy("设备服务返回了无效数据", "The device service returned invalid data"));
      const nextDevices = normalizeDevices(rawDevices);
      setDevices(nextDevices);
      setManagerState(normalizeHarmonyState(payloadRecord?.state, nextDevices));
      setSelectedSerial((current) => current && nextDevices.some((device) => device.serial === current)
        ? current
        : nextDevices.find((device) => device.state === "online")?.serial ?? nextDevices[0]?.serial ?? "");
      setDeviceError(null);
    } catch (refreshError) {
      if (signal?.aborted) return;
      setDeviceError(messageOf(refreshError, copy("无法读取设备状态", "Unable to read device state"), chinese));
    }
  }, [copy, desktopAvailable, chinese]);

  const loadConfig = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const [payloadValue, modelPayloadValue] = await Promise.all([
        jsonRequest<unknown>("/api/harmony/config"),
        jsonRequest<unknown>("/api/harmony/vision-models"),
      ]);
      const payload = recordOf(payloadValue);
      const modelPayload = recordOf(modelPayloadValue);
      const config = recordOf(payload?.config);
      const diagnostics = normalizeHarmonyState(payload?.diagnostics);
      const candidates = normalizeRuntimeCandidates(payload?.candidates);
      setRuntimeCandidates(candidates);
      setSdkPath(optionalString(config?.hdcPath) ?? diagnostics.runtime.hdcPath ?? candidates[0]?.hdcPath ?? "");
      const video = recordOf(config?.video);
      setVideoProvider(video?.provider === "hos-scrcpy" ? "hos-scrcpy" : "native");
      setVideoQuality(video?.quality === "efficient" || video?.quality === "smooth" ? video.quality : "balanced");
      setHosPackageDirectory(optionalString(video?.packageDirectory) ?? "");
      setJavaPath(optionalString(video?.javaPath) ?? "");
      setVisionModels(normalizeVisionModels(modelPayload?.models));
      const vision = recordOf(config?.vision);
      const provider = optionalString(vision?.provider);
      const modelId = optionalString(vision?.modelId);
      setVisionEnabled(vision?.enabled === true && Boolean(provider && modelId));
      setVisionModelKey(provider && modelId ? `${provider}\u0000${modelId}` : "");
      setShareScreenshot(vision?.shareScreenshotWithActionModel === true);
      setDiagnostics(payload?.diagnostics ?? null);
    } catch (configError) {
      setError(messageOf(configError, copy("无法读取 SDK 配置", "Unable to read SDK configuration"), chinese));
    }
  }, [copy, desktopAvailable, chinese]);

  useEffect(() => {
    if (!active || !desktopAvailable) return;
    void loadConfig();
    let pollTimer: number | undefined;
    let pollController: AbortController | undefined;
    let disposed = false;
    const poll = async () => {
      pollController = new AbortController();
      await refresh(pollController.signal).catch(() => undefined);
      pollController = undefined;
      if (!disposed) pollTimer = window.setTimeout(() => { void poll(); }, 5_000);
    };
    void poll();
    const source = new EventSource("/api/harmony/events");
    source.onmessage = (event) => {
      try {
        const metadata = recordOf(JSON.parse(event.data));
        if (!metadata) return;
        if (metadata.type === "devices" && Array.isArray(metadata.devices)) {
          const nextDevices = normalizeDevices(metadata.devices);
          setDevices(nextDevices);
          setSelectedSerial((current) => current && nextDevices.some((device) => device.serial === current)
            ? current
            : nextDevices.find((device) => device.state === "online")?.serial ?? nextDevices[0]?.serial ?? "");
        } else if (metadata.type === "state" && metadata.state) {
          setManagerState(normalizeHarmonyState(metadata.state));
        } else if (metadata.type !== "connected" && metadata.type !== "heartbeat" && metadata.type !== "snapshot") {
          void jsonRequest<unknown>(`/api/harmony/state${selectedSerial ? `?serial=${encodeURIComponent(selectedSerial)}` : ""}`)
            .then((payload) => setManagerState(normalizeHarmonyState(recordOf(payload)?.state)))
            .catch(() => undefined);
        }
      } catch {
        // A malformed metadata event cannot affect the device command path.
      }
    };
    source.onerror = () => { /* Polling below remains the recovery path. */ };
    return () => {
      disposed = true;
      source.close();
      pollController?.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [active, desktopAvailable, loadConfig, refresh, selectedSerial]);

  useEffect(() => {
    if (!active || !desktopAvailable || !selectedSerial) {
      setRecording(null);
      return;
    }
    let disposed = false;
    const loadMedia = () => jsonRequest<{ recording: RecordingState | null }>(`/api/harmony/media?serial=${encodeURIComponent(selectedSerial)}`)
      .then((payload) => { if (!disposed) setRecording(payload.recording); })
      .catch(() => undefined);
    void loadMedia();
    const timer = window.setInterval(() => { void loadMedia(); }, 3_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [active, desktopAvailable, selectedSerial]);

  useEffect(() => {
    if (!recording) {
      setRecordingElapsed(0);
      return;
    }
    const startedAt = Date.parse(recording.startedAt);
    const updateElapsed = () => setRecordingElapsed(Number.isFinite(startedAt)
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : 0);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [recording]);

  const run = useCallback(async <T,>(operation: () => Promise<T>, after?: (value: T) => void | Promise<void>, purpose?: string) => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    try {
      const value = await operation();
      await after?.(value);
      setError(null);
      setErrorPurpose(null);
      return value;
    } catch (operationError) {
      setErrorPurpose(purpose ?? null);
      setError(messageOf(operationError, copy("设备操作失败", "Device operation failed"), chinese));
      if (operationError instanceof HarmonyRequestError && operationError.controlStatus) void refresh();
      return undefined;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [copy, chinese, refresh]);

  const chooseRuntimePath = useCallback(async (kind: "sdk" | "hdc") => {
    const selectedPath = await window.piDesktop?.selectHarmonyRuntimePath?.(kind);
    if (!selectedPath) return;
    await run(async () => {
      const payload = await jsonRequest<unknown>("/api/harmony/runtime-candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectionPath: selectedPath }),
      });
      const candidates = normalizeRuntimeCandidates(recordOf(payload)?.candidates);
      const selected = candidates.find((candidate) => candidate.source === "selection");
      if (!selected) throw new Error(copy("所选位置中没有找到 hdc", "No hdc executable was found in the selected location"));
      setRuntimeCandidates(candidates);
      setSdkPath(selected.hdcPath);
    });
  }, [copy, run]);

  const copyMediaArtifact = useCallback(async (artifact: MediaArtifact) => {
    const label = artifact.kind === "screenshot" ? copy("截图", "Screenshot") : copy("录屏文件", "Recording file");
    setMediaNotice({ artifact, copyStatus: "copying", message: copy(`${label}已保存，正在复制…`, `${label} saved. Copying…`) });
    try {
      const writeMedia = window.piDesktop?.clipboard?.copyHarmonyMedia;
      if (!writeMedia) throw new Error("Media clipboard unavailable");
      await writeMedia({ kind: artifact.kind, path: artifact.path });
      setMediaNotice((current) => current?.artifact === artifact
        ? { artifact, copyStatus: "copied", message: copy(`${label}已保存并复制到剪贴板`, `${label} saved and copied to clipboard`) }
        : current);
    } catch {
      // Saving succeeded even if clipboard access failed; keep the path available.
      setMediaNotice((current) => current?.artifact === artifact
        ? { artifact, copyStatus: "failed", message: copy(`${label}已保存，但复制失败，可重试或复制路径。`, `${label} saved, but copying failed. Retry or copy the path.`) }
        : current);
    }
  }, [copy]);

  const copyMediaPath = async () => {
    const artifact = mediaNotice?.artifact;
    if (!artifact) return;
    const updatePathStatus = (pathStatus: MediaNotice["pathStatus"]) => setMediaNotice((current) => current?.artifact === artifact ? { ...current, pathStatus } : current);
    updatePathStatus("copying");
    try {
      await copyText(artifact.path);
      updatePathStatus("copied");
    } catch {
      updatePathStatus("failed");
    }
  };

  const action = (input: Record<string, unknown>) => {
    if (!selectedSerial || !canControl) return Promise.resolve(undefined);
    return run(async () => {
      const leaseToken = await ensureControl();
      return jsonRequest("/api/harmony/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: selectedSerial, leaseToken, ...input }),
      });
    }, undefined, input.action === "initialize_mirror" ? "mirror-initialization" : undefined);
  };

  useEffect(() => {
    const cancel = () => { frameGestureRef.current = null; };
    cancel();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    window.addEventListener("resize", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      cancel();
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("keydown", escape);
    };
  }, [active, selectedSerial, selectedGeneration, canControl, controlStatus, frameZoom, liveFrame?.geometryId, liveFrame?.width, liveFrame?.height]);

  const connectLiveVideo = () => {
    if (errorPurpose === "mirror-initialization") { setError(null); setErrorPurpose(null); }
    setMediaNotice({ purpose: "mirror-initialization", message: copy("正在连接实时视频。连接成功后，画面上方会显示“实时视频流”。", "Connecting live video. A successful connection shows Live video above the image.") });
    requestFrame();
  };
  const releaseVideoConflict = () => {
    if(!frameVideoRecovery||!selectedSerial||!canControl)return;
    const expected=frameVideoRecovery;
    if(!window.confirm(copy(`将停止手机上设备 PID ${expected.devicePid} 的投屏。其他软件若仍在观看会断开；不会关闭软件、清除日志或停止其他设备。确认释放并重新连接？`,
      `Stop video process ${expected.devicePid} on this phone? Other viewers of that process will disconnect. Apps, logs and other devices are unaffected. Release and reconnect?`)))return;
    void run(async()=>{
      const leaseToken=await ensureControl();
      await jsonRequest('/api/harmony/video',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'release-conflict',serial:selectedSerial,leaseToken,confirmed:true,expected})});
      requestFrame();
    });
  };
  const mediaAction = useCallback((mediaActionName: "capture_screenshot" | "start_recording" | "stop_recording") => {
    if (!selectedSerial) return;
    const execute = async () => {
      return jsonRequest<{ artifact?: MediaArtifact; recording?: RecordingState }>("/api/harmony/media", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mediaActionName, serial: selectedSerial, ownerId,
          ...(mediaActionName === "stop_recording" && recording?.serial === selectedSerial ? { recordingId: recording.recordingId } : {}) }),
      });
    };
    const complete = async (payload: { artifact?: MediaArtifact; recording?: RecordingState }) => {
      if (payload.recording) {
        setRecording(payload.recording);
        setMediaNotice({ message: copy("录屏已开始", "Recording started") });
      } else if (payload.artifact) {
        if (payload.artifact.kind === "recording") setRecording(null);
        await copyMediaArtifact(payload.artifact);
      }
    };
    if (mediaActionName === "capture_screenshot") {
      if (screenshotBusy) return;
      setScreenshotBusy(true);
      void execute().then(async (payload) => {
        await complete(payload);
        setError(null);
      }).catch((failure) => {
        setError(messageOf(failure, copy("截图失败", "Screenshot failed"), chinese));
      }).finally(() => setScreenshotBusy(false));
    } else {
      void run(execute, complete);
    }
  }, [selectedSerial, recording, ownerId, copyMediaArtifact, screenshotBusy, run, copy, chinese]);

  useEffect(() => {
    if (!active || !canScreenshot || !screenshotBinding) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || screenshotBusy || shouldPreserveApplicationShortcut(event.target)) return;
      if (!shortcutMatchesEvent(event, screenshotBinding, isMacPlatform(window.piDesktop?.platform))) return;
      if (!panelRef.current?.getClientRects().length) return;
      if ([...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some(dialog => dialog.getClientRects().length > 0)) return;
      event.preventDefault();
      mediaAction("capture_screenshot");
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [active, canScreenshot, screenshotBinding, screenshotBusy, mediaAction]);

  const stopDevice = () => {
    clearControl();
    void run(() => jsonRequest("/api/harmony/action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop_device", serial: selectedSerial }),
    }), () => { setRecording(null); void refresh(); });
  };

  const saveSettings = () => void run(async () => {
    const [provider, modelId] = visionModelKey.split("\u0000");
    const payloadValue = await jsonRequest<unknown>("/api/harmony/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hdcPath: sdkPath.trim() || null,
        video: { provider: videoProvider, quality: videoQuality, ...(videoProvider === "hos-scrcpy" ? { packageDirectory: hosPackageDirectory.trim(), ...(javaPath.trim() ? { javaPath: javaPath.trim() } : {}) } : {}) },
        vision: visionEnabled ? { enabled: true, provider, modelId, shareScreenshotWithActionModel: shareScreenshot } : null,
      }),
    });
    const payload = recordOf(payloadValue);
    const config = recordOf(payload?.config);
    const candidates = normalizeRuntimeCandidates(payload?.candidates);
    setSdkPath(optionalString(config?.hdcPath) ?? candidates[0]?.hdcPath ?? "");
    setRuntimeCandidates(candidates);
    setDiagnostics(payload?.diagnostics ?? null);
    await refresh();
    return payloadValue;
  }, () => setSettingsOpen(false));

  const formatRecordingElapsed = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  const panFrame = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = framePanRef.current;
    const viewport = frameViewportRef.current;
    if (!pan || !viewport || pan.pointerId !== event.pointerId) return;
    viewport.scrollLeft = pan.scrollLeft + pan.startX - event.clientX;
    viewport.scrollTop = pan.scrollTop + pan.startY - event.clientY;
  };

  if (profile === "web") {
    return <div className={styles.gate}>
      <AliIcon name="mobile" size={34} />
      <h2>{copy("鸿蒙设备控制", "Harmony device control")}</h2>
      <p>{brandText(copy("该能力仅在 Piora 桌面应用中提供。", "This capability is available only in the Piora desktop app."))}</p>
      {visibleError ? <div className={styles.error} role="alert">{visibleError}</div> : null}
    </div>;
  }

  const snapshot = managerState?.snapshots.find((item) => item.serial === selectedSerial);
  const frameMatchesDevice = Boolean(liveFrame && selected && liveFrame.serial === selected.serial && liveFrame.generation === selected.generation);
  const frameInputEnabled = Boolean(active && canControl && !busy && frameMatchesDevice && liveFrame?.geometryId && frameStatus === "live");
  const frameError = frameLoadError;
  const agentHasControl = holder?.owner.kind === "agent";
  const runtimeReady = managerState?.runtime.status === "ready";
  const deviceStateLabel = selected?.state === "online"
    ? copy("已连接", "Connected")
    : selected?.state === "unauthorized"
      ? copy("等待手机授权", "Authorization needed")
      : selected?.state === "offline"
        ? copy("设备离线", "Offline")
        : selected ? copy("连接未确认", "Connection unconfirmed") : copy("未连接", "Not connected");
  const visionModel = visionModels.find((model) => `${model.provider}\u0000${model.modelId}` === visionModelKey);
  const zoomScale = frameZoom === "fit" ? null : Number(frameZoom) / 100;
  const frameCanvasStyle = zoomScale && frameSize
    ? { width: frameSize.width * zoomScale, height: frameSize.height * zoomScale, maxWidth: "none", maxHeight: "none" }
    : undefined;
  const ownsRecording = recording?.ownerId === ownerId;
  const responseSample = selectedOnline ? currentHarmonyResponseSample(selected?.responseSample) : undefined;
  const serialSuffix = selected ? devices.some(other => other.serial !== selected.serial && other.serial.slice(-6) === selected.serial.slice(-6)) ? selected.serial : selected.serial.slice(-6) : undefined;
  const connectionLabel = selected?.transport === "usb" ? "USB" : selected?.transport === "tcp" ? "TCP/Wi-Fi" : copy("连接方式未知", "Unknown transport");
  const connectionHint = selected?.transportEvidence === "endpoint"
    ? copy("连接方式根据 IP:端口标识推断，HDC 未直接标注。", "Transport inferred from IP:port; not reported directly by HDC.")
    : selected?.transportEvidence === "hdc" ? copy("连接方式由 HDC 标注。", "Transport reported by HDC.") : copy("HDC 未给出可核验的连接方式。", "HDC did not provide a verifiable transport.");

  return <div ref={panelRef} className={styles.root} data-maximized={maximized} data-harmony-panel="true">
    <header className={styles.deviceHeader}>
      <div className={styles.deviceIdentity}>
        <span className={styles.deviceMark}><AliIcon name="mobile" size={15} /></span>
        <div className={styles.deviceIdentityText}>
        <select aria-label={copy("选择设备", "Select device")} title={selected ? `${formatHarmonyDeviceLabel(selected)} · ${selected.serial}${selected.osVersion ? ` · ${selected.osVersion}` : ""}` : undefined} value={selectedSerial} onChange={(event) => {
          const nextSerial = event.target.value;
          clearControl();
          setSelectedSerial(nextSerial);
          setTree(null);
          setFrameSize(null);
          setRecording(null);
          setMediaNotice(null);
          setFrameZoom("fit");
        }}>
          {!devices.length ? <option value="">{copy("没有设备", "No device")}</option> : null}
          {devices.map((device) => {
            const label = formatHarmonyDeviceLabel(device);
            const suffix = devices.some(other => other.serial !== device.serial && other.serial.slice(-6) === device.serial.slice(-6)) ? device.serial : device.serial.slice(-6);
            return <option key={device.serial} value={device.serial}>{label === device.serial ? label : `${label} · ${suffix}`}</option>;
          })}
        </select>
        <div className={styles.deviceConnection}>
        <span className={styles.deviceState} data-state={selected?.state ?? "unknown"}><i />{deviceStateLabel}</span>
        {selected && serialSuffix ? <span title={copy(`设备序列号：${selected.serial}`, `Device serial: ${selected.serial}`)}>{selected.serial === serialSuffix ? serialSuffix : `…${serialSuffix}`}</span> : null}
        {selected ? <span title={connectionHint}>{connectionLabel}</span> : null}
        {selectedOnline ? <span title={responseSample ? copy(`最近一次只读参数响应（包含主机 HDC 耗时），采样于 ${new Date(responseSample.sampledAt).toLocaleString()}；不代表视频延迟。`, `Last read-only parameter response (includes host HDC overhead), sampled at ${new Date(responseSample.sampledAt).toLocaleString()}; not video latency.`) : copy("尚无当前可核验的参数响应样本；不会显示旧值或估算延迟。", "No current verified parameter response; stale or estimated latency is not shown.")}>{responseSample ? copy(`响应 ${responseSample.durationMs} ms`, `Response ${responseSample.durationMs} ms`) : copy("响应未确认", "Response unconfirmed")}</span> : null}
        </div></div>
      </div>
      <div className={styles.toolbarActions}>
        <button className={styles.focusButton} type="button" disabled={busy || !selectedOnline || agentHasControl} onClick={() => void action({ action: "prepare_device" }).then(() => { requestFrame(); void refresh(); })}>{copy("唤醒设备", "Wake device")}</button>
        {onMaximizedChange ? <button className={styles.focusButton} aria-label={maximized ? copy("返回双栏", "Return to split view") : toolsOpen ? copy("展开设备工作台", "Expand device workbench") : copy("专注投屏", "Focus screen")} type="button" onClick={() => onMaximizedChange(!maximized)} title={maximized ? copy("返回双栏", "Return to split view") : toolsOpen ? copy("展开设备工作台", "Expand device workbench") : copy("专注投屏", "Focus screen")}>
          <AliIcon name={maximized ? "fullscreen-exit" : "fullscreen"} size={16} />
        </button> : null}
        <button className={styles.iconButton} type="button" onClick={() => { requestFrame(); void refresh(); }} disabled={busy} title={copy("刷新设备", "Refresh devices")} aria-label={copy("刷新设备", "Refresh devices")}><AliIcon name="reload" size={14} /></button>
        <button className={styles.iconButton} type="button" onClick={() => setSettingsOpen((open) => !open)} aria-pressed={settingsOpen} title={copy("设备设置", "Device settings")} aria-label={copy("设备设置", "Device settings")}><AliIcon name="setting" size={15} /></button>
      </div>
    </header>

    {settingsOpen ? <section className={styles.settingsPanel} aria-label={copy("设备设置", "Device settings")}>
      <div className={styles.settingsHeading}>
        <span><strong>{copy("设备设置", "Device settings")}</strong><small>{copy("通常只需设置一次", "Usually a one-time setup")}</small></span>
        <button className={styles.iconButton} type="button" onClick={() => setSettingsOpen(false)} aria-label={copy("关闭设置", "Close settings")}><AliIcon name="close" size={13} /></button>
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingCopy}><strong>{copy("连接工具", "Connection")}</strong><small>{copy("选择 DevEco 中的 HDC", "Choose HDC from DevEco")}</small></div>
        {runtimeCandidates.length > 1 ? <select aria-label={copy("检测到的 HDC", "Detected HDC installations")} value={sdkPath} onChange={(event) => setSdkPath(event.target.value)}>
          {sdkPath && !runtimeCandidates.some((candidate) => candidate.hdcPath === sdkPath) ? <option value={sdkPath}>{sdkPath}</option> : null}
          {runtimeCandidates.map((candidate) => <option key={candidate.hdcPath} value={candidate.hdcPath}>{candidate.hdcPath}</option>)}
        </select> : null}
        <div className={styles.pathRow}>
          <input aria-label={copy("HDC 路径", "HDC path")} value={sdkPath} placeholder={copy("选择 DevEco SDK 或 hdc.exe", "Choose DevEco SDK or hdc.exe")} onChange={(event) => setSdkPath(event.target.value)} />
          <button className={styles.iconButton} type="button" disabled={busy} onClick={() => void chooseRuntimePath("sdk")} title={copy("选择 SDK 文件夹", "Choose SDK folder")} aria-label={copy("选择 SDK 文件夹", "Choose SDK folder")}><AliIcon name="folder-open" size={14} /></button>
          <button className={styles.iconButton} type="button" disabled={busy} onClick={() => void chooseRuntimePath("hdc")} title={copy("选择 hdc.exe", "Choose hdc.exe")} aria-label={copy("选择 hdc.exe", "Choose hdc.exe")}><AliIcon name="file" size={14} /></button>
        </div>
        {!runtimeCandidates.length ? <p className={styles.inlineHint}>{copy("没有自动找到，请手动选择。", "Nothing detected. Choose it manually.")}</p> : null}
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingCopy}><strong>{copy("手动 Wi-Fi 连接", "Manual Wi-Fi connection")}</strong><small>{copy("通过 HDC 连接或断开局域网设备", "Connect or disconnect a LAN device through HDC")}</small></div>
        <TcpDeviceConnection chinese={chinese} onRefresh={() => refresh()} />
        {selected ? <p className={styles.inlineHint}>{selected.transport === "usb" ? copy("当前设备：USB（HDC 已标注）", "Current device: USB (reported by HDC)")
          : selected.transport === "tcp" ? selected.transportEvidence === "hdc" ? copy("当前设备：TCP/Wi-Fi（HDC 已标注）", "Current device: TCP/Wi-Fi (reported by HDC)")
            : copy("当前设备：TCP/Wi-Fi（根据 IP:端口序列号推断）", "Current device: TCP/Wi-Fi (inferred from IP:port serial)")
            : copy("当前设备的连接方式未知；HDC 未给出可核实的标记", "Connection type unknown; HDC did not provide a verifiable marker")}</p> : null}
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingCopy}><strong>{copy("投屏来源", "Video provider")}</strong><small>{copy("原生 H.264 视频；无需安装投屏 HAP", "Native H.264 video; no mirror HAP installation")}</small></div>
        <select aria-label={copy("投屏来源", "Video provider")} value={videoProvider} onChange={event => setVideoProvider(event.target.value as "native" | "hos-scrcpy")}>
          <option value="native">{copy("插件原生 H.264", "Plugin native H.264")}</option><option value="hos-scrcpy">HOScrcpy</option>
        </select>
        {videoProvider === "native" ? <label>{copy("视频质量", "Video quality")}<select value={videoQuality} onChange={event => setVideoQuality(event.target.value as "efficient" | "balanced" | "smooth")}><option value="efficient">{copy("低开销 · 15 帧", "Efficient · 15 fps")}</option><option value="balanced">{copy("均衡 · 24 帧（默认）", "Balanced · 24 fps (default)")}</option><option value="smooth">{copy("流畅 · 30 帧", "Smooth · 30 fps")}</option></select></label> : null}
        {videoProvider === "hos-scrcpy" ? <>
          <label>{copy("本地 dsh-hos-scrcpy 包目录", "Local dsh-hos-scrcpy package directory")}<input value={hosPackageDirectory} onChange={event => setHosPackageDirectory(event.target.value)} /></label>
          <label>{copy("Java 可执行文件完整路径（留空使用 PATH）", "Full Java executable path (blank uses PATH)")}<input value={javaPath} onChange={event => setJavaPath(event.target.value)} /></label>
          <p className={styles.inlineHint}>{copy("需自行提供含 HOScrcpy SDK jar 和 Java sidecar 的本地包。Piora 只经已认证的设备视频接口转发画面，不向网页暴露 sidecar 地址；首次开流可能部署其设备组件。", "Supply a local package containing the HOScrcpy SDK jar and Java sidecar. Piora proxies video only through its authenticated device endpoint and does not expose the sidecar address to the browser; first capture may deploy its device component.")}</p>
        </> : null}
      </div>

      <div className={styles.settingGroup}>
        <label className={styles.settingToggle}>
          <span className={styles.settingCopy}><strong>{copy("视觉模型", "Vision model")}</strong><small>{copy("只负责看手机屏幕", "Only reads the phone screen")}</small></span>
          <input type="checkbox" checked={visionEnabled} onChange={(event) => setVisionEnabled(event.target.checked)} />
        </label>
        {visionEnabled ? <>
          <select aria-label={copy("选择视觉模型", "Select vision model")} value={visionModelKey} onChange={(event) => setVisionModelKey(event.target.value)}>
            <option value="">{copy("选择模型", "Choose model")}</option>
            {visionModelKey && !visionModels.some((model) => `${model.provider}\u0000${model.modelId}` === visionModelKey)
              ? <option value={visionModelKey}>{copy("当前不可用", "Currently unavailable")} · {visionModelKey.replace("\u0000", "/")}</option>
              : null}
            {visionModels.map((model) => <option key={`${model.provider}\u0000${model.modelId}`} value={`${model.provider}\u0000${model.modelId}`}>{model.name} · {model.provider}</option>)}
          </select>
          <p className={styles.modelFlow}>{copy(`视觉模型看屏幕${visionModel ? `（${visionModel.name}）` : ""}，当前对话模型负责操作。`, `The vision model reads the screen${visionModel ? ` (${visionModel.name})` : ""}; the current chat model takes action.`)}</p>
          <label className={styles.compactCheck}><input type="checkbox" checked={shareScreenshot} onChange={(event) => setShareScreenshot(event.target.checked)} />{copy("也让对话模型查看原图", "Let the chat model see the raw image too")}</label>
        </> : null}
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingsLinks}>
          <button type="button" onClick={() => openTools("diagnostics")}>{copy("连接诊断", "Diagnostics")}</button>
          <button type="button" onClick={() => openTools("inputs")}>{copy("按键与触摸校准", "Input calibration")}</button>
        </div>
        <p className={styles.inlineHint}>{copy("锁屏时请在手机上手动解锁。投屏不会自动唤醒或解锁。", "Unlock on the phone when needed. Mirroring never wakes or unlocks it.")}</p>
      </div>
      <div className={styles.settingsFooter}>
        <button type="button" onClick={() => setSettingsOpen(false)}>{copy("取消", "Cancel")}</button>
        <button className={styles.primaryButton} type="button" disabled={busy || (visionEnabled && !visionModelKey) || (videoProvider === "hos-scrcpy" && !hosPackageDirectory.trim())} onClick={saveSettings}>{copy("保存", "Save")}</button>
      </div>
    </section> : null}

    <main ref={workspaceRef} className={styles.workspace} data-tool-layout={toolTab === "logs" ? logLayout : undefined} data-tools-open={toolsOpen} style={{ "--tools-size": `${logRatio}%` } as CSSProperties}>
      <div className={styles.screenPane}>
        {controlStatus ? <div className={styles.activityBar} role="status">
          <span>{controlStatus === "stopping" ? copy("正在停止设备操作，请稍候…", "Stopping device operations…") : copy("设备清理尚未确认，暂不能操作或开始录屏", "Device cleanup is unconfirmed. Input and new recordings are paused.")}</span>
          {controlStatus === "recovering" ? <button type="button" onClick={() => openTools("diagnostics")}>{copy("检查并恢复", "Check and recover")}</button> : null}
        </div> : null}
    <div className={styles.deviceArea}>
      <div className={styles.zoomControls}>
        <select aria-label={copy("画面缩放", "Screen zoom")} value={frameZoom} onChange={(event) => setFrameZoom(event.target.value as FrameZoom)}>
          <option value="fit">{copy("适应窗口", "Fit")}</option><option value="100">100%</option><option value="150">150%</option><option value="200">200%</option>
        </select>
      </div>
      <div
        ref={frameViewportRef}
        className={styles.frameViewport}
        data-pannable={frameZoom !== "fit" ? "true" : "false"}
        onPointerDown={(event) => {
          if (frameZoom === "fit") return;
          if (event.target === frameRef.current && !event.altKey && event.button !== 1) return;
          if (event.button !== 0 && event.button !== 1) return;
          if ((event.target as HTMLElement).closest("button, select")) return;
          const viewport = frameViewportRef.current;
          if (!viewport) return;
          framePanRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={panFrame}
        onPointerUp={(event) => { if (framePanRef.current?.pointerId === event.pointerId) framePanRef.current = null; }}
        onPointerCancel={() => { framePanRef.current = null; }}
      >
      <div className={styles.frame} data-zoom={frameZoom}>
        {selectedOnline ? <div className={styles.frameStatus} data-status={frameStatus} data-video-error={frameFallbackReason ?? undefined} aria-live="polite">
          <span />{frameVideoBlocked ? copy("投屏通道占用 · 等待释放", "Video channel busy · waiting for release") : frameStatus === "error"
            ? frameMode === "frames" ? copy("兼容投屏重试中", "Retrying compatible view") : copy("视频流重连中", "Reconnecting stream")
            : frameStatus === "loading"
              ? frameMode === "frames" ? copy("切换兼容投屏", "Switching to compatible view") : copy("视频流连接中", "Connecting stream")
            : liveFrame?.initialPreview ? copy("实时视频准备中 · 当前预览", "Preparing live video · current preview") : frameMode === "frames" ? copy("兼容投屏 · 自动刷新", "Compatible view · auto refresh") : copy("实时视频流", "Live video")}
          {frameSize ? ` · ${frameSize.width}×${frameSize.height}` : ""}
        </div> : null}
        {selectedOnline && frameMode === "frames" && (frameStatus === "live" || frameVideoBlocked) ? <div className={styles.frameVideoActions}>
          {!liveFrame?.initialPreview?<button className={styles.frameVideoSetup} type="button" disabled={busy}
            onClick={connectLiveVideo}>{frameVideoBlocked ? copy("重试实时视频", "Retry live video") : copy("接入实时视频", "Connect live video")}</button>:null}
          {frameVideoBlocked && frameVideoRecovery ? <button className={styles.frameVideoSetup} type="button" disabled={busy||!canControl}
            onClick={releaseVideoConflict}>{copy('释放占用并重连','Release video and reconnect')}</button>:null}
          {frameFallbackReason ? <small data-video-fallback-reason title={frameFallbackReason}>{frameFallbackReason}</small> : null}
        </div> : null}
        {selectedOnline ? <canvas
          ref={frameRef}
          style={frameCanvasStyle}
          data-interactive={frameInputEnabled ? "true" : "false"}
          title={copy("点击操作手机，拖动滑动；按住 Alt 拖动可平移放大的画面", "Click to control the phone, drag to swipe; Alt-drag to pan a zoomed view")}
          onPointerDown={(event) => {
            if (event.button !== 0 || event.altKey) return;
            event.stopPropagation();
            if (!event.isPrimary || !frameInputEnabled || busyRef.current || !liveFrame || frameGestureRef.current) return;
            const gesture = beginFrameGesture(liveFrame, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY, event.pointerId, performance.now());
            if (!gesture) return;
            event.preventDefault();
            frameGestureRef.current = gesture;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const gesture = frameGestureRef.current;
            if (gesture?.pointerId !== event.pointerId) return;
            event.stopPropagation();
            moveFrameGesture(gesture, event.clientX, event.clientY);
          }}
          onPointerUp={(event) => {
            const gesture = frameGestureRef.current;
            if (gesture?.pointerId !== event.pointerId) return;
            event.stopPropagation();
            frameGestureRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            if (!frameInputEnabled || busyRef.current) return;
            const input = finishFrameGesture(gesture, liveFrame, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY, performance.now());
            if (input) void action(input);
          }}
          onPointerCancel={(event) => { if (frameGestureRef.current?.pointerId === event.pointerId) frameGestureRef.current = null; }}
          onLostPointerCapture={(event) => { if (frameGestureRef.current?.pointerId === event.pointerId) frameGestureRef.current = null; }}
          role="img"
          aria-label={copy("手机投屏，可点击和拖动操作", "Device screen, click and drag to control")}
        /> : <div className={styles.frameEmpty}>
          <AliIcon name="mobile" size={28} />
          <strong>{selected?.connectionIssue === "hdc-channel-not-ready" ? copy("调试通信未就绪", "Debugging communication is not ready") : selected?.state === "offline" ? copy("设备已离线", "Device is offline") : selected?.state === "unauthorized" ? copy("等待手机授权", "Waiting for device authorization") : selected ? copy("连接状态未确认", "Connection is unconfirmed") : copy("连接一台设备", "Connect a device")}</strong>
          <span>{selected?.state === "offline" ? selected.transport === "usb" ? copy("重新连接 USB 并确认手机调试授权，恢复后自动显示画面。", "Reconnect USB and confirm device debugging authorization. The view resumes automatically.") : copy("检查设备网络与 HDC 连接，恢复后自动显示画面。", "Check the device network and HDC connection. The view resumes automatically.")
            : selected?.state === "unauthorized" ? copy("请在手机上确认调试授权；投屏不会自动解锁设备。", "Confirm debugging authorization on the phone. Mirroring never unlocks the device.") : selected?.connectionIssue === "hdc-channel-not-ready" ? selected.transport === "usb" ? copy("检测到 USB，但手机调试通信尚未建立。请重新插拔 USB，解锁手机并确认调试授权，再刷新设备。", "USB was detected, but debugging communication is not established. Reconnect USB, unlock the phone and confirm authorization, then refresh devices.") : copy("检测到设备，但调试通信尚未建立。请检查设备网络与 HDC 连接，再刷新设备。", "The device was detected, but debugging communication is not established. Check the network and HDC connection, then refresh devices.") : selected ? copy("刷新设备检查连接状态，确认后再查看画面。", "Refresh devices to confirm the connection before viewing.") : copy("实时视频会显示在这里", "The live video stream will appear here")}</span>
          {!runtimeReady ? <button type="button" onClick={() => setSettingsOpen(true)}>{copy("打开设置", "Open settings")}</button> : null}
        </div>}
        {frameError ? <div className={styles.frameError} role="status">{frameError}</div> : null}
      </div>
      </div>
    </div>


      </div>
      {toolsOpen && toolTab === "logs" && logLayout !== "focus" ? <div className={styles.logDivider} role="separator" tabIndex={0} aria-label={copy("调整设备与日志比例", "Resize phone and logs")} aria-orientation={logLayout === "side" ? "vertical" : "horizontal"} aria-valuemin={32} aria-valuemax={85} aria-valuenow={logRatio}
        onPointerDown={event => { if (event.button !== 0) return; resizingLog.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
        onPointerMove={event => { if (resizingLog.current !== event.pointerId) return; const bounds = workspaceRef.current?.getBoundingClientRect(); if (!bounds) return; const ratio = logLayout === "side" ? 100 * (bounds.right - event.clientX) / bounds.width : 100 * (bounds.bottom - event.clientY) / bounds.height; setLogRatio(Math.round(Math.max(32, Math.min(85, ratio)))); }}
        onPointerUp={() => { resizingLog.current = undefined; }} onPointerCancel={() => { resizingLog.current = undefined; }}
        onKeyDown={event => { const delta = ["ArrowLeft", "ArrowUp"].includes(event.key) ? 3 : ["ArrowRight", "ArrowDown"].includes(event.key) ? -3 : 0; if (delta) { event.preventDefault(); setLogRatio(value => Math.max(32, Math.min(85, value + delta))); } }} /> : null}
      <section id={drawerId} className={styles.toolDrawer} data-tab={toolTab} hidden={!toolsOpen} aria-label={copy("设备工具", "Device tools")} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeTools(); } }}>
        <div className={styles.drawerHeading}><strong>{toolTab === "logs" ? copy("实时日志", "Live logs") : copy("工具", "Tools")}{pluginVersion ? <small className={styles.pluginVersion}> · {pluginVersion}</small> : null}</strong><div className={styles.drawerHeadingActions}>
          {toolTab === "logs" ? <><select aria-label={copy("日志布局", "Log layout")} value={logLayout} onChange={event => setLogLayout(event.target.value as typeof logLayout)}><option value="side">{copy("左右布局", "Side by side")}</option><option value="bottom">{copy("上下布局", "Stacked")}</option><option value="focus">{copy("专注日志", "Logs only")}</option></select><button type="button" onClick={() => { setLogLayout(logLayout === "focus" ? "side" : "focus"); }} aria-label={logLayout === "focus" ? copy("显示设备画面", "Show phone") : copy("收起设备画面", "Hide phone")}>{logLayout === "focus" ? copy("显示设备", "Show phone") : copy("专注日志", "Focus logs")}</button></> : null}
          {onMaximizedChange ? <button type="button" onClick={() => onMaximizedChange(!maximized)} aria-label={maximized ? copy("返回双栏", "Return to split view") : copy("展开设备工作台", "Expand device workbench")} title={maximized ? copy("返回双栏", "Return to split view") : copy("展开设备工作台", "Expand device workbench")}><AliIcon name={maximized ? "fullscreen-exit" : "fullscreen"} size={14} />{maximized ? copy("还原", "Restore") : copy("展开", "Expand")}</button> : null}
          <button className={styles.iconButton} type="button" onClick={closeTools} aria-label={copy("关闭工具", "Close tools")}><AliIcon name="close" size={15} /></button>
        </div></div>
        <div className={styles.drawerTabs} role="tablist" aria-label={copy("设备工具分类", "Device tool categories")}>
          {(["logs", "history", "apps"] as const).map((tab, index) => <button id={`${drawerId}-${tab}`} aria-controls={`${drawerId}-content`} key={tab} role="tab" type="button" tabIndex={toolTab === tab ? 0 : -1} aria-selected={toolTab === tab} onClick={() => changeToolTab(tab)} onKeyDown={event => {
            const tabs = ["logs", "history", "apps"] as const;
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : -1;
            if (next >= 0) { event.preventDefault(); changeToolTab(tabs[next]); document.getElementById(`${drawerId}-${tabs[next]}`)?.focus(); }
          }}>{(chinese ? ["日志", "截图与录屏", "应用"] : ["Logs", "Captures", "Apps"])[index]}</button>)}
          <select aria-label={copy("更多设备工具", "More device tools")} value={["logs", "history", "apps"].includes(toolTab) ? "" : toolTab} onChange={event => { if (event.target.value) changeToolTab(event.target.value as typeof toolTab); }}>
            <option value="">{copy("更多工具", "More tools")}</option>
            {([['files','文件'],['databases','数据库'],['commands','命令'],['scenarios','测试'],['voice','语音'],['tasks','后台任务'],['diagnostics','连接诊断'],['inputs','输入校准']] as const).map(([id,label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
        <div ref={drawerBodyRef} className={styles.drawerBody} id={`${drawerId}-content`} role="tabpanel" aria-label={copy("工具内容", "Tool content")} onScroll={event => { drawerScrollPositions.current[`${selectedSerial}:${toolTab}`] = event.currentTarget.scrollTop; }}>
          {["diagnostics", "inputs"].includes(toolTab) ? <div className={styles.toolTitle}><strong>{toolTab === "diagnostics" ? copy("连接诊断", "Diagnostics") : copy("按键与触摸校准", "Input calibration")}</strong><button type="button" onClick={() => changeToolTab("scenarios")}>{copy("返回测试", "Back to tests")}</button></div> : null}
          {toolTab === "history" ? <div className={styles.mediaWorkspace}>
          <MediaHistory serial={selectedSerial} refreshKey={mediaNotice?.artifact?.filename} chinese={chinese} />

          </div> : null}
          {toolsVisited ? <WorkbenchTools key={selectedSerial} tab={toolTab} serial={selectedSerial} active={active} chinese={chinese} canControl={canControl} ensureControl={ensureControl} onControlHandoff={clearControl} geometryId={liveFrame?.geometryId} cwd={cwd} ownerId={ownerId} initialDatabaseId={databaseSelection} onOpenDatabase={id => { setDatabaseSelection(id); changeToolTab("databases"); }} onOpenFiles={() => changeToolTab("files")} onShowTasks={() => changeToolTab("tasks")} onOpenLocalTerminal={onOpenLocalTerminal} onCleanupConfirmed={async () => { setError(null); await refresh(); }} /> : null}
          {toolTab === "logs" ? <HarmonyLogViewer active={active && toolsOpen} serial={selectedSerial} online={Boolean(selectedOnline)} copy={copy} /> : null}
          {toolTab === "diagnostics" ? <div className={styles.moreBody}>
            <button type="button" disabled={!selectedOnline || busy} onClick={requestFrame}>{copy("重连视频流", "Reconnect video")}</button>
            <button type="button" disabled={!selectedOnline || busy || !selected?.capabilities.uiTree} onClick={() => void run(() => jsonRequest<{ snapshot: unknown }>(`/api/harmony/tree?serial=${encodeURIComponent(selectedSerial)}`), payload => setTree(payload.snapshot))}>{copy("读取界面结构", "Read interface structure")}</button>
            <details className={styles.diagnostics}><summary>{copy("开发者信息", "Developer details")}</summary><pre>{JSON.stringify({ selected, holder, snapshot, diagnostics, tree }, null, 2)}</pre></details>
            <button className={styles.stopButton} type="button" disabled={busy} onClick={() => { clearControl(); void run(() => jsonRequest("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "emergency_stop", reason: "desktop-global-stop" }) })); }}>{copy("停止所有设备操作", "Stop all devices")}</button>
          </div> : null}
        </div>
      </section>
    </main>
        {mediaNotice ? <div className={styles.captureNotice} role="status">
          <span>{mediaNotice.message}</span>
          {mediaNotice.artifact ? <button type="button" onClick={() => openTools("history")}>{copy("查看截图与录屏", "View captures")}</button> : null}
          {mediaNotice.copyStatus === "failed" ? <button type="button" disabled={busy} onClick={() => void run(() => copyMediaArtifact(mediaNotice.artifact!))}>{copy("重新复制", "Retry copy")}</button> : null}
          <button type="button" aria-label={copy("关闭投屏提示", "Dismiss mirror notice")} onClick={() => setMediaNotice(null)}>×</button>
        </div> : null}
        <div className={styles.actionBar}>
          <button type="button" title={`${copy("截图", "Screenshot")}${screenshotShortcutLabel ? ` · ${screenshotShortcutLabel}` : ""}`} disabled={!canScreenshot || screenshotBusy} onClick={() => mediaAction("capture_screenshot")}><AliIcon name="save" size={15} />{screenshotBusy ? copy("截图中…", "Capturing…") : copy("截图", "Screenshot")}</button>
          {recording ? <button className={styles.recordingButton} type="button" disabled={busy || !ownsRecording} onClick={() => mediaAction("stop_recording")}><AliIcon name="stop" size={15} />{ownsRecording ? copy(`停止录屏 · ${formatRecordingElapsed(recordingElapsed)}`, `Stop recording · ${formatRecordingElapsed(recordingElapsed)}`) : copy("AI 正在录屏", "AI recording")}</button>
            : <button type="button" aria-label={copy("开始录屏", "Start recording")} disabled={!canControl || busy} onClick={() => mediaAction("start_recording")}><AliIcon name="play" size={15} />{copy("录屏", "Record")}</button>}
          {lease || holder || busy ? <button className={styles.stopButton} type="button" disabled={!selectedOnline} onClick={stopDevice} aria-label={copy("停止当前设备操作", "Stop this device")} title={copy("停止当前设备操作", "Stop this device")}><AliIcon name="stop" size={15} /></button> : null}
        </div>
    <footer className={styles.statusBar}>
      <span title={copy("锁屏时请手动解锁，投屏不会自动唤醒或解锁。", "Unlock manually. Mirroring never wakes or unlocks your phone.")}>{controlStatus ? controlStatus === "stopping" ? copy("正在停止", "Stopping") : copy("等待恢复", "Recovery required") : selected?.connectionIssue === "hdc-channel-not-ready" ? copy("等待调试通信", "Waiting for debugging communication") : blocked && !agentHasControl ? copy("其他窗口正在操作", "Another window is operating") : selectedOnline && frameStatus === "live" && frameMatchesDevice ? frameInputEnabled ? copy("可点击拖动 · 已连接", "Click and drag connected") : copy("画面已连接 · 等待坐标校验", "View connected, checking input geometry") : selectedOnline ? copy("等待实时画面", "Waiting for live view") : sessionRunning ? copy("等待设备连接", "Waiting for a device") : copy("请连接设备", "Connect a device")}</span>
      <div className={styles.footerActions}>
      {lease || holder || busy ? <button className={styles.stopButton} type="button" onClick={stopDevice} aria-label={copy("停止设备任务", "Stop device task")} title={copy("停止设备任务", "Stop device task")}><AliIcon name="stop" size={13} /></button> : null}
      <button ref={toolsButtonRef} type="button" aria-expanded={toolsOpen} aria-controls={drawerId} onClick={() => toolsOpen ? closeTools() : openTools()}>{copy("工具", "Tools")}<AliIcon name={toolsOpen ? "arrowdown" : "arrowup"} size={13} /></button>
      </div>
    </footer>
    {visibleError ? <div className={styles.error} role="alert"><span>{visibleError}</span><button className={styles.iconButton} type="button" onClick={() => { setError(null); setDeviceError(null); }} aria-label={copy("关闭提示", "Dismiss message")}><AliIcon name="close" size={12} /></button></div> : null}
  </div>;
}

type HarmonyPanelBoundaryProps = { active: boolean; resetKey?: string; children: ReactNode };
type HarmonyPanelBoundaryState = { error: Error | null };

class HarmonyPanelErrorBoundary extends Component<HarmonyPanelBoundaryProps, HarmonyPanelBoundaryState> {
  state: HarmonyPanelBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): HarmonyPanelBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Harmony panel render failed", error, info.componentStack);
  }

  componentDidUpdate(previous: HarmonyPanelBoundaryProps): void {
    if (!this.state.error) return;
    // Reset when the tab closes, or when a fresh poll delivered new data.
    if ((previous.active && !this.props.active) || previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const chinese = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
    return <div className={styles.gate} role="alert">
      <AliIcon name="warning" size={34} />
      <h2>{chinese ? "鸿蒙设备面板暂不可用" : "Harmony panel is temporarily unavailable"}</h2>
      <p>{chinese ? "设备面板已被隔离，当前会话不会中断。" : "The device panel was isolated; your active session is still running."}</p>
      <button type="button" onClick={() => this.setState({ error: null })}>{chinese ? "重试面板" : "Retry panel"}</button>
    </div>;
  }
}

export function SafeHarmonyPanel({ active, ...props }: Omit<HarmonyPanelProps, "onSnapshot">) {
  const [snapshot, setSnapshot] = useState(0);
  const handleSnapshot = useCallback((fingerprint: number) => {
    setSnapshot((current) => (current === fingerprint ? current : fingerprint));
  }, []);
  return <HarmonyPanelErrorBoundary active={active} resetKey={String(snapshot)}>
    <HarmonyPanel {...props} active={active} onSnapshot={handleSnapshot} />
  </HarmonyPanelErrorBoundary>;
}
