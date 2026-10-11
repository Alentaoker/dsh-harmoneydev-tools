// vendor/lib/harmony/runtime/worker-client.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// vendor/lib/harmony/runtime/asset-path.ts
import { join } from "node:path";
function harmonyRuntimeAsset(...parts) {
  const root = process.env.PIORA_WEB_RUNTIME_ROOT?.trim() || process.cwd();
  return join(root.endsWith(".asar") ? `${root}.unpacked` : root, ...parts);
}

// vendor/lib/harmony/errors.ts
var harmonyErrorBrand = Symbol.for("piora.harmony.error");
var HarmonyError = class extends Error {
  code;
  details;
  retryable;
  constructor(code, message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = "HarmonyError";
    Object.defineProperty(this, harmonyErrorBrand, { value: true });
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...this.details ? { details: this.details } : {}
    };
  }
};
function isHarmonyError(value) {
  return value instanceof HarmonyError || Boolean(value && typeof value === "object" && value[harmonyErrorBrand] === true && typeof value.toJSON === "function");
}
function asHarmonyError(value) {
  if (isHarmonyError(value)) return value;
  return new HarmonyError("INTERNAL_ERROR", "Harmony device operation failed unexpectedly", {
    cause: value
  });
}

// vendor/lib/harmony/selector.ts
var MAX_SELECTOR_DEPTH = 3;
var MAX_SELECTOR_TEXT = 500;
function normalized(value) {
  const result = value?.replace(/\s+/g, " ").trim();
  return result || void 0;
}
function validateString(value, name) {
  if (value === void 0) return;
  if (typeof value !== "string" || !normalized(value) || value.length > MAX_SELECTOR_TEXT || value.includes("\0")) {
    throw new HarmonyError("INVALID_ARGUMENT", `${name} must be a non-empty string of at most ${MAX_SELECTOR_TEXT} characters`);
  }
}
function validateHarmonySelector(selector, depth = 0) {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw new HarmonyError("INVALID_ARGUMENT", "A valid Harmony UI selector is required");
  }
  if (depth > MAX_SELECTOR_DEPTH) {
    throw new HarmonyError("INVALID_ARGUMENT", `Harmony UI selectors support at most ${MAX_SELECTOR_DEPTH} relationship levels`);
  }
  for (const key of ["id", "text", "type", "hint", "description", "inWindow"]) {
    validateString(selector[key], `selector.${key}`);
  }
  if (selector.match !== void 0 && !["exact", "contains", "starts_with", "ends_with"].includes(selector.match)) {
    throw new HarmonyError("INVALID_ARGUMENT", "selector.match is invalid");
  }
  for (const key of ["clickable", "scrollable", "enabled", "focused", "selected", "checked", "visible"]) {
    if (selector[key] !== void 0 && typeof selector[key] !== "boolean") {
      throw new HarmonyError("INVALID_ARGUMENT", `selector.${key} must be a boolean`);
    }
  }
  if (!selector.id && !selector.text && !selector.type && !selector.hint && !selector.description && !selector.inWindow && selector.clickable === void 0 && selector.scrollable === void 0 && selector.focused === void 0 && selector.selected === void 0 && selector.checked === void 0 && selector.enabled === void 0 && selector.visible === void 0) {
    throw new HarmonyError("INVALID_ARGUMENT", "A selector requires an id, text, type, hint, description, or semantic state");
  }
  if (selector.index !== void 0 && (!Number.isSafeInteger(selector.index) || selector.index < 0 || selector.index > 1e4)) {
    throw new HarmonyError("INVALID_ARGUMENT", "selector.index must be an integer between 0 and 10000");
  }
  for (const relation of [selector.within, selector.before, selector.after]) {
    if (relation !== void 0) validateHarmonySelector(relation, depth + 1);
  }
}

// vendor/lib/harmony/runtime/worker-protocol.ts
var WORKER_PROTOCOL_VERSION = 1;

// vendor/lib/harmony/runtime/worker-client.ts
import { existsSync } from "node:fs";
import { delimiter, dirname, join as join2 } from "node:path";
function workerEnvironment(hdcPath, source = process.env) {
  const env = { ...source, PIORA_HARMONY_WORKER_HDC: hdcPath, ELECTRON_RUN_AS_NODE: "1" };
  const key = Object.keys(env).find((key2) => key2.toLowerCase() === "path") ?? "PATH";
  env[key] = [dirname(hdcPath), source[key] ?? ""].join(delimiter);
  const runtime = source.PIORA_WEB_RUNTIME_ROOT?.trim();
  if (runtime?.endsWith(".asar")) env.NODE_PATH = [join2(`${runtime}.unpacked`, "node_modules"), join2(runtime, "node_modules"), source.NODE_PATH ?? ""].filter(Boolean).join(delimiter);
  return env;
}
var HypiumWorkerClient = class {
  constructor(hdcPath, entry = harmonyRuntimeAsset(".harmony-worker", "harmony", "runtime", "worker-entry.js"), timeoutMs = 45e3) {
    this.hdcPath = hdcPath;
    this.entry = entry;
    this.timeoutMs = timeoutMs;
  }
  workers = /* @__PURE__ */ new Map();
  sequence = 0;
  worker(serial) {
    const existing = this.workers.get(serial);
    if (existing) return existing;
    if (!existsSync(this.entry)) throw new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", "Harmony driver worker is not built", { details: { dispatchState: "not-sent" } });
    const epoch = randomUUID();
    const child = spawn(process.execPath, [this.entry], { env: { ...workerEnvironment(this.hdcPath), PIORA_HARMONY_WORKER_EPOCH: epoch, PIORA_HARMONY_WORKER_SERIAL: serial }, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
    const worker = { child, pending: /* @__PURE__ */ new Map(), epoch };
    this.workers.set(serial, worker);
    child.on("message", (message) => {
      if (message?.protocol !== WORKER_PROTOCOL_VERSION || message.epoch !== worker.epoch) return;
      const pending = worker.pending.get(message.id);
      if (!pending) return;
      worker.pending.delete(message.id);
      worker.status = message.status?.serial === serial ? message.status : void 0;
      if (message.error) pending.reject(new HarmonyError(message.error.code, message.error.message, message.error));
      else pending.resolve(message.value);
    });
    const lost = () => {
      if (this.workers.get(serial) === worker) this.workers.delete(serial);
      for (const pending of worker.pending.values()) pending.reject(new HarmonyError("AUTOMATION_DRIVER_FAILED", "Device worker exited; do not replay a potentially dispatched action", { details: { dispatchState: "unknown", effect: "unknown" } }));
      worker.pending.clear();
    };
    child.once("error", lost);
    child.once("exit", lost);
    return worker;
  }
  async call(serial, method, args, signal, allowConnect = true) {
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Worker request cancelled", { details: { dispatchState: "not-sent" } });
    const worker = this.worker(serial);
    const id = ++this.sequence;
    return await new Promise((resolve6, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        worker.pending.delete(id);
      };
      const fail = (code, message) => {
        cleanup();
        worker.child.kill();
        reject(new HarmonyError(code, message, { details: { dispatchState: "unknown", effect: "unknown" } }));
      };
      const abort = () => fail("COMMAND_ABORTED", "Worker request cancelled; physical effect is uncertain");
      const timer = setTimeout(() => fail("COMMAND_TIMEOUT", "Device worker timed out; inspect device state before retrying"), this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      worker.pending.set(id, { resolve(value) {
        cleanup();
        resolve6(value);
      }, reject(error) {
        cleanup();
        reject(error);
      } });
      worker.child.send({ protocol: WORKER_PROTOCOL_VERSION, epoch: worker.epoch, deadline: Date.now() + this.timeoutMs, id, method, serial, args, allowConnect }, (error) => {
        if (error) fail("AUTOMATION_DRIVER_FAILED", "Device worker IPC failed");
      });
    });
  }
  async execute(serial, operation, args, signal, allowConnect = true) {
    try {
      return await this.call(serial, "execute", [operation, args], signal, allowConnect);
    } catch (error) {
      if (error instanceof HarmonyError && error.code === "AUTOMATION_DRIVER_UNAVAILABLE") return { used: false };
      throw error;
    }
  }
  async semanticAction(serial, request, signal, allowConnect = true) {
    return await this.call(serial, "semantic", [request], signal, allowConnect);
  }
  async waitForIdle(serial, idleMs, timeoutMs, signal, allowConnect = true) {
    try {
      return await this.call(serial, "idle", [idleMs, timeoutMs], signal, allowConnect);
    } catch (error) {
      if (error instanceof HarmonyError && error.code === "AUTOMATION_DRIVER_UNAVAILABLE") return false;
      throw error;
    }
  }
  status() {
    return [...this.workers].map(([serial, worker]) => worker.status ?? { serial, state: "connecting" });
  }
  async invalidate(serial) {
    const worker = this.workers.get(serial);
    if (!worker) return;
    await new Promise((resolve6, reject) => {
      const timer = setTimeout(() => reject(new HarmonyError("DEVICE_BUSY", "Worker termination is uncertain")), 1500);
      worker.child.once("exit", () => {
        clearTimeout(timer);
        resolve6();
      });
      worker.child.kill();
    });
  }
  async reset(serial) {
    await Promise.all((serial ? [serial] : [...this.workers.keys()]).map((value) => this.invalidate(value)));
  }
};

// vendor/lib/harmony/runtime/device-lock.ts
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { existsSync as existsSync2, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join3 } from "node:path";
var sharedDeviceLockDirectory = () => join3(homedir(), ".piora-device-control", "locks");
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function acquireDeviceLock(serial, directory = sharedDeviceLockDirectory()) {
  mkdirSync(directory, { recursive: true, mode: 448 });
  if (lstatSync(directory).isSymbolicLink()) throw new HarmonyError("DEVICE_BUSY", "Device lock directory cannot be a symlink");
  const path = join3(directory, createHash("sha256").update(serial).digest("hex"));
  const gate = `${path}.gate`;
  const withGate = (work) => {
    try {
      mkdirSync(gate, { mode: 448 });
    } catch {
      throw new HarmonyError("DEVICE_BUSY", "Device ownership is changing or needs explicit recovery");
    }
    try {
      return work();
    } finally {
      rmdirSync(gate);
    }
  };
  const owner = { pid: process.pid, nonce: randomUUID2(), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  return withGate(() => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(path, { mode: 448 });
        writeFileSync(join3(path, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 384, flush: true });
        let released = false;
        return { owner, release() {
          if (released) return;
          withGate(() => {
            const current = JSON.parse(readFileSync(join3(path, "owner.json"), "utf8"));
            if (current.nonce !== owner.nonce) throw new HarmonyError("DEVICE_BUSY", "Device ownership changed; refusing foreign cleanup");
            released = true;
            rmSync(path, { recursive: true });
          });
        } };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let previous;
        try {
          previous = JSON.parse(readFileSync(join3(path, "owner.json"), "utf8"));
        } catch {
          throw new HarmonyError("DEVICE_BUSY", "Device ownership is being established or needs explicit recovery");
        }
        if (!Number.isInteger(previous.pid) || previous.pid < 1 || alive(previous.pid)) {
          throw new HarmonyError("DEVICE_BUSY", "Another application instance owns this physical device", { details: { ownerPid: previous.pid } });
        }
        if (lstatSync(path).isSymbolicLink()) throw new HarmonyError("DEVICE_BUSY", "Invalid device ownership path");
        const current = JSON.parse(readFileSync(join3(path, "owner.json"), "utf8"));
        if (current.nonce !== previous.nonce) continue;
        const retired = join3(directory, `retired-${randomUUID2()}`);
        try {
          renameSync(path, retired);
        } catch {
          continue;
        }
        if (existsSync2(retired)) rmSync(retired, { recursive: true });
      }
    }
    throw new HarmonyError("DEVICE_BUSY", "Device ownership changed during acquisition");
  });
}

// vendor/lib/harmony/deveco-native-video.ts
import { createRequire } from "node:module";
import { createHash as createHash2, randomUUID as randomUUID3 } from "node:crypto";
import { lstat, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { isAbsolute, join as join4, resolve, dirname as dirname2 } from "node:path";
import { createServer } from "node:net";
import JSZip from "jszip";

// vendor/lib/harmony/media/h264-sps.ts
function h264SpsDimensions(nal) {
  try {
    if ((nal[0] & 31) !== 7 || nal.length < 5 || nal.length > 4096) return;
    const rbsp = [];
    for (let i = 1; i < nal.length; i++) {
      if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
      rbsp.push(nal[i]);
    }
    let offset = 0;
    const bits = (count) => {
      if (count < 0 || count > 32 || offset + count > rbsp.length * 8) throw Error("SPS bit range");
      let value = 0;
      for (let i = 0; i < count; i++, offset++) value = value * 2 + (rbsp[offset >> 3] >> 7 - (offset & 7) & 1);
      return value;
    };
    const ue = () => {
      let leading = 0;
      while (!bits(1)) if (++leading > 24) throw Error("SPS Exp-Golomb range");
      return 2 ** leading - 1 + bits(leading);
    };
    const se = () => {
      const value = ue();
      return value % 2 ? (value + 1) / 2 : -value / 2;
    };
    const profile = bits(8);
    bits(8);
    bits(8);
    ue();
    let chroma = 1, separate = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue();
      if (chroma > 3) return;
      if (chroma === 3) separate = bits(1);
      ue();
      ue();
      bits(1);
      if (bits(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!bits(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next) next = (last + se() + 256) % 256;
          last = next || last;
        }
      }
    }
    ue();
    const order = ue();
    if (order === 0) ue();
    else if (order === 1) {
      bits(1);
      se();
      se();
      const cycle = ue();
      if (cycle > 256) return;
      for (let i = 0; i < cycle; i++) se();
    } else if (order > 2) return;
    ue();
    bits(1);
    const mbWidth = ue() + 1, mapHeight = ue() + 1, frameOnly = bits(1);
    if (!frameOnly) bits(1);
    bits(1);
    let left = 0, right = 0, top = 0, bottom = 0;
    if (bits(1)) {
      left = ue();
      right = ue();
      top = ue();
      bottom = ue();
    }
    const chromaArray = separate ? 0 : chroma;
    const cropX = chromaArray === 0 || chromaArray === 3 ? 1 : 2;
    const cropY = (chromaArray === 1 ? 2 : 1) * (2 - frameOnly);
    const width = mbWidth * 16 - (left + right) * cropX;
    const height = mapHeight * 16 * (2 - frameOnly) - (top + bottom) * cropY;
    if (width < 1 || height < 1 || width > 16384 || height > 16384) return;
    return { width, height };
  } catch {
    return;
  }
}

// vendor/lib/harmony/media/hos-packets.ts
function nalUnits(bytes) {
  const starts = [];
  for (let index = 0; index + 3 < bytes.length; index++) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      starts.push({ at: index, size: 3 });
      index += 2;
    } else if (index + 4 < bytes.length && bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 0 && bytes[index + 3] === 1) {
      starts.push({ at: index, size: 4 });
      index += 3;
    }
  }
  if (!starts.length) return [bytes];
  return starts.map((start, index) => bytes.subarray(start.at + start.size, starts[index + 1]?.at ?? bytes.length)).filter((unit) => unit.length > 0);
}
function packet(type, payload) {
  const result = Buffer.allocUnsafe(8 + payload.length);
  result.writeUInt32BE(type, 0);
  result.writeUInt32BE(payload.length, 4);
  payload.copy(result, 8);
  return result;
}
var HosVideoPacketizer = class {
  constructor(fps = 30, changeDriven = false) {
    this.fps = fps;
    this.changeDriven = changeDriven;
  }
  sps;
  pps;
  configured = false;
  width = 0;
  height = 0;
  timestamp = BigInt(0);
  setSize(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) return;
    if (this.width !== width || this.height !== height) this.configured = false;
    this.width = width;
    this.height = height;
  }
  push(bytes) {
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return [];
    const units2 = nalUnits(bytes);
    for (const unit of units2) {
      const type = unit[0] & 31;
      if (type === 7) {
        const size = h264SpsDimensions(unit);
        if (!size) continue;
        if (!this.sps?.equals(unit)) this.configured = false;
        this.sps = Buffer.from(unit);
        this.setSize(size.width, size.height);
      }
      if (type === 8) {
        if (!this.pps?.equals(unit)) this.configured = false;
        this.pps = Buffer.from(unit);
      }
    }
    const output = [];
    if (!this.configured && this.width && this.height && this.sps && this.pps && this.sps.length <= 4096 && this.pps.length <= 4096) {
      const config = Buffer.alloc(17 + this.sps.length + this.pps.length + (this.changeDriven ? 1 : 0));
      config.writeUInt8(0, 0);
      config.writeUInt32BE(this.width, 1);
      config.writeUInt32BE(this.height, 5);
      config.writeUInt32BE(this.fps, 9);
      config.writeUInt16BE(this.sps.length, 13);
      this.sps.copy(config, 15);
      config.writeUInt16BE(this.pps.length, 15 + this.sps.length);
      this.pps.copy(config, 17 + this.sps.length);
      if (this.changeDriven) config[config.length - 1] = 1;
      output.push(packet(2, config));
      this.configured = true;
    }
    const key = units2.some((unit) => (unit[0] & 31) === 5);
    const picture = key || units2.some((unit) => (unit[0] & 31) === 1);
    if (this.configured && picture) {
      const payload = Buffer.allocUnsafe(9 + bytes.length);
      payload.writeUInt8(key ? 1 : 0, 0);
      const now = BigInt(Date.now()) * BigInt(1e3);
      this.timestamp = now > this.timestamp ? now : this.timestamp + BigInt(1);
      payload.writeBigUInt64BE(this.timestamp, 1);
      bytes.copy(payload, 9);
      output.push(packet(3, payload));
    }
    return output;
  }
};

// vendor/lib/harmony/deveco-native-video.ts
var ENDPOINT = "localabstract:scrcpy_grpc_socket";
var active = /* @__PURE__ */ new Set();
var streaming = /* @__PURE__ */ new Set();
function nativeDevEcoVideoStreaming(serial) {
  return streaming.has(serial);
}
var nativeRuntimeLockDirectory = () => join4(dirname2(sharedDeviceLockDirectory()), "runtime-init");
function ownedNativeVideoPids(output, extension) {
  return output.split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => /^\d+$/.test(c[1] ?? "") && /(?:^|\/)uitest$/.test(c[7] ?? "") && c[8] === "start-daemon" && c.includes(extension)).map((c) => c[1]);
}
function ownedNativeVideoPid(output, extension) {
  return ownedNativeVideoPids(output, extension)[0];
}
async function loopbackPort() {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const p = server.address().port;
      server.close((e) => e ? reject(e) : accept(p));
    });
  });
}
async function localDevEcoVideoResource(options) {
  const root = process.env.DSH_DEVECO_TESTING_HOME || "E:\\devecotest";
  const jar = options.jarPath || join4(root, "Prograndata", "common", "resources", "screenCastingResource", "screenCastingResource.jar");
  if (!isAbsolute(jar)) throw new HarmonyError("INVALID_ARGUMENT", "DevEco Testing resource path must be absolute");
  const info = await lstat(jar).catch(() => void 0);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Local DevEco Testing video resource is unavailable");
  const outer = await JSZip.loadAsync(await readFile(jar));
  const sdkName = Object.keys(outer.files).find((n) => /^lib\/hosScrcpy-[^/]+\.jar$/.test(n));
  if (!sdkName) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Installed DevEco video SDK is missing");
  const sdkEntry = outer.file(sdkName);
  if (sdkEntry._data?.uncompressedSize > 128 * 1024 * 1024) throw new HarmonyError("INVALID_RESPONSE", "DevEco video SDK is too large");
  const sdk = await JSZip.loadAsync(await sdkEntry.async("nodebuffer"));
  const name = options.resourceName || "libscrcpy/libscrcpy_server_unix_6.6-20260418.z.so";
  const entry = sdk.file(name);
  if (!entry || entry._data?.uncompressedSize > 32 * 1024 * 1024) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Compatible DevEco native video extension is missing");
  const bytes = await entry.async("nodebuffer");
  if (bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) throw new HarmonyError("INVALID_RESPONSE", "Invalid native video extension");
  const hash = createHash2("sha256").update(bytes).digest("hex");
  await mkdir(options.cacheDirectory, { recursive: true });
  const file = resolve(options.cacheDirectory, `deveco-video-${hash}.so`);
  const cached = await readFile(file).catch(() => void 0);
  if (!cached || createHash2("sha256").update(cached).digest("hex") !== hash) await writeFile(file, bytes);
  return { file, hash, resourceName: name };
}
async function openNativeDevEcoVideo(options) {
  const { serial, signal, command } = options;
  if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid device serial");
  if (active.has(serial)) throw new HarmonyError("DEVICE_BUSY", "A native video session is already active");
  active.add(serial);
  let pid, started = false, forward = false, call, client, request, closed = false, closing;
  let controller;
  let firstTimer, watchdog;
  let statsTimer;
  const stats = { startedAt: (/* @__PURE__ */ new Date()).toISOString(), encodedPictures: 0, videoBytes: 0, state: "starting" };
  const statsPath = join4(options.cacheDirectory, "native-video-status.json");
  const saveStats = () => writeFile(statsPath, JSON.stringify(stats, null, 2)).catch(() => {
  });
  const id = randomUUID3().replaceAll("-", ""), extension = `libdsh_video_${id}.so`, remote = `/data/local/tmp/${extension}`, log = `/data/local/tmp/dsh-video-${id}.log`;
  let localPort = 0;
  let ownerLock, runtimeLock;
  const ownershipDirectory = options.ownershipDirectory || join4(dirname2(sharedDeviceLockDirectory()), "native-video");
  const ownerPath = join4(ownershipDirectory, `${createHash2("sha256").update(serial).digest("hex")}.video.json`);
  const alive2 = options.processAlive || ((p) => {
    try {
      process.kill(p, 0);
      return true;
    } catch (e) {
      return e.code !== "ESRCH";
    }
  });
  let wroteOwner = false;
  const saveOwner = async () => {
    if (ownerLock) {
      const temp = `${ownerPath}.${ownerLock.owner.nonce}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ hostPid: process.pid, nonce: ownerLock.owner.nonce, extension, localPort, sessionId: id, startedAt: stats.startedAt }), { mode: 384 });
        await rename(temp, ownerPath);
        wroteOwner = true;
      } finally {
        await rm(temp, { force: true }).catch(() => {
        });
      }
    }
  };
  let rejectStart;
  const cleanup = () => closing ??= (async () => {
    closed = true;
    clearTimeout(firstTimer);
    clearTimeout(watchdog);
    clearInterval(statsTimer);
    signal?.removeEventListener("abort", abort);
    if (call && client?.onEnd) await new Promise((done) => {
      const timer = setTimeout(done, 1200);
      try {
        client.onEnd(request, { deadline: Date.now() + 1e3 }, () => {
          clearTimeout(timer);
          done();
        });
      } catch {
        clearTimeout(timer);
        done();
      }
    });
    const failures = [];
    try {
      call?.cancel();
      client?.close();
    } catch {
      failures.push("transport");
    }
    if (forward) await command(["fport", "rm", `tcp:${localPort}`, ENDPOINT], "native_video_forward_cleanup").catch(() => failures.push("forward"));
    if (started) {
      try {
        const owned = ownedNativeVideoPids(await command(["shell", "ps -ef"], "native_video_cleanup_pid"), extension);
        stats.cleanupPids = owned;
        for (const ownedPid of owned) await command(["shell", `if grep -aq '${extension}' /proc/${ownedPid}/cmdline || grep -aq '${extension}' /proc/${ownedPid}/maps; then kill -9 ${ownedPid}; fi`], "native_video_daemon_cleanup");
        if (ownedNativeVideoPids(await command(["shell", "ps -ef"], "native_video_cleanup_verify"), extension).length) failures.push("daemon");
      } catch {
        failures.push("daemon");
      }
    }
    await command(["shell", `rm -f ${remote} ${log}`], "native_video_files_cleanup").catch(() => failures.push("files"));
    active.delete(serial);
    streaming.delete(serial);
    try {
      runtimeLock?.release();
    } catch {
      failures.push("runtime-lock");
    }
    runtimeLock = void 0;
    if (ownerLock) {
      if (wroteOwner && !failures.length) {
        try {
          const current = JSON.parse(await readFile(ownerPath, "utf8"));
          if (current.nonce === ownerLock.owner.nonce) await rm(ownerPath, { force: true });
          else failures.push("ownership");
        } catch {
          failures.push("ownership");
        }
      }
      try {
        ownerLock.release();
      } catch {
        failures.push("owner-lock");
      }
      ownerLock = void 0;
    }
    stats.state = "closed";
    stats.closedAt = (/* @__PURE__ */ new Date()).toISOString();
    stats.cleanup = failures.length ? "uncertain" : "complete";
    await saveStats();
    await writeFile(join4(options.cacheDirectory, `native-video-${id}.json`), JSON.stringify(stats, null, 2)).catch(() => {
    });
    if (failures.length) throw new HarmonyError("DEVICE_BUSY", "Native video cleanup is uncertain", { details: { cleanup: "uncertain", resources: failures, localPort } });
  })();
  const abort = () => {
    const e = new HarmonyError("COMMAND_ABORTED", "Video stream cancelled");
    rejectStart?.(e);
    try {
      controller?.error(e);
    } catch {
    }
    void cleanup().catch(() => {
    });
  };
  try {
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Video start cancelled");
    const resource = await localDevEcoVideoResource(options);
    ownerLock = acquireDeviceLock(serial, ownershipDirectory);
    runtimeLock = acquireDeviceLock(serial, nativeRuntimeLockDirectory());
    const oldText = await readFile(ownerPath, "utf8").catch((e) => {
      if (e.code === "ENOENT") return void 0;
      throw e;
    });
    let old;
    try {
      old = oldText === void 0 ? void 0 : JSON.parse(oldText);
    } catch {
      throw new HarmonyError("DEVICE_BUSY", "Invalid native-video ownership record; explicit recovery is required");
    }
    if (old) {
      if (!Number.isInteger(old.hostPid) || old.hostPid < 1 || !/^libdsh_video_[a-f0-9]{32}\.so$/.test(old.extension) || !Number.isInteger(old.localPort) || old.localPort < 0 || old.localPort > 65535) throw new HarmonyError("DEVICE_BUSY", "Invalid native-video ownership record; explicit recovery is required");
      if (alive2(old.hostPid) && old.hostPid !== process.pid) throw new HarmonyError("DEVICE_BUSY", "Another live application owns the video stream");
      const orphanPids = ownedNativeVideoPids(await command(["shell", "ps -ef"], "native_video_orphan_probe", signal), old.extension);
      for (const orphanPid of orphanPids) await command(["shell", `if grep -aq '${old.extension}' /proc/${orphanPid}/cmdline || grep -aq '${old.extension}' /proc/${orphanPid}/maps; then kill -9 ${orphanPid}; fi`], "native_video_orphan_cleanup", signal);
      if (ownedNativeVideoPids(await command(["shell", "ps -ef"], "native_video_orphan_verify", signal), old.extension).length) throw new HarmonyError("DEVICE_BUSY", "Previous native-video daemon could not be released");
      if (old.localPort) await command(["fport", "rm", `tcp:${old.localPort}`, ENDPOINT], "native_video_orphan_forward").catch(() => {
      });
      const oldId = old.extension.slice("libdsh_video_".length, -3);
      await command(["shell", `rm -f /data/local/tmp/${old.extension} /data/local/tmp/dsh-video-${oldId}.log`], "native_video_orphan_files", signal);
      stats.recoveredOrphans = orphanPids.length;
    }
    await saveOwner();
    stats.resourceName = resource.resourceName;
    stats.resourceSha256 = resource.hash;
    const existing = await command(["shell", "ps -ef"], "native_video_existing", signal);
    if (existing.split("\n").some((l) => /uitest/.test(l) && /libscreen_casting|libscrcpy|libdsh_video_/.test(l))) throw new HarmonyError("DEVICE_BUSY", "Stop the other live video projection before opening this stream");
    await options.prepareAutomation?.();
    localPort = await loopbackPort();
    await saveOwner();
    await command(["file", "send", resource.file, remote], "native_video_send", signal);
    started = true;
    await command(["shell", `uitest start-daemon singleness --extension-name ${extension} -p ${localPort} -scale 2 -frameRate 30 -bitRate 6291456 -screenId 0 -encodeType 0 -iFrameInterval 2000 -repeatInterval 33 >${log} 2>&1 &`], "native_video_start", signal);
    for (let retry = 0; retry < 10; retry++) {
      const ps = await command(["shell", "ps -ef"], "native_video_pid");
      pid = ownedNativeVideoPid(ps, extension);
      if (pid) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!pid) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Native video extension could not start");
    stats.pid = pid;
    stats.extension = extension;
    stats.localPort = localPort;
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Video start cancelled");
    await command(["fport", `tcp:${localPort}`, ENDPOINT], "native_video_forward", signal);
    forward = true;
    if (options.transport) ({ client, request } = options.transport(localPort));
    else {
      const require2 = createRequire(import.meta.url);
      const driverRequire = createRequire(require2.resolve("hypium-driver/package.json"));
      const grpc = driverRequire("@grpc/grpc-js");
      const { ScrcpyServiceClient } = driverRequire("./build/lib/generated/scrcpy/scrcpy_grpc_pb.js");
      const { Empty } = driverRequire("./build/lib/generated/scrcpy/scrcpy_pb.js");
      request = new Empty();
      client = new ScrcpyServiceClient(`127.0.0.1:${localPort}`, grpc.credentials.createInsecure(), { "grpc.max_receive_message_length": 8 * 1024 * 1024, "grpc.keepalive_time_ms": 1e4, "grpc.keepalive_timeout_ms": 3e3 });
    }
    signal?.addEventListener("abort", abort, { once: true });
    await new Promise((accept, reject) => client.waitForReady(Date.now() + 4e3, (e) => e ? reject(e) : accept()));
    if (closed || signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Video start cancelled");
    const packetizer = new HosVideoPacketizer(30, true);
    const videoStarted = Date.now();
    let ready = false;
    let acceptReady, rejectReady;
    const first2 = new Promise((a, r) => {
      acceptReady = a;
      rejectReady = r;
      rejectStart = r;
    });
    const fail = (error) => {
      if (closed) return;
      stats.error = error.message;
      rejectReady(error);
      try {
        controller?.error(error);
      } catch {
      }
      void cleanup().catch(() => {
      });
    };
    let paused = false;
    const armIdle = () => {
      clearTimeout(watchdog);
      if (!closed && !paused) watchdog = setTimeout(() => {
        void (async () => {
          try {
            const ps = await command(["shell", "ps -ef"], "native_video_health", signal);
            if (closed) return;
            if (!ownedNativeVideoPids(ps, extension).length) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Native video daemon exited");
            stats.healthCheckedAt = (/* @__PURE__ */ new Date()).toISOString();
            armIdle();
          } catch (e) {
            if (!closed) fail(e instanceof Error ? e : new Error("Native video health check failed"));
          }
        })();
      }, options.healthIntervalMs || 15e3);
    };
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
      pull() {
        if (!closed) {
          paused = false;
          call?.resume();
          if (ready) armIdle();
        }
      },
      cancel() {
        return cleanup();
      }
    }, { highWaterMark: 512 * 1024, size: (chunk) => chunk.byteLength });
    firstTimer = setTimeout(() => fail(new HarmonyError("CAPABILITY_UNAVAILABLE", "\u89C6\u9891\u8FDE\u63A5\u5DF2\u5EFA\u7ACB\u4F46\u5C1A\u672A\u8F93\u51FA\u753B\u9762\u3002\u8BF7\u5728\u624B\u673A\u8F7B\u6ED1\u4E00\u4E0B\uFF0C\u7136\u540E\u70B9\u51FB\u201C\u63A5\u5165\u5B9E\u65F6\u89C6\u9891\u201D\u91CD\u8BD5\u3002")), 1e4);
    call = client.onStart(request);
    call.on("data", (reply) => {
      if (closed) return;
      try {
        const bytes = Buffer.from(reply.getPayloadMap().get("data")?.getValBytes_asU8() || []);
        stats.videoBytes = Number(stats.videoBytes) + bytes.length;
        const packets = packetizer.push(bytes);
        for (const packet2 of packets) {
          const type = packet2.readUInt32BE();
          if (type === 3 && !ready && packet2[8] !== 1) continue;
          if (type === 3) {
            stats.encodedPictures = Number(stats.encodedPictures) + 1;
            stats.elapsedMs = Date.now() - videoStarted;
            stats.encodedPicturesPerSecond = Number(stats.encodedPictures) / (Math.max(1, Number(stats.elapsedMs)) / 1e3);
            if (!ready) {
              ready = true;
              stats.state = "streaming";
              stats.firstPictureMs = Date.now() - videoStarted;
              clearTimeout(firstTimer);
              acceptReady();
              void saveStats();
            }
          }
          controller.enqueue(packet2);
        }
        if ((controller.desiredSize ?? 0) <= 0) {
          paused = true;
          clearTimeout(watchdog);
          call.pause();
        }
      } catch (e) {
        fail(e instanceof Error ? e : new Error("Invalid native video data"));
      }
    });
    call.on("error", (e) => fail(e));
    call.on("end", () => fail(new HarmonyError("CAPABILITY_UNAVAILABLE", "Native video ended")));
    await first2;
    streaming.add(serial);
    runtimeLock?.release();
    runtimeLock = void 0;
    armIdle();
    statsTimer = setInterval(() => {
      void saveStats();
    }, 5e3);
    statsTimer.unref?.();
    return { stream, close: async () => {
      try {
        controller?.close();
      } catch {
      }
      await cleanup();
    } };
  } catch (e) {
    stats.error = e instanceof Error ? e.message : "Native video failed";
    await cleanup();
    throw e;
  }
}

// vendor/lib/harmony/hdc-backend.ts
import { existsSync as existsSync4 } from "node:fs";
import { link, lstat as lstat7, mkdtemp as mkdtemp3, readFile as readFile4, rm as rm4, stat as stat2, writeFile as writeFile3 } from "node:fs/promises";
import { createConnection, createServer as createServer2 } from "node:net";
import { tmpdir as tmpdir2 } from "node:os";
import { extname as extname2, isAbsolute as isAbsolute6, join as join11, resolve as resolve5, dirname as dirname6, posix as posix3 } from "node:path";
import { createHash as createHash5, randomUUID as randomUUID6 } from "node:crypto";

// vendor/lib/harmony/command-runner.ts
import { spawn as spawn2 } from "node:child_process";
import { isAbsolute as isAbsolute2 } from "node:path";
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
var runCommand = async (options) => {
  if (!isAbsolute2(options.executable)) {
    throw new HarmonyError("HDC_INVALID", "Device executables must use an absolute path");
  }
  if (options.signal?.aborted) {
    throw new HarmonyError("COMMAND_ABORTED", "Device operation was cancelled", { retryable: true });
  }
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const started = Date.now();
  return await new Promise((resolve6, reject) => {
    let settled = false;
    let totalOutput = 0;
    const stdout = [];
    const stderr = [];
    const child = spawn2(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.kill();
      reject(error);
    };
    const collect = (target, chunk) => {
      totalOutput += chunk.length;
      if (totalOutput > maxOutputBytes) {
        finishError(new HarmonyError("COMMAND_OUTPUT_LIMIT", "Device command exceeded its output limit", {
          details: { operation: options.operation, maxOutputBytes }
        }));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const abort = () => {
      finishError(new HarmonyError("COMMAND_ABORTED", "Device operation was cancelled", { retryable: true }));
    };
    const timer = setTimeout(() => {
      finishError(new HarmonyError("COMMAND_TIMEOUT", "Device command timed out", {
        details: { operation: options.operation, timeoutMs },
        retryable: true
      }));
    }, timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => {
      finishError(new HarmonyError("COMMAND_FAILED", "Unable to start device command", {
        cause: error,
        details: { operation: options.operation },
        retryable: true
      }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? -1,
        durationMs: Date.now() - started
      };
      if (result.exitCode !== 0) {
        reject(new HarmonyError("COMMAND_FAILED", "Device command failed", {
          details: { operation: options.operation, exitCode: result.exitCode },
          retryable: true
        }));
        return;
      }
      resolve6(result);
    });
  });
};

// vendor/lib/harmony/device-connection.ts
function isHdcChannelNotReadyResponse(output) {
  return /^\s*\[Fail\](?:\[E\d+\])?:?\s*(?:The\s+)?communication channel is being established\.?\s*$/im.test(output) || /^\s*\[F\]\[[^\]\r\n]{1,80}\]\s*Send\s+(?:isDead|hChannel nullptr)\s+channelId:\s*\d+\s*$/im.test(output);
}

// vendor/lib/harmony/runtime.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync, renameSync as renameSync2, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { posix, win32 } from "node:path";
var HDC_ENV_NAMES = ["PIORA_HARMONY_HDC_PATH", "HARMONY_HDC_PATH", "HDC_PATH"];
function isUsableFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}
function inferredPlatform(path) {
  return path && /^[A-Za-z]:[\\/]/.test(path.trim()) ? "win32" : process.platform;
}
function normalizeCandidate(candidate, platform = process.platform) {
  if (!candidate?.trim()) return void 0;
  const paths = pathApi(platform);
  const absolute = paths.isAbsolute(candidate.trim()) ? candidate.trim() : paths.resolve(candidate.trim());
  return absolute;
}
function versionDirectories(root, listDirectory) {
  try {
    return listDirectory(root).filter((entry) => /^\d+(?:\.\d+)*(?:[-_A-Za-z0-9.]*)?$/.test(entry)).sort((a, b) => b.localeCompare(a, void 0, { numeric: true }));
  } catch {
    return [];
  }
}
function devecoCandidates(homeDir, env, platform, listDirectory, readTextFile) {
  const paths = pathApi(platform);
  const executable = platform === "win32" ? "hdc.exe" : "hdc";
  const localAppData = env.LOCALAPPDATA || paths.join(homeDir, "AppData", "Local");
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const sdkRoots = [
    paths.join(localAppData, "Huawei", "Sdk"),
    paths.join(localAppData, "Huawei", "Sdk", "openharmony"),
    paths.join(homeDir, "Huawei", "Sdk")
  ];
  const result = [
    paths.join(programFiles, "Huawei", "DevEco Studio", "sdk", "default", "openharmony", "toolchains", executable),
    paths.join(programFiles, "Huawei", "DevEco Studio", "sdk", "default", "toolchains", executable),
    paths.join(localAppData, "Programs", "Huawei", "DevEco Studio", "sdk", "default", "openharmony", "toolchains", executable)
  ];
  const huaweiConfigRoot = paths.join(localAppData, "Huawei");
  for (const directory of (() => {
    try {
      return listDirectory(huaweiConfigRoot);
    } catch {
      return [];
    }
  })()) {
    if (!/^DevEcoStudio/i.test(directory)) continue;
    try {
      const installHome = readTextFile(paths.join(huaweiConfigRoot, directory, ".home")).trim();
      if (!installHome) continue;
      result.push(paths.join(installHome, "sdk", "default", "openharmony", "toolchains", executable));
      result.push(paths.join(installHome, "sdk", "default", "toolchains", executable));
    } catch {
    }
  }
  for (const sdkRoot of sdkRoots) {
    result.push(paths.join(sdkRoot, "default", "openharmony", "toolchains", executable));
    result.push(paths.join(sdkRoot, "default", "toolchains", executable));
    for (const version of versionDirectories(sdkRoot, listDirectory)) {
      result.push(paths.join(sdkRoot, version, "openharmony", "toolchains", executable));
      result.push(paths.join(sdkRoot, version, "toolchains", executable));
    }
  }
  return result;
}
function bundledHdcCandidate(env, platform) {
  const directory = env.PIORA_HARMONY_TOOLS_DIR?.trim();
  if (!directory) return void 0;
  const paths = pathApi(platform);
  const executable = platform === "win32" ? "hdc.exe" : "hdc";
  return paths.join(paths.resolve(directory), executable);
}
function resolveHdcPath(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir2();
  const exists = options.exists ?? isUsableFile;
  const listDirectory = options.listDirectory ?? ((path) => readdirSync(path));
  const readTextFile = options.readTextFile ?? ((path) => readFileSync2(path, "utf8"));
  const paths = pathApi(platform);
  const executable = platform === "win32" ? "hdc.exe" : "hdc";
  const check = (candidate) => {
    const normalized2 = normalizeCandidate(candidate, platform);
    return normalized2 && exists(normalized2) ? normalized2 : void 0;
  };
  const explicit = check(options.explicitPath);
  if (explicit) return { hdcPath: explicit, source: "explicit" };
  if (options.explicitPath?.trim()) {
    throw new HarmonyError("HDC_INVALID", "The configured HDC executable does not exist", {
      details: { source: "explicit" }
    });
  }
  for (const name of HDC_ENV_NAMES) {
    const environment = check(env[name]);
    if (environment) return { hdcPath: environment, source: "environment" };
  }
  const configured = check(options.config?.hdcPath);
  if (configured) return { hdcPath: configured, source: "config" };
  for (const candidate of devecoCandidates(homeDir, env, platform, listDirectory, readTextFile)) {
    const discovered = check(candidate);
    if (discovered) return { hdcPath: discovered, source: "deveco" };
  }
  for (const directory of (env.PATH ?? "").split(paths.delimiter)) {
    if (!directory.trim()) continue;
    const fromPath = check(paths.join(directory.replace(/^"|"$/g, ""), executable));
    if (fromPath) return { hdcPath: fromPath, source: "path" };
  }
  const bundled = check(bundledHdcCandidate(env, platform));
  if (bundled) return { hdcPath: bundled, source: "bundled" };
  throw new HarmonyError("HDC_NOT_FOUND", "HDC was not found in the system or the Piora application bundle.", {
    retryable: true
  });
}
function defaultHarmonyConfigPath(env = process.env) {
  const requested = env.PIORA_HARMONY_CONFIG_PATH?.trim();
  if (requested) return pathApi(inferredPlatform(requested)).resolve(requested);
  const desktopData = env.PIORA_DESKTOP_DATA_DIR?.trim();
  if (desktopData) {
    const paths2 = pathApi(inferredPlatform(desktopData));
    return paths2.join(paths2.resolve(desktopData), "harmony.json");
  }
  const appData = env.APPDATA?.trim();
  const paths = pathApi(inferredPlatform(appData));
  const base = appData || paths.join(homedir2(), ".piora");
  return paths.join(base, "Piora", "harmony.json");
}
function readHarmonyConfig(path = defaultHarmonyConfigPath()) {
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed;
    const config = {};
    if (typeof record.hdcPath === "string" && record.hdcPath.trim()) config.hdcPath = normalizeCandidate(record.hdcPath);
    if (record.video && typeof record.video === "object" && !Array.isArray(record.video)) {
      const video = record.video;
      if (video.provider === "bundled" || video.provider === "hos-scrcpy") config.video = {
        provider: video.provider,
        ...typeof video.packageDirectory === "string" && video.packageDirectory.trim() ? { packageDirectory: video.packageDirectory.trim() } : {},
        ...typeof video.javaPath === "string" && video.javaPath.trim() ? { javaPath: video.javaPath.trim() } : {}
      };
    }
    if (record.storage && typeof record.storage === "object" && !Array.isArray(record.storage)) {
      const storage = record.storage;
      const screenshotDirectory = typeof storage.screenshotDirectory === "string" && storage.screenshotDirectory.trim() ? normalizeCandidate(storage.screenshotDirectory) : void 0;
      const recordingDirectory = typeof storage.recordingDirectory === "string" && storage.recordingDirectory.trim() ? normalizeCandidate(storage.recordingDirectory) : void 0;
      if (screenshotDirectory || recordingDirectory) {
        config.storage = {
          ...screenshotDirectory ? { screenshotDirectory } : {},
          ...recordingDirectory ? { recordingDirectory } : {}
        };
      }
    }
    if (record.vision && typeof record.vision === "object" && !Array.isArray(record.vision)) {
      const vision = record.vision;
      if (typeof vision.enabled === "boolean" && typeof vision.provider === "string" && typeof vision.modelId === "string") {
        const provider = vision.provider.trim();
        const modelId = vision.modelId.trim();
        if (provider && modelId) {
          config.vision = {
            enabled: vision.enabled,
            provider,
            modelId,
            ...vision.shareScreenshotWithActionModel === true ? { shareScreenshotWithActionModel: true } : {}
          };
        }
      }
    }
    return config;
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || error instanceof SyntaxError) return {};
    throw new HarmonyError("INTERNAL_ERROR", "Unable to read Harmony device configuration", { cause: error });
  }
}

// vendor/lib/harmony/ui-tree.ts
function finiteNumber(value) {
  const number2 = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number2) ? number2 : void 0;
}
function stringValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return void 0;
}
function parseBounds(value) {
  if (typeof value === "string") {
    const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (numbers && numbers.length >= 4 && numbers.slice(0, 4).every(Number.isFinite)) {
      return { left: numbers[0], top: numbers[1], right: numbers[2], bottom: numbers[3] };
    }
    return void 0;
  }
  if (Array.isArray(value) && value.length >= 4) {
    const numbers = value.slice(0, 4).map(finiteNumber);
    if (numbers.every((number2) => number2 !== void 0)) {
      return { left: numbers[0], top: numbers[1], right: numbers[2], bottom: numbers[3] };
    }
  }
  if (!value || typeof value !== "object") return void 0;
  const record = value;
  const left = finiteNumber(record.left ?? record.leftTopX ?? record.x1 ?? record.startX);
  const top = finiteNumber(record.top ?? record.leftTopY ?? record.y1 ?? record.startY);
  const right = finiteNumber(record.right ?? record.rightBottomX ?? record.x2 ?? record.endX);
  const bottom = finiteNumber(record.bottom ?? record.rightBottomY ?? record.y2 ?? record.endY);
  return left === void 0 || top === void 0 || right === void 0 || bottom === void 0 ? void 0 : { left, top, right, bottom };
}
function first(record, names2) {
  for (const name of names2) {
    if (record[name] !== void 0) return record[name];
  }
  return void 0;
}
function probableNode(record) {
  return [
    "attributes",
    "bounds",
    "rect",
    "text",
    "id",
    "key",
    "type",
    "bundleName",
    "children",
    "clickable",
    "enabled",
    "description",
    "hint"
  ].some((key) => key in record);
}
function flattenUiTree(tree, maxNodes = 1e4) {
  const result = [];
  const visited = /* @__PURE__ */ new Set();
  const visit = (value, parentIndex) => {
    if (result.length >= maxNodes || !value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentIndex);
      return;
    }
    const record = value;
    const attributes = record.attributes && typeof record.attributes === "object" && !Array.isArray(record.attributes) ? record.attributes : {};
    const merged = { ...record, ...attributes };
    let thisIndex = parentIndex;
    if (probableNode(record)) {
      thisIndex = result.length;
      result.push({
        ...parentIndex === void 0 ? {} : { parentIndex },
        text: stringValue(first(merged, ["text", "content", "value"])),
        id: stringValue(first(merged, ["id", "accessibilityId", "key", "resourceId", "inspectorId", "uniqueId", "componentId"])),
        type: stringValue(first(merged, ["type", "componentType", "className", "componentName"])),
        hint: stringValue(first(merged, ["hint", "placeholder", "placeholderText"])),
        description: stringValue(first(merged, ["description", "accessibilityText", "contentDescription"])),
        bounds: parseBounds(first(merged, ["bounds", "rect", "bound", "visibleBounds", "boundsInScreen", "origBounds"])),
        enabled: booleanValue(merged.enabled),
        clickable: booleanValue(merged.clickable),
        scrollable: booleanValue(merged.scrollable),
        focused: booleanValue(merged.focused),
        selected: booleanValue(merged.selected),
        checked: booleanValue(merged.checked),
        visible: booleanValue(first(merged, ["visible", "isVisible", "visibleToUser"]))
      });
    }
    const childKeys = ["children", "child", "nodes", "components", "windows"];
    let traversedChildren = false;
    for (const key of childKeys) {
      if (record[key] !== void 0) {
        traversedChildren = true;
        visit(record[key], thisIndex);
      }
    }
    if (!traversedChildren || thisIndex !== parentIndex) {
      for (const [key, nested] of Object.entries(record)) {
        if (key === "attributes" || childKeys.includes(key)) continue;
        if (nested && typeof nested === "object") visit(nested, thisIndex);
      }
    }
  };
  visit(tree);
  return result;
}
function parseUiObservation(tree, maxNodes = 1e4) {
  const parsed = flattenUiTree(tree, maxNodes + 1);
  const truncated = parsed.length > maxNodes;
  const validEmpty = Array.isArray(tree) && tree.length === 0;
  const recognized = parsed.length > 0 || validEmpty;
  return {
    tree,
    nodes: parsed.slice(0, maxNodes),
    quality: {
      treeStatus: truncated ? "partial" : recognized ? "valid" : "unavailable",
      scopeComplete: recognized && !truncated,
      scope: recognized ? "active-windows" : "unknown"
    }
  };
}

// vendor/lib/harmony/observation/geometry.ts
function parseDisplayGeometry(output) {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /DisplayId\s+.*Rotation.*\[/.test(line));
  if (start < 0) {
    const markers = [...output.matchAll(/^[ \t]*-+[ \t]*Screen ID:[ \t]*(\d+)[ \t]*-+[ \t]*\r?$/gm)];
    const records = markers.length ? markers.map((marker, index) => {
      const body = output.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? output.length);
      return body.split(/^[ \t]*-+[ \t]*(?:Display ID:|Client Screen Infos)/m)[0];
    }) : [output];
    const real = [];
    const identities = /* @__PURE__ */ new Set();
    for (const record of records) {
      const sections = (name) => [...record.matchAll(new RegExp(`^[ \\t]*\\[${name}\\][ \\t]*\\r?\\n([\\s\\S]*?)(?=^[ \\t]*\\[|$(?![\\s\\S]))`, "gm"))];
      const sessions = sections("SCREEN SESSION"), properties = sections("SCREEN PROPERTY"), infos = sections("SCREEN INFO");
      if (sessions.length !== 1 || properties.length !== 1 || infos.length > 1 || properties[0].index < sessions[0].index) return void 0;
      const ids = [...sessions[0][1].matchAll(/^[ \t]*DisplayId:[ \t]*(\d+)[ \t]*\r?$/gm)];
      if (ids.length !== 1 || [...sessions[0][1].matchAll(/^[ \t]*DisplayId:/gm)].length !== 1 || identities.has(ids[0][1])) return void 0;
      identities.add(ids[0][1]);
      const types = [
        ...sessions[0][1].matchAll(/^[ \t]*ScreenType:[ \t]*(.*)$/gm),
        ...(infos[0]?.[1] ?? "").matchAll(/^[ \t]*ScreenType:[ \t]*(.*)$/gm),
        ...properties[0][1].matchAll(/^[ \t]*GetScreenType:[ \t]*(.*)$/gm)
      ].map((match) => match[1].trim());
      if (types.some((type) => type !== "1" && type !== "2") || new Set(types).size > 1 || !types.length && records.length > 1) return void 0;
      if (types[0] === "2") continue;
      const section = properties[0][1];
      const bounds = [...section.matchAll(/^[ \t]*Bounds<L,T,W,H>:[ \t]*0(?:\.0+)?,[ \t]*0(?:\.0+)?,[ \t]*(\d+)(?:\.0+)?,[ \t]*(\d+)(?:\.0+)?,?[ \t]*\r?$/gm)];
      const rotations = [...section.matchAll(/^[ \t]*ScreenRotation:[ \t]*(0|1|2|3|90|180|270)[ \t]*\r?$/gm)];
      if (bounds.length !== 1 || rotations.length !== 1 || [...section.matchAll(/^[ \t]*Bounds<L,T,W,H>:/gm)].length !== 1 || [...section.matchAll(/^[ \t]*ScreenRotation:/gm)].length !== 1) return void 0;
      const nativeWidth2 = Number(bounds[0][1]), nativeHeight2 = Number(bounds[0][2]), rotation2 = Number(rotations[0][1]);
      if (nativeWidth2 < 1 || nativeHeight2 < 1 || nativeWidth2 > 16384 || nativeHeight2 > 16384) return void 0;
      real.push({ nativeWidth: nativeWidth2, nativeHeight: nativeHeight2, displayId: ids[0][1], displayRotation: rotation2 < 4 ? rotation2 * 90 : rotation2 });
    }
    return real.length === 1 ? real[0] : void 0;
  }
  const rows = lines.slice(start + 1).map((line) => line.match(/^\s*(\d+)\s+\d+\s+[\d.]+\s+[\d.]+\s+([0-3])\s+\d+\s+\d+\s+\d+\s+\[\s*0\s+0\s+(\d+)\s+(\d+)\s*\]/)).filter((match) => match !== null);
  if (rows.length !== 1) return void 0;
  const [, displayId, rotation, width, height] = rows[0];
  const nativeWidth = Number(width), nativeHeight = Number(height);
  if (nativeWidth < 1 || nativeHeight < 1 || nativeWidth > 16384 || nativeHeight > 16384) return void 0;
  return { nativeWidth, nativeHeight, displayId, displayRotation: Number(rotation) * 90 };
}

// vendor/lib/harmony/runtime/forward-store.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync as readdirSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join6 } from "node:path";

// vendor/lib/atomic-file.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { renameSync as renameSync3, unlinkSync, writeFileSync as writeFileSync3 } from "node:fs";
import { basename, dirname as dirname3, join as join5 } from "node:path";
function writePrivateFileAtomicSync(path, contents) {
  const dir = dirname3(path);
  const tempPath = join5(dir, `.${basename(path)}-${randomUUID4()}.tmp`);
  let operationFailed = false;
  try {
    writeFileSync3(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 384,
      flush: true
    });
    renameSync3(tempPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if (error.code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}

// vendor/lib/harmony/runtime/path-safety.ts
import { lstatSync as lstatSync2 } from "node:fs";
import { lstat as lstat2 } from "node:fs/promises";
import { dirname as dirname4, resolve as resolve2 } from "node:path";
function redirectedPath() {
  return new HarmonyError("INVALID_ARGUMENT", "Artifact paths cannot contain symbolic links or redirected parents");
}
async function assertUnredirectedPath(path) {
  for (let current = resolve2(path); ; current = dirname4(current)) {
    if ((await lstat2(current)).isSymbolicLink()) throw redirectedPath();
    if (dirname4(current) === current) return;
  }
}
function assertUnredirectedPathSync(path) {
  for (let current = resolve2(path); ; current = dirname4(current)) {
    if (lstatSync2(current).isSymbolicLink()) throw redirectedPath();
    if (dirname4(current) === current) return;
  }
}

// vendor/lib/harmony/runtime/forward-store.ts
var ForwardOwnershipStore = class {
  constructor(directory) {
    this.directory = directory;
    mkdirSync3(directory, { recursive: true, mode: 448 });
    assertUnredirectedPathSync(directory);
  }
  create(serial, localPort, remotePort) {
    const record = { id: randomUUID5(), serial, pid: process.pid, localPort, remotePort, state: "pending", createdAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.save(record);
    return record;
  }
  save(record) {
    writePrivateFileAtomicSync(join6(this.directory, `${record.id}.json`), JSON.stringify(record));
  }
  clear(record) {
    unlinkSync2(join6(this.directory, `${record.id}.json`));
  }
  interrupted(serial) {
    return readdirSync2(this.directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap((name) => {
      let record;
      try {
        record = JSON.parse(readFileSync3(join6(this.directory, name), "utf8"));
      } catch {
        return [];
      }
      if (record.serial !== serial || !Number.isInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.localPort) || record.remotePort !== 53535) return [];
      try {
        process.kill(record.pid, 0);
        return [];
      } catch (error) {
        return error.code === "ESRCH" ? [{ localPort: record.localPort, remotePort: record.remotePort, state: record.state }] : [];
      }
    });
  }
};

// vendor/lib/harmony/media/owned-recording.ts
import { open, copyFile, mkdtemp, rm as rm2, rmdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join as join7 } from "node:path";
import { Output, Mp4OutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedPacket } from "mediabunny";
var MAX_BYTES = 256 * 1024 * 1024;
var MAX_PACKET = 16 * 1024 * 1024;
function units(data) {
  const starts = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] || data[i + 1]) continue;
    const size = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
    if (size) {
      starts.push({ start: i, size });
      i += size - 1;
    }
  }
  return starts.length ? starts.map((value, index) => data.subarray(value.start + value.size, starts[index + 1]?.start ?? data.length)).filter((value) => value.length) : [data];
}
function lengthPrefixed(data) {
  return Buffer.concat(units(data).map((unit) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(unit.length);
    return Buffer.concat([size, unit]);
  }));
}
function configuration(payload) {
  if (payload.length < 17 || payload[0] !== 0) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Owned MP4 recording requires the mirror's H.264 stream; no system recorder will be toggled", { details: { dispatchState: "not-sent" } });
  const width = payload.readUInt32BE(1), height = payload.readUInt32BE(5), fps = payload.readUInt32BE(9);
  if (!width || !height || width > 8192 || height > 8192 || fps < 1 || fps > 120) throw new HarmonyError("INVALID_RESPONSE", "Invalid recording geometry or frame rate");
  const sl = payload.readUInt16BE(13), pp = 15 + sl;
  if (pp + 2 > payload.length) throw new HarmonyError("INVALID_RESPONSE", "Truncated recording SPS");
  const pl = payload.readUInt16BE(pp);
  if (pp + 2 + pl !== payload.length) throw new HarmonyError("INVALID_RESPONSE", "Truncated recording PPS");
  const sps = units(payload.subarray(15, pp))[0], pps = units(payload.subarray(pp + 2))[0];
  if (sps.length < 4 || pps.length < 1 || (sps[0] & 31) !== 7 || (pps[0] & 31) !== 8) throw new HarmonyError("INVALID_RESPONSE", "Invalid AVC parameter sets");
  const description = Buffer.alloc(11 + sps.length + pps.length);
  description.set([1, sps[1], sps[2], sps[3], 255, 225]);
  description.writeUInt16BE(sps.length, 6);
  description.set(sps, 8);
  description[8 + sps.length] = 1;
  description.writeUInt16BE(pps.length, 9 + sps.length);
  description.set(pps, 11 + sps.length);
  return { width, height, fps, description, codec: `avc1.${sps.subarray(1, 4).toString("hex")}` };
}
async function startOwnedRecording(connection, signal, onFailure) {
  const directory = await mkdtemp(join7(tmpdir(), "piora-owned-recording-"));
  const path = join7(directory, "capture.mp4");
  const handle = await open(path, "wx", 384).catch(async (error) => {
    await rmdir(directory);
    await connection.close();
    throw error;
  });
  const source = new EncodedVideoPacketSource("avc");
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(new WritableStream({
    async write(chunk) {
      if (chunk.position + chunk.data.length > MAX_BYTES) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording reached its 256 MiB limit");
      let offset = 0;
      while (offset < chunk.data.length) {
        const result = await handle.write(chunk.data, offset, chunk.data.length - offset, chunk.position + offset);
        if (!result.bytesWritten) throw new Error("Recording write made no progress");
        offset += result.bytesWritten;
      }
    }
  }), { chunked: true, chunkSize: 1024 * 1024 }) });
  let reader;
  try {
    output.addVideoTrack(source);
    await output.start();
    reader = connection.stream.getReader();
  } catch (error) {
    await output.cancel().catch(() => void 0);
    await handle.close();
    await rm2(path, { force: true });
    await rmdir(directory);
    await connection.close();
    throw error;
  }
  let stopping = false, failure, frames = 0, firstTimestamp, config;
  let accepted = false, ended = false, failureReported = false;
  const reportFailure = () => {
    if (!accepted || !ended || stopping || !failure || failureReported || !onFailure) return;
    failureReported = true;
    const error = asHarmonyError(failure);
    queueMicrotask(() => {
      try {
        onFailure(new HarmonyError(error.code, error.message, { details: { ...error.details, recordingStopped: true } }));
      } catch {
      }
    });
  };
  let resolveReady, rejectReady;
  const ready = new Promise((resolve6, reject) => {
    resolveReady = resolve6;
    rejectReady = reject;
  });
  let closing;
  const close = () => closing ??= Promise.allSettled([reader.cancel().catch(() => void 0), connection.close()]).then((results) => {
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) throw new HarmonyError("DEVICE_BUSY", "Recording stream cleanup is uncertain", {
      cause: rejected.reason,
      details: { cleanup: "uncertain", recordingStopped: true }
    });
  });
  const abort = () => {
    failure = new HarmonyError("COMMAND_ABORTED", "Recording startup was cancelled", { details: { dispatchState: "not-sent" } });
    rejectReady(failure);
    void close().catch(() => void 0);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const startup = setTimeout(() => {
    failure = new HarmonyError("COMMAND_TIMEOUT", "No H.264 keyframe arrived for recording", { details: { dispatchState: "not-sent" } });
    rejectReady(failure);
    void close().catch(() => void 0);
  }, 15e3);
  let pending = Buffer.alloc(0);
  const pump = (async () => {
    try {
      while (!stopping && !failure) {
        const { done, value } = await reader.read();
        if (done) {
          if (!stopping) throw new HarmonyError("DEVICE_OFFLINE", "Recording stream ended before stop");
          break;
        }
        if (pending.length + value.length > MAX_PACKET + 8) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording packet buffer exceeded limit");
        pending = Buffer.concat([pending, value]);
        while (pending.length >= 8) {
          const type = pending.readUInt32BE(0), length = pending.readUInt32BE(4);
          if (length > MAX_PACKET) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording packet exceeded limit");
          if (pending.length < length + 8) break;
          const payload = pending.subarray(8, length + 8);
          pending = pending.subarray(length + 8);
          if (type === 2) {
            const next = configuration(payload);
            if (config && (next.width !== config.width || next.height !== config.height || !next.description.equals(config.description))) throw new HarmonyError("STALE_SNAPSHOT", "Video geometry or codec changed; stop and start a new recording");
            config = next;
          } else if (type === 3 && config && payload.length > 9) {
            const key = Boolean(payload[0] & 1), timestamp = Number(payload.readBigUInt64BE(1));
            if (!frames && !key) continue;
            if (!Number.isSafeInteger(timestamp) || frames >= 14400) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording timestamp or frame limit exceeded");
            firstTimestamp ??= timestamp;
            const relative2 = (timestamp - firstTimestamp) / 1e6;
            if (relative2 < 0 || relative2 > 120) throw new HarmonyError("COMMAND_OUTPUT_LIMIT", "Recording reached its two-minute limit");
            await source.add(new EncodedPacket(lengthPrefixed(payload.subarray(9)), key ? "key" : "delta", relative2, 1 / config.fps), frames ? void 0 : { decoderConfig: { codec: config.codec, codedWidth: config.width, codedHeight: config.height, description: config.description } });
            frames++;
            resolveReady();
          }
        }
      }
    } catch (error) {
      failure ??= error;
      rejectReady(error);
    } finally {
      await close().catch((error) => {
        const original = failure ? asHarmonyError(failure) : asHarmonyError(error);
        failure = new HarmonyError(original.code, original.message, {
          cause: error,
          details: { ...original.details, cleanup: "uncertain", recordingStopped: true }
        });
      });
      ended = true;
      reportFailure();
    }
  })();
  if (signal?.aborted) abort();
  let discardPromise;
  let completion;
  const discard = () => discardPromise ??= (async () => {
    if (completion) {
      await completion.catch(() => void 0);
      return;
    }
    stopping = true;
    try {
      await close();
    } finally {
      await pump;
      await output.cancel().catch(() => void 0);
      await handle.close();
      await rm2(path, { force: true });
      await rmdir(directory);
    }
  })();
  try {
    await ready;
  } catch (error) {
    await discard();
    throw error;
  } finally {
    clearTimeout(startup);
    signal?.removeEventListener("abort", abort);
  }
  accepted = true;
  reportFailure();
  const stop = (destination) => completion ??= (async () => {
    stopping = true;
    try {
      await close();
      await pump;
      if (failure) throw failure;
      source.close();
      await output.finalize();
      await handle.close();
      await copyFile(path, destination, constants.COPYFILE_EXCL);
      return (await stat(destination)).size;
    } finally {
      await pump;
      if (output.state !== "finalized") await output.cancel().catch(() => void 0);
      await handle.close().catch(() => void 0);
      await rm2(path, { force: true });
      await rmdir(directory);
    }
  })();
  return { stop, discard };
}

// vendor/lib/harmony/runtime/hap-preview.ts
import { createHash as createHash3 } from "node:crypto";
import { basename as basename2, extname, isAbsolute as isAbsolute3 } from "node:path";
import JSZip2 from "jszip";

// vendor/lib/harmony/runtime/bounded-file.ts
import { lstat as lstat3, open as open2, readdir, unlink } from "node:fs/promises";
async function readBoundedRegularFile(path, maximum) {
  const before = await lstat3(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new HarmonyError("INVALID_ARGUMENT", "Artifact must be a bounded regular file without redirected parents");
  await assertUnredirectedPath(path);
  const handle = await open2(path, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new HarmonyError("INVALID_ARGUMENT", "Artifact changed before it could be read");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs) throw new HarmonyError("INVALID_ARGUMENT", "Artifact changed while reading; use an immutable copy");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

// vendor/lib/harmony/runtime/hap-preview.ts
var MAX_METADATA = 512 * 1024;
var identifier = /^[A-Za-z][A-Za-z0-9_.:]{0,255}$/;
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
var text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : void 0;
var integer = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
var names = (value) => Array.isArray(value) ? [...new Set(value.slice(0, 256).map((item) => typeof item === "string" ? item : object(item)?.name).filter((name) => typeof name === "string" && identifier.test(name)))] : [];
var invalid = (message) => new HarmonyError("INVALID_ARGUMENT", message, { details: { reason: "hap-preview-invalid" } });
async function previewHapArtifact(path, signal) {
  signal?.throwIfAborted();
  if (!isAbsolute3(path) || extname(path).toLowerCase() !== ".hap") throw invalid("Choose an absolute HAP file path");
  const data = await readBoundedRegularFile(path, 256 * 1024 * 1024);
  if (!data.length) throw invalid("The HAP is empty");
  signal?.throwIfAborted();
  let zip;
  try {
    zip = await JSZip2.loadAsync(data, { createFolders: false });
  } catch {
    throw invalid("Cannot read this HAP archive");
  }
  if (Object.keys(zip.files).length > 2e4) throw invalid("The HAP contains too many entries");
  const entry = zip.file("module.json") ?? zip.file("config.json");
  const original = entry?.unsafeOriginalName;
  if (!entry || entry.dir || original !== void 0 && original !== entry.name) throw invalid("The HAP has no regular root module.json or config.json");
  const stream = entry.internalStream("nodebuffer");
  let metadata;
  try {
    metadata = await new Promise((resolve6, reject) => {
      const chunks = [];
      let bytes = 0, finished = false;
      const fail = (error) => {
        if (finished) return;
        finished = true;
        stream.pause();
        signal?.removeEventListener("abort", abort);
        reject(error);
      };
      const abort = () => fail(new HarmonyError("COMMAND_ABORTED", "Package preview was cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      stream.on("data", (chunk) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > MAX_METADATA) fail(invalid("The HAP configuration is too large"));
        else chunks.push(chunk);
      });
      stream.on("error", fail);
      stream.on("end", () => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        resolve6(Buffer.concat(chunks));
      });
      if (signal?.aborted) abort();
      else stream.resume();
    });
  } catch (error) {
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Package preview was cancelled");
    if (error instanceof HarmonyError) throw error;
    throw invalid("Cannot decode the HAP configuration");
  } finally {
    stream.pause();
  }
  let root;
  try {
    root = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata)));
  } catch {
    throw invalid("The HAP configuration is not valid UTF-8 JSON");
  }
  const app2 = object(root?.app), moduleInfo = object(root?.module);
  const bundleName = app2?.bundleName;
  if (typeof bundleName !== "string" || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(bundleName) || !moduleInfo) throw invalid("The HAP has no valid application identity or module");
  const legacyVersion = object(app2?.version);
  const encodedApi = integer(app2?.minAPIVersion ?? app2?.apiVersion);
  const apiLevel = encodedApi === void 0 ? void 0 : encodedApi >= 1e8 ? encodedApi % 1e4 : encodedApi;
  signal?.throwIfAborted();
  return {
    filename: basename2(path),
    size: data.length,
    sha256: createHash3("sha256").update(data).digest("hex"),
    bundleName,
    versionName: text(app2?.versionName ?? legacyVersion?.name),
    versionCode: integer(app2?.versionCode ?? legacyVersion?.code),
    ...apiLevel !== void 0 && apiLevel > 0 && apiLevel < 1e3 ? { minApiVersion: apiLevel } : {},
    moduleName: text(moduleInfo.name),
    moduleType: text(moduleInfo.type),
    abilities: names(moduleInfo.abilities),
    deviceTypes: names(moduleInfo.deviceTypes),
    permissions: names(moduleInfo.requestPermissions ?? moduleInfo.reqPermissions),
    signature: "unverified"
  };
}

// vendor/lib/harmony/runtime/mirror-signing.ts
import { createHash as createHash4, X509Certificate } from "node:crypto";
import { homedir as homedir3 } from "node:os";
import { basename as basename3, dirname as dirname5, isAbsolute as isAbsolute4, join as join9, relative, resolve as resolve3 } from "node:path";
import { chmod, lstat as lstat5, mkdir as mkdir2, mkdtemp as mkdtemp2, readFile as readFile3, realpath, rename as rename2, rm as rm3, writeFile as writeFile2 } from "node:fs/promises";
import JSON5 from "json5";

// vendor/lib/harmony/runtime/deveco-password.mjs
import { spawn as spawn3 } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { lstat as lstat4, readFile as readFile2, readdir as readdir2 } from "node:fs/promises";
import { join as join8 } from "node:path";
var COMPONENT = Buffer.from([49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119]);
var MATERIAL_DIRECTORIES = ["fd", "ac", "ce"];
function isDevEcoProtectedPassword(value) {
  if (typeof value !== "string" || value.length < 66 || value.length > 544 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return false;
  const bytes = Buffer.from(value, "hex");
  if (bytes.length < 33) return false;
  const encryptedLength = bytes.readUInt32BE(0);
  return encryptedLength >= 17 && encryptedLength <= 272 && bytes.length - 4 - encryptedLength === 12;
}
async function boundedRegularFile(path, maximum) {
  const status = await lstat4(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > maximum) {
    throw new Error("DevEco protected-password material is invalid");
  }
  const bytes = await readFile2(path);
  if (bytes.length !== status.size) throw new Error("DevEco protected-password material changed while being read");
  return bytes;
}
async function onlyMaterialFile(directory, maximum) {
  const directoryStatus = await lstat4(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error("DevEco protected-password material directory is invalid");
  }
  const entries = (await readdir2(directory)).filter((name) => name !== ".DS_Store");
  if (entries.length !== 1) throw new Error("DevEco protected-password material directory is ambiguous");
  return await boundedRegularFile(join8(directory, entries[0]), maximum);
}
function decryptContainer(key, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33) throw new Error("DevEco encrypted material is truncated");
  const encryptedLength = bytes.readUInt32BE(0);
  const ivLength = bytes.length - 4 - encryptedLength;
  const encryptedBodyLength = encryptedLength - 16;
  if (ivLength !== 12 || encryptedBodyLength < 1 || encryptedBodyLength > 256) {
    throw new Error("DevEco encrypted material has an unsupported shape");
  }
  const iv = bytes.subarray(4, 4 + ivLength);
  const encrypted = bytes.subarray(4 + ivLength, bytes.length - 16);
  const tag = bytes.subarray(bytes.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
async function decryptDevEcoProtectedPassword(materialDirectory, encryptedPassword) {
  if (!isDevEcoProtectedPassword(encryptedPassword)) {
    throw new Error("DevEco protected password has an unsupported shape");
  }
  const materialRoot = join8(materialDirectory, "material");
  const rootStatus = await lstat4(materialRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("DevEco protected-password material root is invalid");
  }
  const rootEntries = (await readdir2(materialRoot)).filter((name) => name !== ".DS_Store");
  if (rootEntries.length !== MATERIAL_DIRECTORIES.length || MATERIAL_DIRECTORIES.some((name) => !rootEntries.includes(name))) {
    throw new Error("DevEco protected-password material set is incomplete");
  }
  const fdRoot = join8(materialRoot, MATERIAL_DIRECTORIES[0]);
  const fdStatus = await lstat4(fdRoot);
  if (!fdStatus.isDirectory() || fdStatus.isSymbolicLink()) {
    throw new Error("DevEco protected-password key directory is invalid");
  }
  const fdNames = (await readdir2(fdRoot)).filter((name) => name !== ".DS_Store");
  if (fdNames.length !== 3) throw new Error("DevEco protected-password key material is incomplete");
  const components = await Promise.all(fdNames.map(async (name) => {
    const bytes = await onlyMaterialFile(join8(fdRoot, name), 16);
    if (bytes.length !== 16) throw new Error("DevEco protected-password key material has an invalid size");
    return bytes;
  }));
  components.push(COMPONENT);
  const mixed = Buffer.from(components[0]);
  for (const component of components.slice(1)) {
    for (let index = 0; index < mixed.length; index += 1) mixed[index] ^= component[index];
  }
  const salt = await onlyMaterialFile(join8(materialRoot, MATERIAL_DIRECTORIES[1]), 1024);
  const encryptedWorkKey = await onlyMaterialFile(join8(materialRoot, MATERIAL_DIRECTORIES[2]), 1024);
  const rootKey = pbkdf2Sync(mixed.toString(), salt, 1e4, 16, "sha256");
  let workKey;
  try {
    workKey = decryptContainer(rootKey, encryptedWorkKey);
    if (workKey.length !== 16) throw new Error("DevEco protected-password work key has an invalid size");
    const plaintext = decryptContainer(workKey, Buffer.from(encryptedPassword, "hex"));
    try {
      const password = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      if (!password || password.length > 256 || /[\u0000-\u001f\u007f]/.test(password)) {
        throw new Error("DevEco protected password decrypted to an invalid value");
      }
      return password;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    mixed.fill(0);
    rootKey.fill(0);
    workKey?.fill(0);
  }
}
async function signHapWithJava(options) {
  const {
    javaPath,
    signToolPath,
    signerSourcePath,
    keyAlias,
    keyPassword,
    certificatePath,
    profilePath,
    inputPath,
    signAlgorithm,
    storePath,
    storePassword,
    outputPath,
    compatibleVersion = 26,
    cwd,
    env = process.env,
    signal,
    timeoutMs = 12e4
  } = options;
  const args = [
    "-cp",
    signToolPath,
    signerSourcePath,
    keyAlias,
    certificatePath,
    profilePath,
    inputPath,
    signAlgorithm,
    storePath,
    outputPath,
    String(compatibleVersion)
  ];
  const secretInput = Buffer.from(`${keyPassword}
${storePassword}
`, "utf8");
  if (signal?.aborted) {
    secretInput.fill(0);
    throw new Error("Harmony HAP signing was cancelled");
  }
  return await new Promise((resolve6, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    let timer;
    let child;
    try {
      child = spawn3(javaPath, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      secretInput.fill(0);
      reject(new Error("Unable to start the local Harmony HAP signer"));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      secretInput.fill(0);
    };
    const sanitized = () => {
      let value = Buffer.concat([...stdout, ...stderr]).toString("utf8").slice(-8e3);
      for (const secret of [keyPassword, storePassword]) {
        if (typeof secret === "string" && secret.length >= 1) value = value.replaceAll(secret, "<redacted>");
      }
      for (const path of [javaPath, signToolPath, signerSourcePath, certificatePath, profilePath, inputPath, storePath, outputPath, cwd]) {
        if (typeof path !== "string" || path.length < 1) continue;
        value = value.replaceAll(path, "<path>").replaceAll(path.replaceAll("\\", "/"), "<path>");
      }
      return value.replace(/[A-Za-z0-9_+/=-]{24,}/g, "<redacted>");
    };
    const wipeOutput = () => {
      for (const bytes of [...stdout, ...stderr]) bytes.fill(0);
      stdout.length = 0;
      stderr.length = 0;
    };
    const finishError = (message) => {
      if (settled) return;
      settled = true;
      const diagnostics = sanitized();
      cleanup();
      child.kill();
      wipeOutput();
      reject(new Error(`${message}${diagnostics ? `
${diagnostics}` : ""}`));
    };
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 4 * 1024 * 1024) finishError("Harmony HAP signing exceeded its output limit");
      else target.push(Buffer.from(chunk));
    };
    const abort = () => finishError("Harmony HAP signing was cancelled");
    timer = setTimeout(() => finishError("Harmony HAP signing timed out"), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", () => finishError("Unable to start the local Harmony HAP signer"));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const diagnostics = code === 0 ? "" : sanitized();
      cleanup();
      wipeOutput();
      if (code !== 0) {
        reject(new Error(`Harmony HAP signing failed with exit ${code ?? -1}${diagnostics ? `
${diagnostics}` : ""}`));
      } else {
        resolve6();
      }
    });
    child.stdin.on("error", () => finishError("Unable to provide the local Harmony signing credentials"));
    child.stdin.end(secretInput, () => secretInput.fill(0));
    if (signal?.aborted) abort();
  });
}

// vendor/lib/harmony/runtime/mirror-signing.ts
var MIRROR_BUNDLE = "com.ohos.scrcpy.server";
var SIGNING_DESCRIPTOR = "piora-harmony-device-signing.json";
var SIGNER_SOURCE = "PioraHapSigner.java";
var SIGNING_PROJECT = "deveco-signing-project";
var SIGNING_TEMPLATE_FINGERPRINT = ".piora-template-sha256";
var SIGNING_PRODUCT = "default";
var MAX_HAP_BYTES = 256 * 1024 * 1024;
var SIGNING_TEMPLATE_FILES = [
  "build-profile.json5",
  "oh-package.json5",
  "hvigorfile.ts",
  "hvigor/hvigor-config.json5",
  "AppScope/app.json5",
  "entry/build-profile.json5",
  "entry/oh-package.json5",
  "entry/hvigorfile.ts",
  "entry/src/main/module.json5"
];
var sha256 = (bytes) => createHash4("sha256").update(bytes).digest("hex");
var exactKeys = (value, keys) => Boolean(value) && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
function signingJobs() {
  return globalThis.__pioraHarmonyMirrorSigning ??= /* @__PURE__ */ new Map();
}
function inside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || !child.startsWith("..") && !isAbsolute4(child);
}
async function regularFile(path, maximum) {
  const before = await lstat5(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) {
    throw new Error("invalid regular file");
  }
  const bytes = await readFile3(path);
  const after = await lstat5(path);
  if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    throw new Error("file changed while being read");
  }
  return bytes;
}
async function jsonFile(path, maximum = 1024 * 1024) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, maximum)));
}
async function json5File(path, maximum = 1024 * 1024) {
  return JSON5.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, maximum)));
}
function isMissing(error) {
  return Boolean(error) && typeof error === "object" && error.code === "ENOENT";
}
async function requirePrivateDirectory(path) {
  await mkdir2(path, { recursive: true, mode: 448 });
  const status = await lstat5(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("private signing directory is invalid");
  await chmod(path, 448).catch(() => void 0);
  return await realpath(path);
}
async function firstRegularFile(candidates, maximum) {
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute4(candidate)) continue;
    try {
      await regularFile(candidate, maximum);
      return resolve3(candidate);
    } catch {
    }
  }
  throw new Error("required DevEco tool is unavailable");
}
function candidateSdkRoots(hdcPath, environment) {
  const roots = [];
  const add = (value) => {
    if (!value?.trim() || !isAbsolute4(value.trim())) return;
    const absolute = resolve3(value.trim());
    const name = basename3(absolute).toLocaleLowerCase();
    if (name === "toolchains") {
      const component = dirname5(absolute);
      roots.push(basename3(component).toLocaleLowerCase() === "openharmony" ? dirname5(component) : component);
      return;
    }
    if (name === "openharmony") roots.push(dirname5(absolute));
    else roots.push(absolute, join9(absolute, "default"));
  };
  const hdcDirectory = dirname5(hdcPath);
  if (basename3(hdcDirectory).toLocaleLowerCase() === "toolchains") add(hdcDirectory);
  add(environment.DEVECO_SDK_HOME);
  add(environment.HARMONY_SDK_HOME);
  if (environment.DEVECO_STUDIO_HOME?.trim()) add(join9(environment.DEVECO_STUDIO_HOME.trim(), "sdk"));
  return [...new Set(roots)];
}
async function resolveSigningTools(hdcPath, environment) {
  let sdkDefault;
  let toolchains;
  for (const candidate of candidateSdkRoots(hdcPath, environment)) {
    try {
      const metadata = await jsonFile(join9(candidate, "sdk-pkg.json"), 1024 * 1024);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.data?.apiVersion !== "26" || metadata.data?.platformVersion !== "26.0.0") continue;
      const candidateToolchains = await firstRegularFile([
        join9(candidate, "openharmony", "toolchains", "lib", "hap-sign-tool.jar"),
        join9(candidate, "toolchains", "lib", "hap-sign-tool.jar")
      ], 64 * 1024 * 1024);
      sdkDefault = candidate;
      toolchains = dirname5(dirname5(candidateToolchains));
      break;
    } catch {
    }
  }
  if (!sdkDefault || !toolchains) throw new Error("local HarmonyOS API 26 signing SDK is unavailable");
  const derivedStudioRoot = basename3(sdkDefault).toLocaleLowerCase() === "default" && basename3(dirname5(sdkDefault)).toLocaleLowerCase() === "sdk" ? dirname5(dirname5(sdkDefault)) : dirname5(sdkDefault);
  const javaName = process.platform === "win32" ? "java.exe" : "java";
  const java = await firstRegularFile([
    environment.HARMONY_JAVA_PATH?.trim(),
    environment.JAVA_HOME?.trim() ? join9(environment.JAVA_HOME.trim(), "bin", javaName) : void 0,
    environment.DEVECO_STUDIO_HOME?.trim() ? join9(environment.DEVECO_STUDIO_HOME.trim(), "jbr", "bin", javaName) : void 0,
    join9(derivedStudioRoot, "jbr", "bin", javaName)
  ], 16 * 1024 * 1024);
  const signTool = await firstRegularFile([join9(toolchains, "lib", "hap-sign-tool.jar")], 64 * 1024 * 1024);
  const signerSource = await firstRegularFile([
    environment.PIORA_HARMONY_SIGNER_SOURCE_PATH?.trim(),
    environment.PIORA_HARMONY_TOOLS_DIR?.trim() ? join9(environment.PIORA_HARMONY_TOOLS_DIR.trim(), SIGNER_SOURCE) : void 0,
    join9(process.cwd(), "lib", "harmony", "runtime", SIGNER_SOURCE)
  ], 64 * 1024);
  return { java, signTool, signerSource };
}
function validatePublicMirrorReceipt(receipt, sourceBytes) {
  if (!exactKeys(receipt, ["schemaVersion", "kind", "origin", "artifact", "acceptanceArtifact", "sdk", "signing", "verification", "deviceAcceptance"]) || receipt.schemaVersion !== 2 || receipt.kind !== "private-device-acceptance-verification") {
    throw new Error("installed Piora mirror resource has no public unsigned receipt");
  }
  const artifact = receipt.artifact;
  const acceptanceArtifact = receipt.acceptanceArtifact;
  const sdk = receipt.sdk;
  const signing = receipt.signing;
  const verification = receipt.verification;
  const deviceAcceptance = receipt.deviceAcceptance;
  const verificationRecord = verification;
  const deviceAcceptanceRecord = deviceAcceptance;
  if (!exactKeys(artifact, ["filename", "size", "sha256"]) || artifact.filename !== "OHScrcpyServer.hap" || artifact.size !== sourceBytes.length || artifact.sha256 !== sha256(sourceBytes) || !exactKeys(acceptanceArtifact, ["size", "sha256", "sourceSha256"]) || typeof acceptanceArtifact.size !== "number" || !Number.isSafeInteger(acceptanceArtifact.size) || acceptanceArtifact.size < 1 || acceptanceArtifact.size > MAX_HAP_BYTES || !/^[0-9a-f]{64}$/.test(String(acceptanceArtifact.sha256)) || acceptanceArtifact.sourceSha256 !== artifact.sha256 || acceptanceArtifact.sha256 === artifact.sha256 || !exactKeys(sdk, ["apiVersion", "platformVersion", "toolVersion", "releaseType", "signToolSha256"]) || sdk.apiVersion !== "26" || sdk.platformVersion !== "26.0.0" || !/^26\.0\.0\.\d+$/.test(String(sdk.toolVersion)) || !/^[0-9a-f]{64}$/.test(String(sdk.signToolSha256)) || !exactKeys(signing, ["mode", "material", "alias", "profileType", "compatibleVersion", "signCode", "distribution"]) || signing.mode !== "localSign" || signing.material !== "private DevEco acceptance identity" || signing.alias !== "debugKey" || signing.profileType !== "debug" || signing.compatibleVersion !== 26 || signing.signCode !== true || signing.distribution !== "public artifact remains unsigned" || !verificationRecord || typeof verificationRecord !== "object" || Array.isArray(verificationRecord) || verificationRecord.verifyApp !== true || verificationRecord.verifyProfile !== true || !deviceAcceptanceRecord || typeof deviceAcceptanceRecord !== "object" || Array.isArray(deviceAcceptanceRecord) || deviceAcceptanceRecord.passed !== true || deviceAcceptanceRecord.acceptedHapSha256 !== acceptanceArtifact.sha256) {
    throw new Error("installed Piora mirror resource failed its release receipt");
  }
}
function selectDevEcoSigningMaterial(profile, productName = SIGNING_PRODUCT) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("DevEco build profile is invalid");
  }
  const app2 = profile.app;
  if (!app2 || typeof app2 !== "object" || Array.isArray(app2)) throw new Error("DevEco build profile has no app configuration");
  const products = app2.products;
  const configurations = app2.signingConfigs;
  if (!Array.isArray(products) || !Array.isArray(configurations)) {
    throw new Error("DevEco build profile has no generated signing configuration");
  }
  const matchingProducts = products.filter((product) => Boolean(product) && typeof product === "object" && !Array.isArray(product) && product.name === productName);
  if (matchingProducts.length !== 1) throw new Error("DevEco build profile has an ambiguous product");
  const signingConfig = matchingProducts[0].signingConfig;
  if (signingConfig !== productName) throw new Error("DevEco product does not reference its generated signing configuration");
  const matchingConfigurations = configurations.filter((configuration2) => Boolean(configuration2) && typeof configuration2 === "object" && !Array.isArray(configuration2) && configuration2.name === signingConfig);
  if (matchingConfigurations.length !== 1) throw new Error("DevEco build profile has an ambiguous signing configuration");
  const selected = matchingConfigurations[0];
  if (selected.type !== "HarmonyOS") throw new Error("DevEco signing configuration is not for HarmonyOS");
  return selected.material;
}
async function validateSigningMaterial(raw, configRoot) {
  const materialKeys = ["certpath", "keyAlias", "keyPassword", "profile", "signAlg", "storeFile", "storePassword"];
  if (!exactKeys(raw, materialKeys) || raw.keyAlias !== "debugKey" || raw.signAlg !== "SHA256withECDSA" || !isDevEcoProtectedPassword(raw.keyPassword) || !isDevEcoProtectedPassword(raw.storePassword)) {
    throw new Error("unsupported DevEco signing material");
  }
  const material = { ...raw };
  for (const [field, maximum] of [["certpath", 1024 * 1024], ["profile", 2 * 1024 * 1024], ["storeFile", 2 * 1024 * 1024]]) {
    const value = material[field];
    if (!isAbsolute4(value)) throw new Error("DevEco signing material path is not absolute");
    const actual = await realpath(value);
    if (!inside(configRoot, actual)) throw new Error("DevEco signing material leaves the config directory");
    await regularFile(actual, maximum);
    material[field] = actual;
  }
  return material;
}
async function readSigningDescriptor(requested, configRoot) {
  const actualDescriptor = await realpath(requested);
  if (!inside(configRoot, actualDescriptor)) throw new Error("signing descriptor leaves the DevEco config directory");
  const descriptor = await jsonFile(actualDescriptor, 64 * 1024);
  if (!exactKeys(descriptor, ["schemaVersion", "name", "type", "material"]) || descriptor.schemaVersion !== 1 || descriptor.name !== "pioraHarmonyDevice" || descriptor.type !== "HarmonyOS") {
    throw new Error("unsupported signing descriptor");
  }
  return { material: await validateSigningMaterial(descriptor.material, configRoot), configRoot };
}
async function signingTemplateRoot(sourceHapPath, environment, explicit) {
  const configured = explicit?.trim() || environment.PIORA_HARMONY_SIGNING_TEMPLATE_PATH?.trim();
  const candidates = configured ? [configured] : [
    join9(dirname5(sourceHapPath), "signing-project"),
    join9(process.cwd(), "third_party", "harmony-mirror")
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute4(candidate)) continue;
    try {
      const status = await lstat5(candidate);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("invalid signing template directory");
      return await realpath(candidate);
    } catch (error) {
      if (configured || !isMissing(error)) throw error;
    }
  }
  throw new Error("the Piora DevEco signing project template is unavailable");
}
async function validateSigningProject(projectRoot) {
  const [profile, appScope, moduleProfile] = await Promise.all([
    json5File(join9(projectRoot, "build-profile.json5"), 256 * 1024),
    json5File(join9(projectRoot, "AppScope", "app.json5"), 64 * 1024),
    json5File(join9(projectRoot, "entry", "src", "main", "module.json5"), 128 * 1024)
  ]);
  const profileRecord = profile;
  const app2 = profileRecord?.app;
  const products = app2?.products;
  const modules = profileRecord?.modules;
  const matchingProducts = Array.isArray(products) ? products.filter((product) => Boolean(product) && typeof product === "object" && !Array.isArray(product) && product.name === SIGNING_PRODUCT) : [];
  const matchingModules = Array.isArray(modules) ? modules.filter((module) => Boolean(module) && typeof module === "object" && !Array.isArray(module) && module.name === "entry" && module.srcPath === "./entry") : [];
  const application = appScope?.app;
  const moduleConfig = moduleProfile?.module;
  if (matchingProducts.length !== 1 || matchingModules.length !== 1 || application?.bundleName !== MIRROR_BUNDLE || moduleConfig?.name !== "entry" || moduleConfig?.type !== "entry") {
    throw new Error("the Piora DevEco signing project has an unexpected application identity");
  }
}
async function readSigningTemplate(templateRoot) {
  const files = /* @__PURE__ */ new Map();
  const hash = createHash4("sha256");
  for (const relativePath of SIGNING_TEMPLATE_FILES) {
    const source = resolve3(templateRoot, relativePath);
    if (!inside(templateRoot, source)) throw new Error("signing template path escaped its root");
    const bytes = await regularFile(source, 256 * 1024);
    files.set(relativePath, bytes);
    hash.update(relativePath).update("\0").update(bytes).update("\0");
  }
  return { digest: hash.digest("hex"), files };
}
async function writeSigningProjectFile(projectRoot, relativePath, bytes) {
  const destination = join9(projectRoot, relativePath);
  const actualDirectory = await requirePrivateDirectory(dirname5(destination));
  if (!inside(projectRoot, actualDirectory)) throw new Error("private signing project path escaped its root");
  try {
    const existing = await lstat5(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("private signing project file is invalid");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await writeFile2(destination, bytes, { mode: 384 });
  await chmod(destination, 384).catch(() => void 0);
}
async function refreshSigningProject(projectRoot, snapshot, preservedMaterial) {
  for (const relativePath of SIGNING_TEMPLATE_FILES) {
    let bytes = snapshot.files.get(relativePath);
    if (!bytes) throw new Error("signing template snapshot is incomplete");
    if (relativePath === "build-profile.json5" && preservedMaterial) {
      const profile = JSON5.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const app2 = profile.app;
      const products = app2.products;
      const product = products.find((candidate) => candidate.name === SIGNING_PRODUCT);
      if (!product) throw new Error("signing template has no default product");
      product.signingConfig = SIGNING_PRODUCT;
      app2.signingConfigs = [{ name: SIGNING_PRODUCT, type: "HarmonyOS", material: preservedMaterial }];
      bytes = Buffer.from(`${JSON.stringify(profile, null, 2)}
`, "utf8");
    }
    await writeSigningProjectFile(projectRoot, relativePath, bytes);
  }
  await rm3(join9(projectRoot, ".piora-device-profiles"), { recursive: true, force: true });
  await writeSigningProjectFile(projectRoot, SIGNING_TEMPLATE_FINGERPRINT, Buffer.from(`${snapshot.digest}
`, "utf8"));
}
async function currentTemplateFingerprint(projectRoot) {
  try {
    const value = (await regularFile(join9(projectRoot, SIGNING_TEMPLATE_FINGERPRINT), 128)).toString("utf8").trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
async function createSigningProject(templateRoot, cacheDirectory, configRoot) {
  const snapshot = await readSigningTemplate(templateRoot);
  const projectRoot = join9(cacheDirectory, SIGNING_PROJECT);
  try {
    const existing = await lstat5(projectRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("private DevEco signing project is invalid");
    const actualProjectRoot = await realpath(projectRoot);
    if (await currentTemplateFingerprint(actualProjectRoot) !== snapshot.digest) {
      let preservedMaterial;
      try {
        preservedMaterial = await validateSigningMaterial(selectDevEcoSigningMaterial(
          await json5File(join9(actualProjectRoot, "build-profile.json5"), 256 * 1024)
        ), configRoot);
      } catch {
      }
      await refreshSigningProject(actualProjectRoot, snapshot, preservedMaterial);
    }
    await validateSigningProject(actualProjectRoot);
    return actualProjectRoot;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = await mkdtemp2(join9(cacheDirectory, ".deveco-signing-project-"));
  try {
    await refreshSigningProject(temporary, snapshot);
    await validateSigningProject(temporary);
    try {
      await rename2(temporary, projectRoot);
    } catch (error) {
      if (!await lstat5(projectRoot).then((status) => status.isDirectory() && !status.isSymbolicLink()).catch(() => false)) throw error;
    }
  } finally {
    await rm3(temporary, { recursive: true, force: true });
  }
  await validateSigningProject(projectRoot);
  return await realpath(projectRoot);
}
async function resolveDevEcoCli(environment, explicit) {
  const configured = explicit?.trim() || environment.PIORA_DEVECO_CLI_PATH?.trim();
  if (configured) return await firstRegularFile([configured], 64 * 1024 * 1024);
  const runtimeRoot = environment.PIORA_WEB_RUNTIME_ROOT?.trim();
  return await firstRegularFile([
    runtimeRoot && isAbsolute4(runtimeRoot) ? join9(runtimeRoot, "node_modules", "@deveco", "deveco-cli", "dist", "cli.js") : void 0,
    join9(process.cwd(), "node_modules", "@deveco", "deveco-cli", "dist", "cli.js")
  ], 64 * 1024 * 1024);
}
async function markerIsCurrent(path) {
  try {
    return (await regularFile(path, 32)).toString("utf8") === "piora-device-profile-v1\n";
  } catch {
    return false;
  }
}
async function resolveLocalSigningMaterial(options) {
  const environment = options.environment ?? process.env;
  const userHome = environment.USERPROFILE?.trim() || homedir3();
  const configRoot = await requirePrivateDirectory(join9(userHome, ".ohos", "config"));
  const configuredDescriptor = options.descriptorPath?.trim() || environment.PIORA_HARMONY_SIGNING_CONFIG_PATH?.trim();
  if (configuredDescriptor) {
    if (!isAbsolute4(configuredDescriptor)) throw new Error("signing descriptor path is not absolute");
    return await readSigningDescriptor(resolve3(configuredDescriptor), configRoot);
  }
  const defaultDescriptor = join9(configRoot, SIGNING_DESCRIPTOR);
  try {
    return await readSigningDescriptor(defaultDescriptor, configRoot);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const cacheDirectory = await requirePrivateDirectory(resolve3(options.cacheDirectory));
  const templateRoot = await signingTemplateRoot(resolve3(options.sourceHapPath), environment, options.signingTemplatePath);
  const projectRoot = await createSigningProject(templateRoot, cacheDirectory, configRoot);
  const markerDirectory = join9(projectRoot, ".piora-device-profiles");
  const marker = join9(markerDirectory, `${sha256(options.deviceUdid.toLocaleLowerCase())}.verified`);
  if (!await markerIsCurrent(marker)) {
    const cliPath = await resolveDevEcoCli(environment, options.devecoCliPath);
    const executable = resolve3(options.runtimeExecutablePath ?? process.execPath);
    await (options.execute ?? runCommand)({
      executable,
      args: [cliPath, "signature", "generate", "--product", SIGNING_PRODUCT],
      cwd: projectRoot,
      env: {
        ...environment,
        DEVECO_CLI_DISABLE_TELEMETRY: "1",
        DEVECO_CLI_DISABLE_UPDATE: "1"
      },
      signal: options.signal,
      timeoutMs: 5 * 6e4,
      maxOutputBytes: 2 * 1024 * 1024,
      operation: "generate_local_mirror_signing_profile"
    });
  }
  await validateSigningProject(projectRoot);
  let material;
  try {
    material = await validateSigningMaterial(
      selectDevEcoSigningMaterial(await json5File(join9(projectRoot, "build-profile.json5"), 256 * 1024)),
      configRoot
    );
  } catch (error) {
    await rm3(marker, { force: true });
    throw error;
  }
  return { material, configRoot, verifiedMarker: marker };
}
function validateGeneratedMarkerPath(path) {
  const absolute = resolve3(path);
  if (!isAbsolute4(path) || basename3(dirname5(absolute)) !== ".piora-device-profiles" || !/^[0-9a-f]{64}\.verified$/.test(basename3(absolute))) {
    throw new Error("generated signing profile marker path is invalid");
  }
  return absolute;
}
async function markSigningMaterialVerified(path) {
  if (!path) return;
  if (await markerIsCurrent(path)) return;
  const actualPath = validateGeneratedMarkerPath(path);
  const directory = await requirePrivateDirectory(dirname5(actualPath));
  if (!inside(directory, actualPath)) throw new Error("signing profile marker leaves its private directory");
  const temporary = join9(directory, `.verified-${process.pid}-${Date.now()}.tmp`);
  await writeFile2(temporary, "piora-device-profile-v1\n", { encoding: "utf8", flag: "wx", mode: 384 });
  try {
    await rm3(actualPath, { force: true });
    await rename2(temporary, actualPath);
  } finally {
    await rm3(temporary, { force: true });
  }
}
async function invalidateSigningMaterialMarker(path) {
  if (!path) return;
  await rm3(validateGeneratedMarkerPath(path), { force: true });
}
async function runWithSigningMaterialRecovery(verifiedMarker, operation) {
  try {
    return await operation();
  } catch (error) {
    const cancelled = isHarmonyError(error) && error.code === "COMMAND_ABORTED" || error instanceof DOMException && error.name === "AbortError";
    if (!cancelled) await invalidateSigningMaterialMarker(verifiedMarker);
    throw error;
  }
}
function certificateBlocks(bytes) {
  return (bytes.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((value) => new X509Certificate(value));
}
function validateProfile(result, deviceUdid, expectedCertificate, now = Date.now()) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("profile verification result is invalid");
  const verified = result;
  const profile = verified.content;
  const info = profile?.["bundle-info"];
  const debug = profile?.["debug-info"];
  const validity = profile?.validity;
  const acls = profile?.acls?.["allowed-acls"];
  const restricted = profile?.permissions?.["restricted-permissions"];
  const ids = debug?.["device-ids"];
  if (verified.verifiedPassed !== true || verified.message !== "OK" || profile?.type !== "debug" || profile.issuer !== "app_gallery" || info?.["bundle-name"] !== MIRROR_BUNDLE || info.apl !== "normal" || info["app-feature"] !== "hos_normal_app" || acls !== void 0 && (!Array.isArray(acls) || acls.length !== 0) || restricted !== void 0 && (!Array.isArray(restricted) || restricted.length !== 0) || profile["app-privilege-capabilities"] !== void 0 || debug?.["device-id-type"] !== "udid" || !Array.isArray(ids) || !ids.some((value) => typeof value === "string" && value.toLocaleLowerCase() === deviceUdid.toLocaleLowerCase())) {
    throw new Error("DevEco profile is not valid for this ordinary app and connected phone");
  }
  const notBefore = validity?.["not-before"];
  const notAfter = validity?.["not-after"];
  const certificateFrom = new Date(expectedCertificate.validFrom).getTime();
  const certificateTo = new Date(expectedCertificate.validTo).getTime();
  if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(notAfter) || Number(notBefore) * 1e3 > now || Number(notAfter) * 1e3 <= now || Number(notBefore) * 1e3 < certificateFrom || Number(notAfter) * 1e3 > certificateTo) {
    throw new Error("DevEco profile or certificate is not currently valid");
  }
  let embedded;
  try {
    embedded = new X509Certificate(String(info["development-certificate"]));
  } catch {
    throw new Error("DevEco profile has no valid development certificate");
  }
  if (!embedded.raw.equals(expectedCertificate.raw)) throw new Error("DevEco profile and application certificate differ");
}
async function runVerification(execute, tools, signedHap, profilePath, certificatePath, deviceUdid, temporary, signal) {
  const extractedCertificate = join9(temporary, "certificate.cer");
  const extractedProfile = join9(temporary, "profile.p7b");
  const profileJson = join9(temporary, "profile.json");
  const base = { executable: tools.java, timeoutMs: 6e4, maxOutputBytes: 4 * 1024 * 1024, signal, cwd: temporary };
  await execute({ ...base, args: [
    "-jar",
    tools.signTool,
    "verify-app",
    "-inFile",
    signedHap,
    "-outCertChain",
    extractedCertificate,
    "-outProfile",
    extractedProfile
  ], operation: "verify_local_mirror_signature" });
  await execute({ ...base, args: [
    "-jar",
    tools.signTool,
    "verify-profile",
    "-inFile",
    extractedProfile,
    "-outFile",
    profileJson
  ], operation: "verify_local_mirror_profile" });
  const [expectedCertificates, actualCertificates, configuredProfile, extractedProfileBytes] = await Promise.all([
    regularFile(certificatePath, 1024 * 1024).then(certificateBlocks),
    regularFile(extractedCertificate, 1024 * 1024).then(certificateBlocks),
    regularFile(profilePath, 2 * 1024 * 1024),
    regularFile(extractedProfile, 2 * 1024 * 1024)
  ]);
  const expectedLeaf = expectedCertificates.find((certificate) => !certificate.ca);
  const actualLeaf = actualCertificates.find((certificate) => !certificate.ca);
  if (!expectedLeaf || !actualLeaf || !expectedLeaf.raw.equals(actualLeaf.raw) || sha256(configuredProfile) !== sha256(extractedProfileBytes)) {
    throw new Error("local signed HAP does not contain the selected DevEco identity");
  }
  validateProfile(await jsonFile(profileJson, 2 * 1024 * 1024), deviceUdid, expectedLeaf);
}
async function readVerifiedCachedMirrorHap(cacheHap, cacheReceipt, expected, verify) {
  try {
    const receipt = await jsonFile(cacheReceipt, 64 * 1024);
    if (!exactKeys(receipt, ["schemaVersion", "publicSha256", "materialSha256", "deviceSha256", "signedSha256"]) || receipt.schemaVersion !== 1 || receipt.publicSha256 !== expected.publicSha256 || receipt.materialSha256 !== expected.materialSha256 || receipt.deviceSha256 !== expected.deviceSha256 || !/^[0-9a-f]{64}$/.test(String(receipt.signedSha256))) return;
    const signedBytes = await regularFile(cacheHap, MAX_HAP_BYTES);
    if (sha256(signedBytes) !== receipt.signedSha256) return;
    await verify(cacheHap);
    return cacheHap;
  } catch (error) {
    if (isHarmonyError(error) && error.code === "COMMAND_ABORTED" || error instanceof DOMException && error.name === "AbortError") throw error;
    return void 0;
  }
}
async function prepare(options) {
  const environment = options.environment ?? process.env;
  if (!/^[0-9a-f]{64}$/i.test(options.deviceUdid)) throw new Error("connected phone returned an invalid UDID");
  const sourceHap = resolve3(options.sourceHapPath);
  const sourceBytes = await regularFile(sourceHap, MAX_HAP_BYTES);
  try {
    const publicReceipt = await jsonFile(join9(dirname5(sourceHap), "harmony-mirror-signature-verification.json"), 1024 * 1024);
    validatePublicMirrorReceipt(publicReceipt, sourceBytes);
  } catch (cause) {
    throw new HarmonyError("CAPABILITY_UNAVAILABLE", isMissing(cause) ? "\u5B9E\u65F6\u89C6\u9891\u7EC4\u4EF6\u7F3A\u5C11\u968F\u5305\u6821\u9A8C\u6587\u4EF6\uFF0C\u9700\u8981\u8865\u9F50\u5339\u914D\u7684\u6295\u5C4F\u8D44\u6E90\uFF1B\u767B\u5F55\u5F00\u53D1\u8005\u8D26\u53F7\u4E0D\u80FD\u4FEE\u590D\u8D44\u6E90\u7F3A\u5931\u3002\u514D\u5B89\u88C5\u622A\u56FE\u9884\u89C8\u548C AI \u64CD\u4F5C\u53EF\u7EE7\u7EED\u4F7F\u7528\u3002" : "\u5B9E\u65F6\u89C6\u9891\u7EC4\u4EF6\u4E0E\u968F\u5305\u6821\u9A8C\u8BB0\u5F55\u4E0D\u5339\u914D\uFF0C\u672A\u53D1\u9001\u5B89\u88C5\u547D\u4EE4\u3002\u8BF7\u4F7F\u7528\u5B8C\u6574\u3001\u5339\u914D\u7684\u6295\u5C4F\u8D44\u6E90\u3002", {
      cause,
      details: { reason: isMissing(cause) ? "mirror-release-resources-missing" : "mirror-release-resources-invalid", dispatchState: "not-sent" }
    });
  }
  const preview = await previewHapArtifact(sourceHap, options.signal);
  if (preview.bundleName !== MIRROR_BUNDLE || preview.versionCode === void 0 || preview.versionName === void 0 || !preview.abilities.includes("EntryAbility")) throw new Error("installed Piora mirror resource is invalid");
  const [signing, tools] = await Promise.all([
    resolveLocalSigningMaterial({
      cacheDirectory: options.cacheDirectory,
      descriptorPath: options.descriptorPath,
      devecoCliPath: options.devecoCliPath,
      deviceUdid: options.deviceUdid,
      environment,
      execute: options.execute,
      runtimeExecutablePath: options.runtimeExecutablePath,
      signingTemplatePath: options.signingTemplatePath,
      signal: options.signal,
      sourceHapPath: sourceHap
    }),
    resolveSigningTools(options.hdcPath, environment)
  ]);
  const { material, verifiedMarker } = signing;
  return await runWithSigningMaterialRecovery(verifiedMarker, async () => {
    const [profileBytes, certificateBytes, storeBytes, signToolBytes, signerBytes] = await Promise.all([
      regularFile(material.profile, 2 * 1024 * 1024),
      regularFile(material.certpath, 1024 * 1024),
      regularFile(material.storeFile, 2 * 1024 * 1024),
      regularFile(tools.signTool, 64 * 1024 * 1024),
      regularFile(tools.signerSource, 64 * 1024)
    ]);
    const publicSha256 = sha256(sourceBytes);
    const deviceSha256 = sha256(options.deviceUdid.toLocaleLowerCase());
    const materialSha256 = createHash4("sha256").update(profileBytes).update(certificateBytes).update(storeBytes).update(signToolBytes).update(signerBytes).update(material.keyAlias + "\0" + material.signAlg).digest("hex");
    profileBytes.fill(0);
    certificateBytes.fill(0);
    storeBytes.fill(0);
    await mkdir2(options.cacheDirectory, { recursive: true, mode: 448 });
    const cacheStatus = await lstat5(options.cacheDirectory);
    if (!cacheStatus.isDirectory() || cacheStatus.isSymbolicLink()) throw new Error("private mirror cache is invalid");
    await chmod(options.cacheDirectory, 448).catch(() => void 0);
    const cacheKey = sha256(`${publicSha256}\0${materialSha256}\0${deviceSha256}`);
    const cacheHap = join9(options.cacheDirectory, `mirror-${cacheKey}.hap`);
    const cacheReceipt = `${cacheHap}.json`;
    const expected = { publicSha256, materialSha256, deviceSha256 };
    const cachedVerification = await mkdtemp2(join9(options.cacheDirectory, `.checking-${cacheKey.slice(0, 12)}-`));
    let cached;
    try {
      cached = await readVerifiedCachedMirrorHap(
        cacheHap,
        cacheReceipt,
        expected,
        async (path) => await runWithSigningMaterialRecovery(
          verifiedMarker,
          async () => await runVerification(
            options.execute ?? runCommand,
            tools,
            path,
            material.profile,
            material.certpath,
            options.deviceUdid,
            cachedVerification,
            options.signal
          )
        )
      );
    } finally {
      await rm3(cachedVerification, { recursive: true, force: true });
    }
    if (cached) {
      await markSigningMaterialVerified(verifiedMarker);
      return cached;
    }
    await rm3(cacheHap, { force: true });
    await rm3(cacheReceipt, { force: true });
    const temporary = await mkdtemp2(join9(options.cacheDirectory, `.signing-${cacheKey.slice(0, 12)}-`));
    const unsignedTemporary = join9(temporary, "unsigned.hap");
    const signedTemporary = join9(temporary, "signed.hap");
    let keyPassword;
    let storePassword;
    try {
      await writeFile2(unsignedTemporary, sourceBytes, { flag: "wx", mode: 384 });
      const copiedPreview = await previewHapArtifact(unsignedTemporary, options.signal);
      if (copiedPreview.bundleName !== preview.bundleName || copiedPreview.versionCode !== preview.versionCode || copiedPreview.versionName !== preview.versionName || copiedPreview.moduleName !== preview.moduleName) {
        throw new Error("public mirror resource changed while preparing its private signature");
      }
      [keyPassword, storePassword] = await Promise.all([
        decryptDevEcoProtectedPassword(dirname5(material.storeFile), material.keyPassword),
        decryptDevEcoProtectedPassword(dirname5(material.storeFile), material.storePassword)
      ]);
      await (options.signHap ?? signHapWithJava)({
        javaPath: tools.java,
        signToolPath: tools.signTool,
        signerSourcePath: tools.signerSource,
        keyAlias: material.keyAlias,
        keyPassword,
        certificatePath: material.certpath,
        profilePath: material.profile,
        inputPath: unsignedTemporary,
        signAlgorithm: material.signAlg,
        storePath: material.storeFile,
        storePassword,
        outputPath: signedTemporary,
        compatibleVersion: 26,
        cwd: temporary,
        env: environment,
        signal: options.signal,
        timeoutMs: 12e4
      });
      keyPassword = void 0;
      storePassword = void 0;
      const signedBytes = await regularFile(signedTemporary, MAX_HAP_BYTES);
      const signedPreview = await previewHapArtifact(signedTemporary, options.signal);
      if (signedPreview.bundleName !== preview.bundleName || signedPreview.versionCode !== preview.versionCode || signedPreview.versionName !== preview.versionName || signedPreview.moduleName !== preview.moduleName) {
        throw new Error("local signing changed the mirror application identity");
      }
      await runVerification(
        options.execute ?? runCommand,
        tools,
        signedTemporary,
        material.profile,
        material.certpath,
        options.deviceUdid,
        temporary,
        options.signal
      );
      const signedSha256 = sha256(signedBytes);
      await chmod(signedTemporary, 384).catch(() => void 0);
      await rename2(signedTemporary, cacheHap);
      await writeFile2(
        cacheReceipt,
        `${JSON.stringify({ schemaVersion: 1, ...expected, signedSha256 }, null, 2)}
`,
        { encoding: "utf8", flag: "wx", mode: 384 }
      );
      await markSigningMaterialVerified(verifiedMarker);
      return cacheHap;
    } finally {
      keyPassword = void 0;
      storePassword = void 0;
      await rm3(temporary, { recursive: true, force: true });
    }
  });
}
async function prepareLocalMirrorHap(options) {
  if (options.signal?.aborted) {
    throw new HarmonyError("COMMAND_ABORTED", "Harmony HAP signing was cancelled", {
      retryable: true,
      details: { reason: "mirror-local-signing-cancelled", dispatchState: "not-sent" }
    });
  }
  const key = `${resolve3(options.sourceHapPath)}\0${sha256(options.deviceUdid.toLocaleLowerCase())}\0${resolve3(options.cacheDirectory)}`;
  const existing = signingJobs().get(key);
  if (existing) return await existing;
  const task = prepare(options).catch((cause) => {
    if (isHarmonyError(cause) && ["mirror-release-resources-missing", "mirror-release-resources-invalid"].includes(String(cause.details?.reason))) throw cause;
    if (isHarmonyError(cause) && cause.code === "COMMAND_ABORTED") throw cause;
    if (options.signal?.aborted || cause instanceof DOMException && cause.name === "AbortError") {
      throw new HarmonyError("COMMAND_ABORTED", "Harmony HAP signing was cancelled", {
        cause,
        retryable: true,
        details: { reason: "mirror-local-signing-cancelled", dispatchState: "not-sent" }
      });
    }
    const sdkMissing = cause instanceof Error && cause.message === "local HarmonyOS API 26 signing SDK is unavailable";
    throw new HarmonyError(
      "CAPABILITY_UNAVAILABLE",
      sdkMissing ? "\u9AD8\u6E05\u89C6\u9891\u7EC4\u4EF6\u9700\u8981 HarmonyOS API 26 \u7B7E\u540D SDK\uFF0C\u5F53\u524D\u672C\u673A SDK \u4E0D\u517C\u5BB9\u3002\u53EF\u7EE7\u7EED\u4F7F\u7528\u514D\u5B89\u88C5\u622A\u56FE\u9884\u89C8\u548C AI \u8BED\u4E49\u64CD\u4F5C\u3002" : "dshHarmony could not create the private Harmony video component. Check DevEco signing configuration; screenshot preview and AI semantic control remain available.",
      { cause, details: { reason: sdkMissing ? "mirror-sdk-incompatible" : "mirror-local-signing-unavailable", dispatchState: "not-sent" } }
    );
  }).finally(() => signingJobs().delete(key));
  signingJobs().set(key, task);
  return await task;
}

// vendor/lib/harmony/log-stream.ts
import { spawn as spawn4 } from "node:child_process";
function streamHdcLines(executable, args, onLines, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve6, reject) => {
    const child = spawn4(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "", stderr = "", settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      child.kill();
      if (error && !signal?.aborted) reject(error);
      else resolve6();
    };
    const abort = () => finish();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      if (pending.length > 65536) {
        lines.push(pending.slice(0, 65536));
        pending = "";
      }
      try {
        if (lines.length) onLines(lines.map((line) => line.slice(0, 65536)));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.on("error", (error) => finish(new HarmonyError("COMMAND_FAILED", `\u65E0\u6CD5\u542F\u52A8\u8BBE\u5907\u65E5\u5FD7\uFF1A${error.message}`, { retryable: true })));
    child.on("close", (code) => {
      if (settled) return;
      finish(new HarmonyError("COMMAND_FAILED", `\u8BBE\u5907\u65E5\u5FD7\u8FDE\u63A5\u5DF2\u7ED3\u675F (${code ?? "closed"})${stderr ? `: ${stderr}` : ""}`, { retryable: true }));
    });
  });
}

// vendor/lib/harmony/contracts/actions.ts
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
var string = (maxLength = 512) => Type.String({ minLength: 1, maxLength });
var optional = Type.Optional;
var number = (minimum, maximum) => Type.Number({ minimum, maximum });
var values = (items) => Type.Union(items.map((item) => Type.Literal(item)));
var keyNames = ["back", "home", "recents", "enter"];
var keySchema = values([...keyNames]);
var selectorFields = {
  id: optional(string()),
  text: optional(string()),
  type: optional(string()),
  hint: optional(string()),
  description: optional(string()),
  inWindow: optional(string()),
  match: optional(values(["exact", "contains", "starts_with", "ends_with"])),
  index: optional(Type.Integer({ minimum: 0, maximum: 999 })),
  ...Object.fromEntries(["clickable", "scrollable", "enabled", "focused", "selected", "checked", "visible"].map((key) => [key, optional(Type.Boolean())]))
};
var selectorSchema = Type.Object({
  ...selectorFields,
  within: optional(Type.Object(selectorFields)),
  before: optional(Type.Object(selectorFields)),
  after: optional(Type.Object(selectorFields))
});
var conditionSchema = Type.Object({
  selector: selectorSchema,
  exists: optional(Type.Boolean()),
  timeoutMs: optional(number(100, 6e4)),
  intervalMs: optional(number(100, 5e3))
});
var wait = { waitFor: optional(conditionSchema) };
var semantic = { selector: selectorSchema, ...wait };
var point = { x: number(0, 1e5), y: number(0, 1e5) };
var coordinates = { coordinateSpace: optional(values(["native", "frame"])), geometryId: optional(string(128)), generation: optional(Type.Integer({ minimum: 0 })) };
var gesture = { fromX: point.x, fromY: point.y, toX: point.x, toY: point.y, durationMs: optional(number(50, 1e4)), ...coordinates };
var app = { bundleName: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.]{0,255}$" }) };
var actionCatalog = {
  prepare_device: { description: "Wake a sleeping phone and dismiss a password-free lock screen; verify unlocked state without entering credentials", risk: "control", direct: {} },
  tap: { description: "Tap one fresh semantic target or an explicit geometry point", risk: "control", scenario: semantic, direct: { ...point, ...coordinates } },
  double_tap: { description: "Double tap a target", risk: "control", scenario: semantic, direct: { ...point, ...coordinates } },
  long_press: { description: "Provider-defined short long press; not continuous touch hold", risk: "control", scenario: semantic, direct: { ...point, ...coordinates } },
  tap_ref: { description: "Revalidate a retained reference against a fresh complete tree", risk: "control", direct: { ref: string(256), generation: Type.Integer({ minimum: 0 }) } },
  input_text: { description: "Set or append semantic text and verify exact readback", risk: "control", scenario: { ...semantic, text: string(8192), append: optional(Type.Boolean()) }, direct: { text: string(8192) } },
  clear_text: { description: "Clear semantic text and verify empty readback", risk: "control", scenario: semantic },
  scroll_find: { description: "Find within a bounded directional swipe budget", risk: "control", scenario: { ...semantic, container: optional(selectorSchema), direction: optional(values(["up", "down"])), maxSwipes: optional(Type.Integer({ minimum: 1, maximum: 30 })), tap: optional(Type.Boolean()) } },
  swipe: { description: "Bounded swipe", risk: "control", scenario: { direction: values(["up", "down", "left", "right"]), durationMs: gesture.durationMs, ...wait }, direct: gesture },
  fling: { description: "Fling using an explicit provider", risk: "control", scenario: { direction: values(["up", "down", "left", "right"]), durationMs: gesture.durationMs, ...wait }, direct: gesture },
  drag: { description: "Drag between geometry points", risk: "control", direct: gesture },
  press_key: { description: "Press a supported logical key", risk: "control", scenario: { key: keySchema, ...wait }, direct: { key: keySchema } },
  key_hold: { description: "Hold an exact calibrated physical key duration with bounded release", risk: "control", direct: { key: values(["power", "volume_up", "volume_down"]), durationMs: Type.Integer({ minimum: 50, maximum: 5e3 }) } },
  open_assistant: { description: "Use a device-bound power-key profile and verify its calibrated assistant postcondition", risk: "control", direct: { profileId: string(64) } },
  touch_hold: { description: "Continuous calibrated touch with geometry and focus monitoring", risk: "control", direct: { ...point, ...coordinates, geometryId: string(128), durationMs: Type.Integer({ minimum: 50, maximum: 15e3 }) } },
  voice_input: { description: "Play an immutable asset over a calibrated acoustic route and verify the phone transcript", risk: "control", direct: { audioAssetId: string(64), profileId: string(64), requiredMode: optional(Type.Union([Type.Literal("tap"), Type.Literal("push-to-talk")])), timeoutMs: optional(Type.Integer({ minimum: 1e3, maximum: 6e4 })), geometryId: optional(string(128)) }, scenario: { audioAssetId: string(64), profileId: string(64), requiredMode: optional(Type.Union([Type.Literal("tap"), Type.Literal("push-to-talk")])), timeoutMs: optional(Type.Integer({ minimum: 1e3, maximum: 6e4 })), geometryId: optional(string(128)) } },
  geometry_assert: { description: "Verify native display rotation against a newly captured screenshot", risk: "read", scenario: { rotation: Type.Union([Type.Literal(0), Type.Literal(90), Type.Literal(180), Type.Literal(270)]) } },
  launch_app: { description: "Launch a bundle and optional ability", risk: "control", scenario: { ...app, abilityName: optional(string(256)), ...wait }, direct: { ...app, abilityName: optional(string(256)) } },
  stop_app: { description: "Stop the selected application", risk: "control", scenario: app, direct: app },
  clear_app_data: { description: "Clear data of the selected application", risk: "control", scenario: app, direct: app },
  clear_app_cache: { description: "Clear cache of the selected application for the active user", risk: "control", direct: app },
  uninstall_app: { description: "Uninstall the selected application", risk: "control", scenario: app, direct: app },
  enable_app: { description: "Enable an app for the active user on a root device build", risk: "control", direct: app },
  disable_app: { description: "Disable an app for the active user on a root device build", risk: "control", direct: app },
  install_app: { description: "Install an integrity-checked immutable HAP", risk: "control", scenario: { hapPath: string(4096), replace: optional(Type.Boolean()) }, direct: { hapPath: string(4096), replace: optional(Type.Boolean()), expectedHash: optional(Type.String({ pattern: "^[a-f0-9]{64}$" })) } },
  upload_file: { description: "Upload an immutable local file into a writable device path", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), sourcePath: string(4096), path: string(4096), overwrite: optional(Type.Boolean()) } },
  create_directory: { description: "Create one device directory without creating parents", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096) } },
  delete_path: { description: "Delete one regular device file or empty directory", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096) } },
  rename_path: { description: "Rename one device file or directory without overwriting", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096), newPath: string(4096) } },
  copy_path: { description: "Copy one regular device file or bounded directory to a new path, verifying contents before publishing", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096), newPath: string(4096) } },
  move_path: { description: "Move one regular device file or bounded directory, verifying the destination before removing its source", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096), newPath: string(4096) } },
  chmod_path: { description: "Set three-digit octal permissions on one regular device file or directory", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096), mode: Type.String({ pattern: "^[0-7]{3}$" }) } },
  initialize_mirror: { description: "Initialize the capture component on request; never unlock", risk: "control", direct: {} },
  wait_for: { description: "Wait for a valid semantic observation", risk: "read", scenario: { condition: conditionSchema } },
  assert: { description: "Assert a valid semantic observation", risk: "read", scenario: { condition: conditionSchema } },
  wait_idle: { description: "Report driver idle or explicitly bounded delay", risk: "read", scenario: { idleMs: optional(number(50, 1e4)), timeoutMs: optional(number(50, 6e4)) } },
  checkpoint: { description: "Persist an explicit execution boundary", risk: "read", scenario: { name: string(120) } },
  capture_screenshot: { description: "Save a fresh device screenshot as a local execution artifact", risk: "read", scenario: { name: optional(string(120)) } },
  stop_device: { description: "Fence and stop only the selected device", risk: "control", direct: {} },
  emergency_stop: { description: "Fence and stop all devices", risk: "control", direct: { reason: optional(string(160)) } }
};
var scenarioStepSchema = (() => {
  const definitions = Object.entries(actionCatalog).filter(([, definition]) => "scenario" in definition);
  const fields = {};
  for (const [, definition] of definitions) for (const [key, schema] of Object.entries(definition.scenario)) {
    fields[key] = optional(schema);
  }
  fields.direction = optional(values(["up", "down", "left", "right"]));
  return Type.Object({ id: optional(string(120)), action: values(definitions.map(([name]) => name)), ...fields });
})();

// vendor/lib/harmony/capabilities/probes.ts
function capabilitiesFromHelp(help, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const commands = { tap: "click", tap_ref: "click", double_tap: "doubleClick", long_press: "longClick", swipe: "swipe", drag: "drag", fling: "fling", press_key: "keyEvent" };
  return Object.entries(actionCatalog).map(([action]) => {
    let status = "unknown";
    let reason = "No verified provider evidence for this action on this device";
    let evidence = "declared";
    if (["key_hold", "touch_hold", "voice_input", "open_assistant"].includes(action)) {
      status = "needs-calibration";
      reason = "Requires device/version-specific release or acoustic calibration; registration is not physical verification";
    } else if (commands[action]) {
      if (help.input) {
        status = new RegExp(`\\b${commands[action]}\\b`).test(help.input) ? "supported" : "unsupported";
        evidence = "probed";
        reason = status === "supported" ? "Present in the device's UiTest help; physical effect is not yet verified" : "Not advertised by the device's UiTest help";
      }
    } else if (["wait_for", "assert", "scroll_find"].includes(action) && help.uitest?.includes("dumpLayout")) {
      status = "supported";
      evidence = "probed";
      reason = "Layout command present; each observation must still pass quality checks";
    } else if (["stop_device", "emergency_stop", "checkpoint"].includes(action)) {
      status = "supported";
      reason = "Host runtime operation";
    }
    return { action, status, reason, provider: commands[action] ? "hdc-uitest" : "piora", evidence, probedAt: now };
  });
}

// vendor/lib/harmony/input/key-catalog.ts
var physicalKeys = { power: 18, volume_up: 16, volume_down: 17 };
function physicalKeyCode(key) {
  if (!Object.prototype.hasOwnProperty.call(physicalKeys, key)) throw new Error("Unsupported physical key");
  return physicalKeys[key];
}

// vendor/lib/harmony/observation/screen-state.ts
function parseScreenState(output) {
  const value = (key) => new RegExp(`^\\s*(?:\\*\\s*)?${key}\\s+(true|false|\\d+)\\b`, "im").exec(output)?.[1];
  const on = value("screenState"), interactive = value("interactiveState"), locked = value("screenLocked");
  return { awake: on === "true" && interactive === "2", locked: locked === "true" ? true : locked === "false" ? false : void 0 };
}

// vendor/lib/harmony/hdc-backend.ts
import { setTimeout as delay } from "node:timers/promises";

// vendor/lib/harmony/input/bounded-hold.ts
async function runBoundedHold(options) {
  if (!Number.isInteger(options.durationMs) || options.durationMs < options.minMs || options.durationMs > options.maxMs) {
    throw new HarmonyError("INVALID_ARGUMENT", `Hold duration must be within the calibrated range ${options.minMs}\u2013${options.maxMs} ms`, { details: { dispatchState: "not-sent" } });
  }
  if (options.signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Hold cancelled before dispatch", { details: { dispatchState: "not-sent" } });
  try {
    await options.dispatch(options.signal);
    return { cleanup: "complete" };
  } catch (error) {
    const original = asHarmonyError(error);
    try {
      await options.release();
    } catch {
      throw new HarmonyError(original.code, "Hold interrupted and release could not be confirmed; inspect the device manually", { details: { dispatchState: "unknown", cleanup: "uncertain" } });
    }
    throw new HarmonyError(original.code, original.message, { details: { ...original.details, dispatchState: "unknown", cleanup: "complete" } });
  }
}

// vendor/lib/harmony/observation/window-scope.ts
function focusedWindowId(dump) {
  const matches = [...dump.matchAll(/^\s*Focus window:\s*(\d+)\s*$/gm)];
  return matches.length === 1 ? matches[0][1] : void 0;
}
function windowBundle(dump, windowId) {
  const id = dump.match(/^\s*WinId:\s*(\d+)\s*$/m)?.[1];
  const bundles = [...dump.matchAll(/^\s*bundleName:\s*([A-Za-z][A-Za-z0-9_.]{0,255})\s*$/gm)];
  return id === windowId && bundles.length === 1 ? bundles[0][1] : void 0;
}

// vendor/lib/harmony/observation/applications.ts
var identifier2 = /^[A-Za-z][A-Za-z0-9_.]{0,255}$/;
function applicationFacts(data, bundleName) {
  const candidate = data.applicationInfo;
  const info = candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate.bundleName === bundleName || candidate.name === bundleName) ? candidate : data;
  const bool = (...values2) => {
    const known = values2.filter((value) => typeof value === "boolean");
    return known.length && known.every((value) => value === known[0]) ? known[0] : void 0;
  };
  const system = bool(info.isSystemApp, info.systemApp);
  const removable = bool(info.removable), enabled = bool(info.enabled), debug = bool(info.debug);
  const clearable = bool(info.userDataClearable, typeof info.dataUnclearable === "boolean" ? !info.dataUnclearable : void 0);
  const text2 = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value : void 0;
  const installSource = text2(info.installSource), process2 = text2(info.process);
  return {
    ...system !== void 0 ? { isSystemApp: system } : {},
    ...removable !== void 0 ? { removable } : {},
    ...clearable !== void 0 ? { dataClearable: clearable } : {},
    ...enabled !== void 0 ? { enabled } : {},
    ...debug !== void 0 ? { debug } : {},
    ...info.appProvisionType === "debug" || info.appProvisionType === "release" ? { provisionType: info.appProvisionType } : {},
    ...installSource ? { installSource } : {},
    ...process2 && /^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(process2) ? { process: process2 } : {}
  };
}
function parseApplicationLabels(output) {
  try {
    const start = output.indexOf("["), end = output.lastIndexOf("]");
    const rows = JSON.parse(output.slice(start, end + 1));
    if (!Array.isArray(rows) || rows.length > 5e3) throw new Error("Invalid list");
    return rows.flatMap((row) => row && typeof row.bundleName === "string" && identifier2.test(row.bundleName) ? [{ bundleName: row.bundleName, ...typeof row.label === "string" ? { label: row.label.slice(0, 512) } : {}, ...applicationFacts(row, row.bundleName), source: "bm-label" }] : []);
  } catch {
    throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This device cannot provide application labels; search bundle identifiers instead");
  }
}
function parseBundleList(output) {
  const names2 = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => identifier2.test(line) && line.includes("."));
  if (!names2.length || names2.length > 5e3) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The installed application list is unavailable");
  return [...new Set(names2)].map((bundleName) => ({ bundleName, source: "bm-bundle" }));
}
function parseApplicationAbilities(output, bundleName) {
  try {
    const data = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
    if (data.name !== bundleName && data.applicationInfo?.bundleName !== bundleName && data.bundleName !== bundleName) throw new Error("Bundle identity differs");
    const abilities = [...data.abilityInfos ?? [], ...(data.hapModuleInfos ?? []).flatMap((module) => module.abilityInfos ?? [])];
    return [...new Set(abilities.filter((item) => {
      const visibility = [item.exported, item.visible].filter((value) => value !== void 0);
      return visibility.length > 0 && visibility.every((value) => value === true) && item.enabled !== false && typeof item.name === "string" && identifier2.test(item.name);
    }).map((item) => item.name))].sort();
  } catch {
    throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The application ability list could not be verified");
  }
}
function parseApplicationDetails(output, bundleName) {
  let data;
  try {
    data = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
    if (data.name !== bundleName && data.bundleName !== bundleName && data.applicationInfo?.bundleName !== bundleName) throw new Error("Bundle identity differs");
  } catch {
    throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The application details could not be verified");
  }
  const text2 = (value) => typeof value === "string" && value.length <= 512 ? value : void 0;
  const numeric = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
  const permissions = Array.isArray(data.reqPermissions) ? data.reqPermissions : [];
  return {
    bundleName,
    source: "bm-bundle",
    abilities: parseApplicationAbilities(output, bundleName),
    versionName: text2(data.versionName),
    versionCode: numeric(data.versionCode),
    installTime: numeric(data.installTime),
    updateTime: numeric(data.updateTime),
    ...applicationFacts(data, bundleName),
    requestedPermissions: [...new Set(permissions.flatMap((item) => {
      const name = typeof item === "string" ? item : item && typeof item === "object" ? item.name : void 0;
      return typeof name === "string" && /^ohos\.permission\.[A-Z0-9_]{1,120}$/.test(name) ? [name] : [];
    }))].slice(0, 200)
  };
}

// vendor/lib/harmony/device-files.ts
import { posix as posix2 } from "node:path";
var DEVICE_FILE_PAGE_SIZE = 500;
function validateDeviceFileOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 5e4 || value % DEVICE_FILE_PAGE_SIZE !== 0) {
    throw new HarmonyError("INVALID_ARGUMENT", "Device file page offset must be a multiple of 500 between 0 and 50000");
  }
  return value;
}
var bundlePattern = /^[A-Za-z][A-Za-z0-9_.]{0,255}$/;
function validateDeviceFilePath(scope, value) {
  if (scope.kind === "sandbox" && !bundlePattern.test(scope.bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid sandbox bundle name");
  if (typeof value !== "string" || value.length > 4096 || /[\0-\x1f\x7f]/.test(value) || value.includes("\\")) {
    throw new HarmonyError("INVALID_ARGUMENT", "Invalid device file path");
  }
  const components = value.split("/");
  if (components.includes("..")) throw new HarmonyError("INVALID_ARGUMENT", "Device path traversal is unavailable");
  if (scope.kind === "shared") {
    if (!value.startsWith("/")) throw new HarmonyError("INVALID_ARGUMENT", "Shared device paths must be absolute");
    return posix2.normalize(value);
  }
  if (value.startsWith("/")) throw new HarmonyError("INVALID_ARGUMENT", "Sandbox paths must be relative to the debug app");
  const normalized2 = posix2.normalize(value || ".");
  if (normalized2 !== "." && !normalized2.startsWith("data/storage/")) {
    throw new HarmonyError("INVALID_ARGUMENT", "Sandbox browsing is limited to data/storage");
  }
  return normalized2;
}
function validateWritableDeviceFilePath(scope, value) {
  const normalized2 = validateDeviceFilePath(scope, value);
  if (scope.kind === "sandbox") {
    if (!normalized2.startsWith("data/storage/") || normalized2.endsWith("/")) {
      throw new HarmonyError("INVALID_ARGUMENT", "Choose a file within the debug app storage");
    }
  } else if (!normalized2.startsWith("/data/local/tmp/") && !normalized2.startsWith("/sdcard/") && !normalized2.startsWith("/storage/") && !/^\/mnt\/data\/\d+\/media_fuse\//.test(normalized2)) {
    throw new HarmonyError("INVALID_ARGUMENT", "Device writes are limited to temporary or shared media paths");
  }
  if (normalized2.endsWith("/")) throw new HarmonyError("INVALID_ARGUMENT", "Choose a file, not a directory");
  return normalized2;
}
function quoteDeviceShell(value) {
  if (/[\0-\x1f\x7f]/.test(value)) throw new HarmonyError("INVALID_ARGUMENT", "Control characters are unavailable in shell paths");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function parseDeviceFileListing(output, parent) {
  const records = output.toString("utf8").split("").map((record) => record.replace(/^[\r\n]+/, ""));
  const marker = records.findIndex((value) => ["__PIORA_DIR_OK__", "__PIORA_DIR_MISSING__", "__PIORA_DIR_DENIED__", "__PIORA_STAT_ERROR__"].includes(value));
  if (marker < 0) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The device did not return a file listing");
  if (records[marker] === "__PIORA_DIR_MISSING__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The device directory does not exist", { details: { reason: "missing" } });
  if (records[marker] === "__PIORA_DIR_DENIED__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The device directory is inaccessible", { details: { reason: "inaccessible" } });
  if (records.includes("__PIORA_STAT_ERROR__")) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device stat is unavailable for file browsing");
  const files = [];
  let truncated = false;
  for (let index = marker + 1; index < records.length; index++) {
    if (records[index] === "__PIORA_TRUNCATED__") {
      truncated = true;
      break;
    }
    if (!records[index].trim()) continue;
    const fields = records[index].split("");
    if (fields.length !== 2) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The device file listing is malformed; retry the directory read");
    const [path, metadataText] = fields;
    const metadata = metadataText.split("|");
    if (metadata.length !== 4) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The device file metadata is malformed; retry the directory read");
    const [kindText, sizeText, modifiedText, mode] = metadata;
    if (!path || !path.startsWith(parent === "." ? "" : parent === "/" ? "/" : `${parent}/`)) continue;
    const name = posix2.basename(path);
    if (!name || name === "." || name === ".." || /[\0-\x1f\x7f]/.test(name)) continue;
    const kind = kindText === "directory" ? "directory" : kindText === "regular file" || kindText === "regular empty file" ? "file" : kindText.includes("symbolic link") ? "symlink" : "other";
    const size = /^\d+$/.test(sizeText) ? Number(sizeText) : void 0;
    const modifiedAt = /^\d+$/.test(modifiedText) ? Number(modifiedText) * 1e3 : void 0;
    files.push({
      path,
      name,
      kind,
      size: Number.isSafeInteger(size) ? size : void 0,
      modifiedAt: Number.isSafeInteger(modifiedAt) ? modifiedAt : void 0,
      mode: /^[0-7]{3,4}$/.test(mode) ? mode : void 0
    });
  }
  return { files: files.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1).slice(0, 500), truncated };
}
function deviceFileListScript(path, offset = 0) {
  validateDeviceFileOffset(offset);
  const quoted = quoteDeviceShell(path);
  return `d=${quoted}; if [ ! -d "$d" ]; then printf '__PIORA_DIR_MISSING__\\036'; exit 0; fi; if [ ! -r "$d" ] || [ ! -x "$d" ]; then printf '__PIORA_DIR_DENIED__\\036'; exit 0; fi; if ! stat -c '%F' "$d" >/dev/null 2>&1; then printf '__PIORA_STAT_ERROR__\\036'; exit 0; fi; printf '__PIORA_DIR_OK__\\036'; rs=$(printf '\\036'); us=$(printf '\\037'); nl=$(printf '\\n_'); nl=\${nl%_}; fmt="%n\${us}%F|%s|%Y|%a\${rs}"; n=0; batch=0; more=0; offset=${offset}; end=$((offset+${DEVICE_FILE_PAGE_SIZE})); set --; for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; case "$f" in *"$rs"*|*"$us"*|*"$nl"*) continue;; esac; if [ "$n" -lt "$offset" ]; then n=$((n+1)); continue; fi; if [ "$n" -ge "$end" ]; then more=1; break; fi; set -- "$@" "$f"; n=$((n+1)); batch=$((batch+1)); if [ "$batch" -ge 50 ]; then stat -c "$fmt" "$@" 2>/dev/null || { printf '__PIORA_STAT_ERROR__\\036'; exit 0; }; set --; batch=0; fi; done; if [ "$#" -gt 0 ]; then stat -c "$fmt" "$@" 2>/dev/null || { printf '__PIORA_STAT_ERROR__\\036'; exit 0; }; fi; if [ "$more" -eq 1 ]; then printf '__PIORA_TRUNCATED__\\036'; fi`;
}
function deviceFileStatScript(path) {
  const quoted = quoteDeviceShell(path);
  return `f=${quoted}; if [ ! -e "$f" ] && [ ! -L "$f" ]; then printf '__PIORA_DIR_MISSING__\\036'; exit 0; fi; printf '__PIORA_DIR_OK__\\036'; us=$(printf '\\037'); rs=$(printf '\\036'); stat -c "%n\${us}%F|%s|%Y|%a\${rs}" "$f" 2>/dev/null || printf '__PIORA_STAT_ERROR__\\036'`;
}

// vendor/lib/harmony/device-text.ts
import iconv from "iconv-lite";
var MAX_DEVICE_TEXT_BYTES = 2 * 1024 * 1024;
var UTF8_BOM = Buffer.from([239, 187, 191]);
var UTF16LE_BOM = Buffer.from([255, 254]);
var UTF16BE_BOM = Buffer.from([254, 255]);
function decodeStrict(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new HarmonyError("INVALID_ARGUMENT", `Device file is not valid ${encoding.toUpperCase()} text`);
  }
}
function decodeDeviceText(bytes, requested = "auto") {
  if (bytes.length > MAX_DEVICE_TEXT_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Device text is limited to 2 MiB");
  if (!["auto", "utf-8", "utf-16le", "utf-16be", "gb18030"].includes(requested)) throw new HarmonyError("INVALID_ARGUMENT", "Unsupported device text encoding");
  const encoding = requested === "auto" ? bytes.subarray(0, 3).equals(UTF8_BOM) ? "utf-8-bom" : bytes.subarray(0, 2).equals(UTF16LE_BOM) ? "utf-16le-bom" : bytes.subarray(0, 2).equals(UTF16BE_BOM) ? "utf-16be-bom" : "utf-8" : requested === "utf-8" && bytes.subarray(0, 3).equals(UTF8_BOM) ? "utf-8-bom" : requested === "utf-16le" && bytes.subarray(0, 2).equals(UTF16LE_BOM) ? "utf-16le-bom" : requested === "utf-16be" && bytes.subarray(0, 2).equals(UTF16BE_BOM) ? "utf-16be-bom" : requested;
  const raw = encoding === "utf-8-bom" ? bytes.subarray(3) : encoding === "utf-16le-bom" || encoding === "utf-16be-bom" ? bytes.subarray(2) : bytes;
  const codec = encoding.replace("-bom", "");
  let text2;
  if (codec === "gb18030") {
    text2 = iconv.decode(raw, "gb18030");
    if (!iconv.encode(text2, "gb18030").equals(raw)) throw new HarmonyError("INVALID_ARGUMENT", "GB18030 file does not round-trip without loss");
  } else {
    if (codec.startsWith("utf-16") && raw.length % 2) throw new HarmonyError("INVALID_ARGUMENT", "UTF-16 file has an incomplete code unit");
    text2 = decodeStrict(raw, codec);
  }
  if (text2.includes("\0")) throw new HarmonyError("INVALID_ARGUMENT", "Device text must not contain NUL characters");
  const breaks = text2.match(/\r\n|\r|\n/g) ?? [];
  const kinds = new Set(breaks.map((value) => value === "\r\n" ? "crlf" : value === "\r" ? "cr" : "lf"));
  const newline = kinds.size > 1 ? "mixed" : kinds.size === 0 ? "none" : [...kinds][0];
  return { text: text2, encoding, newline };
}
function encodeDeviceText(text2, encoding, originalNewline, selectedNewline) {
  if (typeof text2 !== "string" || text2.includes("\0")) throw new HarmonyError("INVALID_ARGUMENT", "Device text must not contain NUL characters");
  if (selectedNewline !== void 0 && !["lf", "crlf", "cr"].includes(selectedNewline)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid newline mode");
  if (originalNewline === "mixed" && !selectedNewline) throw new HarmonyError("INVALID_ARGUMENT", "Mixed line endings require an explicit newline choice");
  const mode = selectedNewline ?? (originalNewline === "none" ? "lf" : originalNewline);
  const normalized2 = text2.replace(/\r\n|\r/g, "\n");
  const content = mode === "crlf" ? normalized2.replaceAll("\n", "\r\n") : mode === "cr" ? normalized2.replaceAll("\n", "\r") : normalized2;
  const codec = encoding.replace("-bom", "");
  if (!["utf-8", "utf-16le", "utf-16be", "gb18030"].includes(codec)) throw new HarmonyError("INVALID_ARGUMENT", "Unsupported device text encoding");
  const encoded = codec === "gb18030" ? iconv.encode(content, "gb18030") : codec === "utf-8" ? Buffer.from(content, "utf8") : iconv.encode(content, codec);
  if (codec === "gb18030" && iconv.decode(encoded, "gb18030") !== content) throw new HarmonyError("INVALID_ARGUMENT", "Text cannot be encoded in GB18030 without loss");
  const bom = encoding === "utf-8-bom" ? UTF8_BOM : encoding === "utf-16le-bom" ? UTF16LE_BOM : encoding === "utf-16be-bom" ? UTF16BE_BOM : void 0;
  const output = bom ? Buffer.concat([bom, encoded]) : encoded;
  if (output.length > MAX_DEVICE_TEXT_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Device text editing is limited to 2 MiB");
  return output;
}

// vendor/lib/harmony/device-transfer-limits.ts
var MAX_DEVICE_TRANSFER_BYTES = 1024 * 1024 * 1024;
function deviceTransferTimeoutMs(size) {
  return size > 256 * 1024 * 1024 ? 30 * 6e4 : 12e4;
}

// vendor/lib/harmony/tcp-device.ts
import { isIP } from "node:net";
function validateTcpDeviceAddress(value) {
  if (typeof value !== "string" || value.length > 64) throw new HarmonyError("INVALID_ARGUMENT", "Enter a private IPv4 address and port");
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value.trim());
  if (!match || isIP(match[1]) !== 4) throw new HarmonyError("INVALID_ARGUMENT", "Enter an IPv4 address and port, for example 192.168.1.10:8710");
  const octets = match[1].split(".").map(Number);
  const port = Number(match[2]);
  const privateAddress = octets[0] === 10 || octets[0] === 127 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168 || octets[0] === 169 && octets[1] === 254;
  if (!privateAddress || port < 1 || port > 65535) throw new HarmonyError("INVALID_ARGUMENT", "Use a private or loopback IPv4 address and port 1\u201365535");
  return `${octets.join(".")}:${port}`;
}

// vendor/lib/harmony/hos-scrcpy.ts
import { spawn as spawn5 } from "node:child_process";
import { lstat as lstat6 } from "node:fs/promises";
import { delimiter as delimiter2, isAbsolute as isAbsolute5, join as join10, resolve as resolve4 } from "node:path";
import WebSocket from "ws";
var MAX_SIDE_CAR_OUTPUT = 16 * 1024;
var MAX_JAR_BYTES = 128 * 1024 * 1024;
async function packageFiles(packageDirectory) {
  if (typeof packageDirectory !== "string" || !isAbsolute5(packageDirectory) || packageDirectory.length > 4096) {
    throw new HarmonyError("INVALID_ARGUMENT", "Choose an absolute HOScrcpy package directory");
  }
  const directory = resolve4(packageDirectory);
  const jar = join10(directory, "resources", "hosScrcpy-1.0.18-beta.jar");
  const classes = join10(directory, "resources", "out");
  const [jarStat, classStat] = await Promise.all([lstat6(jar).catch(() => void 0), lstat6(join10(classes, "Main.class")).catch(() => void 0)]);
  if (!jarStat?.isFile() || jarStat.isSymbolicLink() || jarStat.size > MAX_JAR_BYTES || !classStat?.isFile() || classStat.isSymbolicLink()) {
    throw new HarmonyError("CAPABILITY_UNAVAILABLE", "HOScrcpy SDK jar or sidecar classes are missing; use the bundled HDC video provider");
  }
  return { jar, classes };
}
function waitReady(process2, signal) {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "", stderr = "", settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout2);
      signal?.removeEventListener("abort", abort);
      process2.stdout.off("data", read);
      process2.stderr.off("data", readError);
      process2.off("error", failed);
      process2.off("exit", exited);
      if (error) rejectReady(error);
      else resolveReady(port);
    };
    const read = (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_SIDE_CAR_OUTPUT) return finish(new HarmonyError("INVALID_RESPONSE", "HOScrcpy emitted too much startup output"));
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"ready":true')) continue;
        try {
          const value = JSON.parse(line);
          if (value.ready && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535) return finish(void 0, value.port);
        } catch {
        }
      }
    };
    const readError = (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_SIDE_CAR_OUTPUT);
    };
    const failed = (error) => finish(new HarmonyError("CAPABILITY_UNAVAILABLE", "HOScrcpy Java process could not start", { cause: error }));
    const exited = (code) => finish(new HarmonyError("CAPABILITY_UNAVAILABLE", `HOScrcpy exited before video was ready (${code ?? "unknown"}): ${stderr.slice(-300)}`));
    const abort = () => finish(new HarmonyError("COMMAND_ABORTED", "HOScrcpy video start was cancelled"));
    const timeout2 = setTimeout(() => finish(new HarmonyError("COMMAND_TIMEOUT", "HOScrcpy video did not become ready within 20 seconds")), 2e4);
    process2.stdout.on("data", read);
    process2.stderr.on("data", readError);
    process2.once("error", failed);
    process2.once("exit", exited);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
async function connect(port) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 5e3, perMessageDeflate: false });
    socket.once("open", () => {
      socket.off("error", failed);
      resolveSocket(socket);
    });
    const failed = (error) => {
      socket.terminate();
      rejectSocket(error);
    };
    socket.once("error", failed);
  });
}
async function openHosScrcpyVideo(options) {
  if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(options.serial)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid device serial");
  if (options.signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "HOScrcpy video start was cancelled");
  const { jar, classes } = await packageFiles(options.packageDirectory);
  const javaPath = options.javaPath?.trim() || "java";
  if (javaPath !== "java" && !isAbsolute5(javaPath)) throw new HarmonyError("INVALID_ARGUMENT", "Java executable path must be absolute");
  const child = spawn5(javaPath, [
    "-cp",
    `${jar}${delimiter2}${classes}`,
    "Main",
    "--sn",
    options.serial,
    "--hdc",
    options.hdcPath,
    "--port",
    "0",
    "--scale",
    "1",
    "--frame-rate",
    "30",
    "--idle-exit",
    "30"
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let socket;
  try {
    const port = await waitReady(child, options.signal);
    socket = await connect(port);
  } catch (error) {
    child.kill();
    throw error;
  }
  const ws = socket;
  const converter = new HosVideoPacketizer();
  let controller;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(sizePoll);
    options.signal?.removeEventListener("abort", abort);
    ws.removeAllListeners();
    ws.terminate();
    child.kill();
  };
  const abort = () => {
    try {
      controller?.close();
    } catch {
    }
    void close();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const sizePoll = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"size"}');
  }, 2e3);
  sizePoll.unref?.();
  ws.send('{"type":"size"}');
  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
      ws.on("message", (data, binary) => {
        if (closed) return;
        if (!binary) {
          try {
            const reply = JSON.parse(data.toString());
            if (reply.ok && reply.msg === "size") {
              const match = /^(\d{1,5})x(\d{1,5})$/.exec(reply.data ?? "");
              if (match) converter.setSize(Number(match[1]), Number(match[2]));
            }
          } catch {
          }
          return;
        }
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        for (const packet2 of converter.push(bytes)) streamController.enqueue(packet2);
        if ((streamController.desiredSize ?? 1) <= 0) ws.pause();
      });
      ws.once("error", (error) => {
        if (!closed) {
          options.onFailure?.(error.message);
          streamController.error(error);
          void close();
        }
      });
      ws.once("close", () => {
        if (!closed) {
          options.onFailure?.("HOScrcpy video socket closed");
          streamController.close();
          void close();
        }
      });
      child.once("exit", (code) => {
        if (!closed) {
          options.onFailure?.(`HOScrcpy exited (${code ?? "unknown"})`);
          streamController.close();
          void close();
        }
      });
    },
    pull() {
      if (!closed) ws.resume();
    },
    async cancel() {
      await close();
    }
  });
  return { stream, close };
}

// vendor/lib/harmony/hdc-backend.ts
var MAX_LAYOUT_BYTES = 16 * 1024 * 1024;
var MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
var MAX_INPUT_TEXT_BYTES = 16 * 1024;
var SERIAL_PATTERN = /^[A-Za-z0-9._:\[\]-]{1,256}$/;
var APP_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,255}$/;
var MAX_LOG_QUERY_LENGTH = 256;
var MAX_LOG_LINES = 2e3;
var MIRROR_BUNDLE2 = "com.ohos.scrcpy.server";
var MIRROR_DEVICE_PORT = 53535;
var MIRROR_MAX_SHORT_EDGE = 1080;
var MIRROR_BITRATE = 6e6;
var MIRROR_FRAME_RATE = 30;
function installedMirrorMatches(preview, installed) {
  return preview.versionCode !== void 0 && preview.versionName !== void 0 && installed?.bundleName === preview.bundleName && installed.versionCode === preview.versionCode && installed.versionName === preview.versionName && installed.abilities?.includes("EntryAbility") === true;
}
function mayMeanBundleIsAbsent(output) {
  const normalized2 = output.replace(/\0/g, "").trim();
  return normalized2 === "" || /^error:\s*failed to get information and the parameters may be wrong\.?$/i.test(normalized2);
}
function protectSandboxShell(args) {
  if (args.length !== 6 || args[2] !== "shell" || args[3] !== "-b") return args;
  return [...args.slice(0, 5), `printf %s ${Buffer.from(args[5], "utf8").toString("base64")} | base64 -d | sh`];
}
function requireDeviceReply(result, success, operation, description) {
  const reply = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "").split(/\r?\n/).map((line) => operation === "install_package" || operation === "uninstall_package" ? line.replace(/^\s*\[Info\]\s*App (?:install|uninstall) path:[^\r\n]*?(?:,\s*|\s+)msg\s*:\s*/i, "") : line).join("\n");
  const failed = /\berror\s*:|\bfail(?:ed|ure)?\b|permission denied|\[(?:fail|error)\]/i.test(reply);
  const signatureRejected = operation === "install_package" && /fail(?:ed)? to verify (?:pkcs7|signature)|signature verification fail|invalid signature/i.test(reply);
  const deviceErrorCode = reply.match(/\b(?:error\s*code|code)\s*[:=]\s*(\d{1,12})\b/i)?.[1];
  if (operation === "launch_app" && deviceErrorCode === "10106102") {
    throw new HarmonyError("SCREEN_LOCKED", "Unlock the phone before launching the application", {
      details: { operation, dispatchState: "sent", reason: "app-launch-locked", deviceErrorCode }
    });
  }
  if (failed || !success.test(reply)) throw new HarmonyError(
    failed ? "COMMAND_FAILED" : "INVALID_RESPONSE",
    signatureRejected ? "The device rejected the HAP signature; use a package signed for this device" : failed ? `The device rejected ${description}` : `The device did not confirm ${description}`,
    {
      details: {
        operation,
        dispatchState: "sent",
        ...signatureRejected ? { reason: "signature-rejected" } : {},
        ...deviceErrorCode ? { deviceErrorCode } : {}
      }
    }
  );
}
var NO_UITEST_CAPABILITIES = {
  uiTree: false,
  screenshot: false,
  tap: false,
  swipe: false,
  inputText: false,
  keys: false,
  launchApp: true
};
var UITEST_CAPABILITIES = {
  uiTree: true,
  screenshot: true,
  tap: false,
  swipe: false,
  // Text travels through a temporary file; it is never interpolated into a command.
  inputText: false,
  keys: false,
  launchApp: true
};
function validateSerial(serial) {
  if (!SERIAL_PATTERN.test(serial)) {
    throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony device serial");
  }
}
function validateCoordinate(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 1e5) {
    throw new HarmonyError("INVALID_ARGUMENT", `${label} must be an integer between 0 and 100000`);
  }
  return value;
}
function parseDeviceLine(line) {
  const trimmed = line.trim();
  if (!trimmed || /^\[?empty\]?(?:\s|$)/i.test(trimmed) || /no targets/i.test(trimmed)) return void 0;
  if (/^\[(?:fail|error|e\d+)/i.test(trimmed)) return void 0;
  const parts = trimmed.split(/\s+/);
  const serial = parts[0];
  if (!SERIAL_PATTERN.test(serial) || /^(connect|list|targets|device)$/i.test(serial)) return void 0;
  const status = parts.slice(1).join(" ").toLowerCase();
  const state = /unauthor|not.auth/.test(status) ? "unauthorized" : /offline|disconnect/.test(status) ? "offline" : "online";
  const transport = /(?:^|\s)usb(?:\s|$)/i.test(status) ? "usb" : /(?:^|\s)(?:tcp|wifi|wi-fi)(?:\s|$)/i.test(status) ? "tcp" : /^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(serial) ? "tcp" : "unknown";
  const transportEvidence = transport === "unknown" ? "unavailable" : /(?:^|\s)(?:usb|tcp|wifi|wi-fi)(?:\s|$)/i.test(status) ? "hdc" : "endpoint";
  return { serial, state, transport, transportEvidence };
}
function cleanOutput(output) {
  const value = output.toString("utf8").replace(/\0/g, "").trim();
  return value && !/^(unknown|null|undefined)$/i.test(value) ? value.slice(0, 512) : void 0;
}
function parseHarmonyScreenLockState(output) {
  const matches = [...output.matchAll(/^[ \t]*(?:\*[ \t]*)?screenLocked(?:[ \t]*[:=][ \t]*|[ \t]+)(true|false)\b/gim)];
  if (matches.length !== 1) return "unknown";
  return matches[0][1].toLowerCase() === "true" ? "locked" : "unlocked";
}
function preferredDeviceName(values2, model, product) {
  return values2.find((value) => value && value !== model && value !== product && !/^(unknown|null|undefined)$/i.test(value)) ?? values2.find(Boolean) ?? model ?? product;
}
function parseProcessList(output) {
  const processes = /* @__PURE__ */ new Map();
  for (const line of output.toString("utf8").replace(/\0/g, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:pid|uid)\b/i.test(trimmed)) continue;
    const columns = trimmed.split(/\s+/);
    const pidIndex = columns.findIndex((column) => /^\d+$/.test(column));
    if (pidIndex < 0) continue;
    const pid = Number(columns[pidIndex]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const name = columns.at(-1)?.replace(/^\[|\]$/g, "") || `PID ${pid}`;
    if (!name || /^\d+$/.test(name)) continue;
    processes.set(pid, { pid, name: name.slice(0, 256) });
  }
  return [...processes.values()].sort((left, right) => left.name.localeCompare(right.name) || left.pid - right.pid);
}
var LOG_LEVELS = {
  D: "debug",
  I: "info",
  W: "warn",
  E: "error",
  F: "fatal"
};
function parseLogLine(raw) {
  const line = raw.replace(/\0/g, "").trimEnd();
  const match = line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+([DIWEF])\s+(?:(\S+)\/)?([^:]+):\s?(.*)$/) ?? line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\d+)-(\d+)(?:\/\S+)?\s+([DIWEF])\s+(?:(\S+)\/)?([^:]+):\s?(.*)$/);
  if (!match) return { level: "unknown", message: line, raw: line };
  return {
    timestamp: match[1],
    pid: Number(match[2]),
    tid: Number(match[3]),
    level: LOG_LEVELS[match[4]] ?? "unknown",
    ...match[5] ? { domain: match[5] } : {},
    tag: match[6].trim(),
    message: match[7],
    raw: line
  };
}
function versionAtLeast(version, minimum) {
  const match = version?.match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const current = match.slice(1, 5).map((value) => Number(value ?? 0));
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}
function capabilitiesForUiTest(version) {
  if (!versionAtLeast(version, [1, 0, 0, 0])) return { ...NO_UITEST_CAPABILITIES };
  const supportsCliInput = versionAtLeast(version, [4, 1, 2, 0]);
  return {
    ...UITEST_CAPABILITIES,
    tap: supportsCliInput,
    swipe: supportsCliInput,
    keys: supportsCliInput,
    // Coordinate-free text input was added in UiTest 5.1.1.1.
    inputText: versionAtLeast(version, [5, 1, 1, 1])
  };
}
function parsePng(data) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature)) {
    throw new HarmonyError("INVALID_RESPONSE", "Harmony device returned an invalid screenshot");
  }
  return {
    mimeType: "image/png",
    data,
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20)
  };
}
function encodeMirrorPacket(type, payload) {
  const packet2 = Buffer.allocUnsafe(8 + payload.length);
  packet2.writeUInt32BE(type, 0);
  packet2.writeUInt32BE(payload.length, 4);
  payload.copy(packet2, 8);
  return packet2;
}
function encodeMirrorHeartbeat() {
  const payload = Buffer.allocUnsafe(8);
  payload.writeBigUInt64BE(BigInt(Date.now()), 0);
  return encodeMirrorPacket(1, payload);
}
function encodeMirrorVideoParameters() {
  const payload = Buffer.allocUnsafe(13);
  payload[0] = 66;
  payload.writeInt32BE(MIRROR_MAX_SHORT_EDGE, 1);
  payload.writeInt32BE(MIRROR_BITRATE, 5);
  payload.writeInt32BE(MIRROR_FRAME_RATE, 9);
  return encodeMirrorPacket(16, payload);
}
async function reserveLoopbackPort() {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer2();
    server.unref();
    server.once("error", rejectPort);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Unable to allocate a local Harmony video port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}
async function connectLoopback(port, signal) {
  return await new Promise((resolveSocket, rejectSocket) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5e3);
    const timeout2 = setTimeout(() => fail(new Error("Harmony video service connection timed out")), 5e3);
    const cleanup = () => {
      clearTimeout(timeout2);
      signal?.removeEventListener("abort", abort);
      socket.removeListener("connect", connected);
      socket.removeListener("error", fail);
    };
    const connected = () => {
      cleanup();
      resolveSocket(socket);
    };
    const fail = (error) => {
      cleanup();
      socket.destroy();
      rejectSocket(error);
    };
    const abort = () => fail(new Error("Harmony video connection was cancelled"));
    socket.once("connect", connected);
    socket.once("error", fail);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
var HdcBackend = class {
  kind = "hdc-uitest";
  hdcPath;
  execute;
  commandTimeoutMs;
  prepareMirrorHap;
  capabilitiesBySerial = /* @__PURE__ */ new Map();
  deviceInfoBySerial = /* @__PURE__ */ new Map();
  ownedRecordings = /* @__PURE__ */ new Map();
  recordingStarts = /* @__PURE__ */ new Set();
  liveScreenshotPaths = /* @__PURE__ */ new Map();
  screenshotTails = /* @__PURE__ */ new Map();
  forwardStore;
  forwards = /* @__PURE__ */ new Map();
  videoClosers = /* @__PURE__ */ new Set();
  videoPreference;
  hosRetryAt = 0;
  nativeVideoEnabled;
  interruptedForwards(serial) {
    return this.forwardStore?.interrupted(serial) ?? [];
  }
  nativeVideoStreaming(serial) {
    return nativeDevEcoVideoStreaming(serial);
  }
  async nativeVideoPresent(serial, signal) {
    if (this.nativeVideoStreaming(serial)) return true;
    const reply = await this.shell(serial, ["ps", "-ef"], "native_video_runtime_guard", signal, 3e3);
    return reply.stdout.toString("utf8").split("\n").some((line) => /uitest\s+start-daemon/.test(line) && /libscreen_casting|libscrcpy|libdsh_video_/.test(line));
  }
  constructor(options = {}) {
    if (!options.execute || options.forwardJournalDirectory) this.forwardStore = new ForwardOwnershipStore(options.forwardJournalDirectory ?? join11(dirname6(defaultHarmonyConfigPath()), "harmony-forwards"));
    this.nativeVideoEnabled = !options.execute && process.platform === "win32";
    const config = readHarmonyConfig();
    this.videoPreference = options.resolve?.config?.video ?? config.video;
    const resolution = resolveHdcPath({
      ...options.resolve,
      explicitPath: options.hdcPath ?? options.resolve?.explicitPath,
      config: options.resolve?.config ?? config
    });
    this.hdcPath = resolution.hdcPath;
    this.execute = options.execute ?? runCommand;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15e3;
    this.prepareMirrorHap = options.prepareMirrorHap ?? (async (serial, sourceHapPath, signal) => {
      const result = await this.shell(serial, ["bm", "get", "--udid"], "mirror_device_identity", signal, 8e3);
      const udids = [...new Set(Buffer.concat([result.stdout, result.stderr]).toString("utf8").match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi) ?? [])];
      if (udids.length !== 1) {
        throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The connected phone identity could not be verified for local DevEco signing", {
          details: { reason: "mirror-device-identity-unavailable", dispatchState: "not-sent" }
        });
      }
      return await prepareLocalMirrorHap({
        sourceHapPath,
        hdcPath: this.hdcPath,
        deviceUdid: udids[0],
        cacheDirectory: join11(dirname6(defaultHarmonyConfigPath()), "harmony-mirror-private"),
        signal
      });
    });
  }
  async run(args, operation, signal, timeoutMs) {
    const result = await this.execute({
      executable: this.hdcPath,
      args: protectSandboxShell(args),
      timeoutMs: timeoutMs ?? this.commandTimeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
      signal,
      operation
    });
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "");
    const channelNotReady = args[0] === "-t" && isHdcChannelNotReadyResponse(output);
    if (channelNotReady) {
      this.deviceInfoBySerial.delete(args[1]);
      this.capabilitiesBySerial.delete(args[1]);
    }
    if (operation !== "list_devices" && operation !== "list_devices_legacy" && (channelNotReady || /(?:^|\r?\n)\s*\[(?:Fail|Error|E\d{3,})\]/i.test(output))) {
      throw new HarmonyError("COMMAND_FAILED", "HDC rejected the device command", {
        details: { operation, ...channelNotReady ? { reason: "hdc-channel-not-ready" } : {} },
        retryable: true
      });
    }
    return result;
  }
  async shell(serial, args, operation, signal, timeoutMs) {
    validateSerial(serial);
    return await this.run(["-t", serial, "shell", ...args], operation, signal, timeoutMs);
  }
  async safeInfo(serial, args, signal, onResponse, onFailure) {
    try {
      const result = await this.shell(serial, args, "device_info", signal);
      if (result.exitCode !== 0) return void 0;
      const value = cleanOutput(result.stdout);
      if (!value || /[\r\n]/.test(value) || /(?:not found|not exist|permission denied|invalid (?:argument|parameter)|unknown (?:command|option)|get .* fail|^error\b|^usage:|^\/.*(?:sh|shell):)/i.test(value)) return void 0;
      onResponse?.(result, value);
      return value;
    } catch (error) {
      if (isHarmonyError(error) && error.code === "COMMAND_ABORTED") throw error;
      onFailure?.(error);
      return void 0;
    }
  }
  async applications(serial, query = "", bundleName, signal) {
    if (query.length > 256 || bundleName && !APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid application search");
    if (bundleName) {
      const output = (await this.shell(serial, ["bm", "dump", "-n", bundleName], "application_abilities", signal)).stdout.toString("utf8");
      return [parseApplicationDetails(output, bundleName)];
    }
    let apps;
    try {
      apps = parseApplicationLabels((await this.shell(serial, ["bm", "dump", "-a", "-l"], "application_labels", signal)).stdout.toString("utf8"));
    } catch (error) {
      if (signal?.aborted) throw error;
      apps = parseBundleList((await this.shell(serial, ["bm", "dump", "-a"], "application_list", signal)).stdout.toString("utf8"));
    }
    const term = query.toLocaleLowerCase();
    return apps.filter((app2) => `${app2.bundleName}
${app2.label ?? ""}`.toLocaleLowerCase().includes(term));
  }
  async listFiles(serial, scope, path, signal, offset = 0) {
    validateSerial(serial);
    const normalized2 = validateDeviceFilePath(scope, path);
    const args = ["-t", serial, "shell", ...scope.kind === "sandbox" ? ["-b", scope.bundleName] : [], deviceFileListScript(normalized2, offset)];
    const output = (await this.run(args, "list_device_files", signal, 2e4)).stdout;
    return parseDeviceFileListing(output, normalized2);
  }
  async statFile(serial, scope, path, signal) {
    validateSerial(serial);
    const normalized2 = validateDeviceFilePath(scope, path);
    if (normalized2 === "/" || normalized2 === ".") {
      await this.listFiles(serial, scope, normalized2, signal);
      return { path: normalized2, name: normalized2, kind: "directory" };
    }
    const args = ["-t", serial, "shell", ...scope.kind === "sandbox" ? ["-b", scope.bundleName] : [], deviceFileStatScript(normalized2)];
    const output = (await this.run(args, "stat_device_file", signal, 1e4)).stdout;
    const file = parseDeviceFileListing(output, posix3.dirname(normalized2)).files.find((item) => item.path === normalized2);
    if (!file) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The requested device path could not be verified");
    return file;
  }
  async isSqliteFile(serial, scope, path, signal) {
    validateSerial(serial);
    const normalized2 = validateDeviceFilePath(scope, path);
    const script = `f=${quoteDeviceShell(normalized2)}; if [ ! -f "$f" ]; then printf '__PIORA_SQLITE_UNAVAILABLE__'; exit 0; fi; h=$(dd if="$f" bs=15 count=1 2>/dev/null); rc=$?; if [ "$rc" -ne 0 ]; then printf '__PIORA_SQLITE_UNAVAILABLE__'; elif [ "$h" = 'SQLite format 3' ]; then printf '__PIORA_SQLITE_YES__'; else printf '__PIORA_SQLITE_NO__'; fi`;
    const args = ["-t", serial, "shell", ...scope.kind === "sandbox" ? ["-b", scope.bundleName] : [], script];
    const output = (await this.run(args, "inspect_device_file_signature", signal, 1e4)).stdout.toString("utf8").trim();
    if (output.endsWith("__PIORA_SQLITE_YES__")) return true;
    if (output.endsWith("__PIORA_SQLITE_NO__")) return false;
    throw new HarmonyError("OBSERVATION_UNAVAILABLE", "Device could not verify the SQLite file signature");
  }
  async pullFile(serial, scope, path, destinationPath, signal) {
    validateSerial(serial);
    const remote = validateDeviceFilePath(scope, path);
    if (remote === "/" || remote === "." || !isAbsolute6(destinationPath)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a device file and absolute local destination");
    const scopeArgs = scope.kind === "sandbox" ? ["-b", scope.bundleName] : [];
    const source = quoteDeviceShell(remote);
    const preflight = (await this.run([
      "-t",
      serial,
      "shell",
      ...scopeArgs,
      `f=${source}; if [ ! -f "$f" ] || [ -L "$f" ]; then printf '__PIORA_FILE_ERROR__'; else stat -c '%s' "$f"; fi`
    ], "device_file_preflight", signal)).stdout.toString("utf8").trim();
    const size = Number(preflight);
    if (!/^\d+$/.test(preflight) || !Number.isSafeInteger(size) || size > MAX_DEVICE_TRANSFER_BYTES) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The device file is unavailable or exceeds the 1 GiB download limit");
    }
    const target = resolve5(destinationPath);
    const parent = await stat2(dirname6(target)).catch(() => void 0);
    if (!parent?.isDirectory()) throw new HarmonyError("INVALID_ARGUMENT", "The local destination directory does not exist");
    await assertUnredirectedPath(dirname6(target));
    const temporaryDirectory = await mkdtemp3(join11(dirname6(target), ".piora-harmony-download-"));
    const temporaryFile = join11(temporaryDirectory, "download");
    try {
      await this.run(["-t", serial, "file", "recv", ...scopeArgs, remote, temporaryFile], "device_file_download", signal, deviceTransferTimeoutMs(size));
      const downloaded = await stat2(temporaryFile).catch(() => void 0);
      if (!downloaded?.isFile() || downloaded.size !== size) throw new HarmonyError("INVALID_RESPONSE", "Downloaded device file size differs from the preflight result");
      if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Device file download was cancelled");
      await assertUnredirectedPath(dirname6(target));
      try {
        await link(temporaryFile, target);
      } catch (error) {
        if (error.code === "EEXIST") throw new HarmonyError("INVALID_ARGUMENT", "The local destination already exists");
        throw error;
      }
      return { destinationPath: target, size };
    } finally {
      await rm4(temporaryDirectory, { recursive: true, force: true });
    }
  }
  async pushFile(serial, scope, sourcePath, path, overwrite, signal) {
    validateSerial(serial);
    const remote = validateWritableDeviceFilePath(scope, path);
    if (!isAbsolute6(sourcePath)) throw new HarmonyError("INVALID_ARGUMENT", "Choose an absolute local upload file");
    const source = await lstat7(sourcePath).catch(() => void 0);
    if (!source?.isFile() || source.isSymbolicLink() || source.size > MAX_DEVICE_TRANSFER_BYTES) throw new HarmonyError("INVALID_ARGUMENT", "Upload file is missing or exceeds 1 GiB");
    const scopeArgs = scope.kind === "sandbox" ? ["-b", scope.bundleName] : [];
    const quoted = quoteDeviceShell(remote);
    const staged = validateWritableDeviceFilePath(scope, `${remote}.piora-upload-${randomUUID6()}.tmp`);
    const stagedQuoted = quoteDeviceShell(staged);
    const existing = (await this.run([
      "-t",
      serial,
      "shell",
      ...scopeArgs,
      `f=${quoted}; if [ -L "$f" ]; then printf '__PIORA_SYMLINK__'; elif [ -d "$f" ]; then printf '__PIORA_DIRECTORY__'; elif [ -e "$f" ]; then printf '__PIORA_EXISTS__'; else printf '__PIORA_MISSING__'; fi`
    ], "device_upload_preflight", signal)).stdout.toString("utf8").trim();
    if (existing === "__PIORA_SYMLINK__") throw new HarmonyError("INVALID_ARGUMENT", "Upload target is a symbolic link");
    if (existing === "__PIORA_DIRECTORY__") throw new HarmonyError("INVALID_ARGUMENT", "Upload target is a directory");
    if (existing !== "__PIORA_EXISTS__" && existing !== "__PIORA_MISSING__") throw new HarmonyError("OBSERVATION_UNAVAILABLE", "Could not determine whether the device file exists");
    if (existing === "__PIORA_EXISTS__" && !overwrite) throw new HarmonyError("INVALID_ARGUMENT", "The device file already exists; enable overwrite explicitly");
    let stagedMayExist = false;
    try {
      stagedMayExist = true;
      const transfer = await this.run(["-t", serial, "file", "send", ...scopeArgs, sourcePath, staged], "device_file_upload", signal, deviceTransferTimeoutMs(source.size));
      const output = Buffer.concat([transfer.stdout, transfer.stderr]).toString("utf8");
      if (!/FileTransfer finish/i.test(output)) throw new HarmonyError("INVALID_RESPONSE", "HDC did not confirm that the file transfer finished", { details: { dispatchState: "sent" } });
      const stagedSize = (await this.run([
        "-t",
        serial,
        "shell",
        ...scopeArgs,
        `t=${stagedQuoted}; if [ -L "$t" ] || [ ! -f "$t" ]; then printf '__PIORA_STAGE_ERROR__'; else stat -c '%s' "$t"; fi`
      ], "device_upload_stage_verify", signal)).stdout.toString("utf8").trim();
      if (!/^\d+$/.test(stagedSize) || Number(stagedSize) !== source.size) {
        throw new HarmonyError("INVALID_RESPONSE", "Staged device upload size could not be verified", { details: { dispatchState: "sent" } });
      }
      const finalize = `f=${quoted}; t=${stagedQuoted}; if [ -L "$f" ] || [ -d "$f" ] || [ -L "$t" ] || [ ! -f "$t" ]; then printf '__PIORA_PATH_ERROR__'; ${overwrite ? "else" : `elif [ -e "$f" ]; then printf '__PIORA_EXISTS__'; else`} mv ${overwrite ? "-f" : "-n"} "$t" "$f"; if [ -e "$t" ] || [ -L "$t" ] || [ ! -f "$f" ] || [ -L "$f" ]; then printf '__PIORA_MOVE_ERROR__'; else stat -c '%s' "$f"; fi; fi`;
      const actualText = (await this.run(["-t", serial, "shell", ...scopeArgs, finalize], "device_upload_finalize", signal)).stdout.toString("utf8").trim();
      if (actualText === "__PIORA_EXISTS__") throw new HarmonyError("STALE_SNAPSHOT", "Upload target appeared during transfer; nothing was overwritten", { details: { dispatchState: "sent" } });
      if (!/^\d+$/.test(actualText) || Number(actualText) !== source.size) {
        throw new HarmonyError("INVALID_RESPONSE", "Device upload could not be verified after staging", { details: { dispatchState: "sent" } });
      }
      stagedMayExist = false;
    } finally {
      if (stagedMayExist) await this.run([
        "-t",
        serial,
        "shell",
        ...scopeArgs,
        `t=${stagedQuoted}; if [ -f "$t" ] && [ ! -L "$t" ]; then rm "$t"; fi`
      ], "device_upload_cleanup", void 0, 5e3).catch(() => void 0);
    }
  }
  async fileShell(serial, scope, script, operation, signal, timeoutMs) {
    validateSerial(serial);
    return (await this.run(["-t", serial, "shell", ...scope.kind === "sandbox" ? ["-b", scope.bundleName] : [], script], operation, signal, timeoutMs)).stdout.toString("utf8").trim();
  }
  async runShellCommand(serial, scope, command, signal) {
    validateSerial(serial);
    validateDeviceFilePath(scope, scope.kind === "sandbox" ? "data/storage/el2/base" : "/data/local/tmp");
    if (typeof command !== "string" || !command.trim() || command.length > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Enter a command of at most 8192 characters");
    }
    const marker = `__PIORA_COMMAND_${randomUUID6().replaceAll("-", "")}__`;
    const script = `sh -c ${quoteDeviceShell(command)}; code=$?; printf '\\n${marker}%s\\n' "$code"`;
    const result = await this.execute({
      executable: this.hdcPath,
      args: protectSandboxShell(["-t", serial, "shell", ...scope.kind === "sandbox" ? ["-b", scope.bundleName] : [], script]),
      operation: "manual_device_command",
      signal,
      timeoutMs: 15e3,
      maxOutputBytes: 128 * 1024
    });
    const stdout = result.stdout.toString("utf8");
    const at = stdout.lastIndexOf(marker);
    if (at < 0) throw new HarmonyError("INVALID_RESPONSE", "Device command completion could not be verified", { details: { dispatchState: "sent" } });
    const status = stdout.slice(at + marker.length).trim();
    if (!/^\d{1,3}$/.test(status)) throw new HarmonyError("INVALID_RESPONSE", "Device command exit status is invalid", { details: { dispatchState: "sent" } });
    return { stdout: stdout.slice(0, at).replace(/\n$/, ""), stderr: result.stderr.toString("utf8"), exitCode: Number(status), durationMs: result.durationMs };
  }
  async fileKind(serial, scope, path, signal) {
    const quoted = quoteDeviceShell(path);
    const result = await this.fileShell(serial, scope, `p=${quoted}; if [ -L "$p" ]; then printf '__PIORA_SYMLINK__'; elif [ -d "$p" ]; then printf '__PIORA_DIRECTORY__'; elif [ -f "$p" ]; then printf '__PIORA_FILE__'; elif [ -e "$p" ]; then printf '__PIORA_OTHER__'; else printf '__PIORA_MISSING__'; fi`, "device_file_kind", signal);
    const known = { __PIORA_FILE__: "file", __PIORA_DIRECTORY__: "directory", __PIORA_SYMLINK__: "symlink", __PIORA_MISSING__: "missing" };
    if (!Object.hasOwn(known, result)) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "Could not verify the device file type");
    return known[result];
  }
  async createDirectory(serial, scope, path, signal) {
    const remote = validateWritableDeviceFilePath(scope, path);
    if (await this.fileKind(serial, scope, remote, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "Device path already exists");
    await this.fileShell(serial, scope, `mkdir ${quoteDeviceShell(remote)}`, "device_mkdir", signal);
    if (await this.fileKind(serial, scope, remote, signal) !== "directory") {
      throw new HarmonyError("INVALID_RESPONSE", "Device directory creation could not be verified", { details: { dispatchState: "sent" } });
    }
  }
  async deletePath(serial, scope, path, signal) {
    const remote = validateWritableDeviceFilePath(scope, path);
    const kind = await this.fileKind(serial, scope, remote, signal);
    if (kind !== "file" && kind !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "Only a regular file or empty directory can be deleted");
    await this.fileShell(serial, scope, `${kind === "directory" ? "rmdir" : "rm"} ${quoteDeviceShell(remote)}`, "device_delete_path", signal);
    if (await this.fileKind(serial, scope, remote, signal) !== "missing") {
      throw new HarmonyError("INVALID_RESPONSE", "Device deletion could not be verified", { details: { dispatchState: "sent" } });
    }
  }
  async renamePath(serial, scope, path, newPath, signal) {
    const source = validateWritableDeviceFilePath(scope, path), target = validateWritableDeviceFilePath(scope, newPath);
    if (source === target || posix3.dirname(source) !== posix3.dirname(target)) throw new HarmonyError("INVALID_ARGUMENT", "Rename must use a new name in the same directory");
    const kind = await this.fileKind(serial, scope, source, signal);
    if (kind !== "file" && kind !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "Only a regular file or directory can be renamed");
    if (await this.fileKind(serial, scope, target, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "The target name already exists");
    await this.fileShell(serial, scope, `mv -n ${quoteDeviceShell(source)} ${quoteDeviceShell(target)}`, "device_rename_path", signal);
    if (await this.fileKind(serial, scope, source, signal) !== "missing" || await this.fileKind(serial, scope, target, signal) !== kind) {
      throw new HarmonyError("INVALID_RESPONSE", "Device rename could not be verified", { details: { dispatchState: "sent" } });
    }
  }
  async copyPath(serial, scope, path, newPath, move, signal) {
    const source = move ? validateWritableDeviceFilePath(scope, path) : validateDeviceFilePath(scope, path);
    const target = validateWritableDeviceFilePath(scope, newPath);
    if (source === target) throw new HarmonyError("INVALID_ARGUMENT", "Choose a different destination path");
    const sourceKind = await this.fileKind(serial, scope, source, signal);
    if (sourceKind !== "file" && sourceKind !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "Copy and move require a regular file or directory");
    if (sourceKind === "directory" && target.startsWith(`${source}/`)) throw new HarmonyError("INVALID_ARGUMENT", "A directory cannot be copied or moved into itself");
    if (await this.fileKind(serial, scope, target, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "The destination already exists");
    if (await this.fileKind(serial, scope, posix3.dirname(target), signal) !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "The destination directory does not exist");
    if (sourceKind === "directory") {
      const inspection = await this.fileShell(
        serial,
        scope,
        `set -o pipefail; p=${quoteDeviceShell(source)}; bad=$(find "$p" ! -type d ! -type f -print -quit 2>/dev/null) || exit 2; if [ -n "$bad" ]; then printf '__PIORA_UNSUPPORTED_ENTRY__'; else find "$p" -print | wc -l; fi`,
        "device_copy_tree_inspection",
        signal,
        3e4
      );
      if (inspection === "__PIORA_UNSUPPORTED_ENTRY__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Directory contains a symlink or special file; copy it separately after review");
      const entries = Number(inspection);
      if (!/^\d+$/.test(inspection) || !Number.isSafeInteger(entries) || entries > 1e4) {
        throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Directory copy is limited to 10000 entries");
      }
    }
    const sizeText = await this.fileShell(serial, scope, sourceKind === "file" ? `stat -c '%s' ${quoteDeviceShell(source)}` : `du -sb ${quoteDeviceShell(source)}`, "device_copy_size", signal, 3e4);
    const sizeMatch = sourceKind === "file" ? /^(\d+)$/.exec(sizeText) : /^(\d+)\s/.exec(sizeText);
    const size = sizeMatch ? Number(sizeMatch[1]) : Number.NaN;
    if (!Number.isSafeInteger(size) || size > 1024 * 1024 * 1024) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device copy and move are limited to at most 1 GiB");
    }
    const timeoutMs = size > 256 * 1024 * 1024 ? 30 * 6e4 : Math.max(3e4, this.commandTimeoutMs);
    const digest = async (candidate, digestSignal) => {
      const script = sourceKind === "file" ? `sha256sum ${quoteDeviceShell(candidate)}` : `set -o pipefail; p=${quoteDeviceShell(candidate)}; bad=$(find "$p" ! -type d ! -type f -print -quit 2>/dev/null) || exit 2; if [ -n "$bad" ]; then printf '__PIORA_UNSUPPORTED_ENTRY__'; else tar -C "$p" -cf - -s --mtime @0 --owner 0 --group 0 . | sha256sum; fi`;
      const output = await this.fileShell(serial, scope, script, "device_copy_hash", digestSignal, timeoutMs);
      if (output === "__PIORA_UNSUPPORTED_ENTRY__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Directory contains a symlink or special file; copy it separately after review");
      const match = /^([a-f0-9]{64})\s/i.exec(output);
      if (!match) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device tar and sha256sum are required to verify the copied content");
      return match[1].toLowerCase();
    };
    const originalHash = await digest(source, signal);
    const staged = `${target}.piora-copy-${randomUUID6()}`;
    validateWritableDeviceFilePath(scope, staged);
    let stagedMayExist = false;
    try {
      if (await this.fileKind(serial, scope, staged, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "Temporary destination already exists");
      stagedMayExist = true;
      const copied = await this.fileShell(
        serial,
        scope,
        `cp ${sourceKind === "directory" ? "-R " : ""}${quoteDeviceShell(source)} ${quoteDeviceShell(staged)} && printf '__PIORA_COPIED__'`,
        "device_copy_path",
        signal,
        timeoutMs
      );
      if (copied !== "__PIORA_COPIED__") throw new HarmonyError("INVALID_RESPONSE", "Device copy did not confirm completion", { details: { dispatchState: "sent" } });
      if (await this.fileKind(serial, scope, staged, signal) !== sourceKind || await digest(source, signal) !== originalHash || await digest(staged, signal) !== originalHash) {
        throw new HarmonyError("STALE_SNAPSHOT", "Source changed during copy or destination content differs; no destination was published");
      }
      const published = await this.fileShell(
        serial,
        scope,
        `d=${quoteDeviceShell(target)}; s=${quoteDeviceShell(staged)}; if [ -e "$d" ] || [ -L "$d" ]; then printf '__PIORA_EXISTS__'; elif mv -n "$s" "$d"; then printf '__PIORA_PUBLISHED__'; fi`,
        "device_copy_publish",
        signal,
        timeoutMs
      );
      if (published === "__PIORA_EXISTS__") throw new HarmonyError("INVALID_ARGUMENT", "The destination appeared while copying; it was not overwritten");
      if (published !== "__PIORA_PUBLISHED__" || await this.fileKind(serial, scope, staged, signal) !== "missing" || await this.fileKind(serial, scope, target, signal) !== sourceKind || await digest(target, signal) !== originalHash) {
        throw new HarmonyError("INVALID_RESPONSE", "Device copy result could not be verified", { details: { dispatchState: "sent" } });
      }
      if (move && sourceKind === "directory") {
        const heldSource = `${source}.piora-move-${randomUUID6()}`;
        validateWritableDeviceFilePath(scope, heldSource);
        if (await this.fileKind(serial, scope, heldSource, signal) !== "missing") throw new HarmonyError("INVALID_ARGUMENT", "Temporary source path already exists");
        if (await digest(source, signal) !== originalHash) throw new HarmonyError("STALE_SNAPSHOT", "Source changed before moving; verified destination remains as a copy");
        const held = await this.fileShell(
          serial,
          scope,
          `s=${quoteDeviceShell(source)}; h=${quoteDeviceShell(heldSource)}; if [ -e "$h" ] || [ -L "$h" ]; then printf '__PIORA_EXISTS__'; elif mv -n "$s" "$h"; then printf '__PIORA_HELD__'; fi`,
          "device_move_hold_source",
          signal,
          timeoutMs
        );
        if (held !== "__PIORA_HELD__" || await this.fileKind(serial, scope, source, signal) !== "missing" || await this.fileKind(serial, scope, heldSource, signal) !== "directory") {
          throw new HarmonyError("INVALID_RESPONSE", "Directory move could not safely isolate its source; inspect the source and destination", { details: { dispatchState: "sent" } });
        }
        if (await digest(heldSource, signal) !== originalHash) {
          await this.fileShell(
            serial,
            scope,
            `s=${quoteDeviceShell(source)}; h=${quoteDeviceShell(heldSource)}; if [ ! -e "$s" ] && [ ! -L "$s" ]; then mv -n "$h" "$s"; fi`,
            "device_move_restore_source",
            void 0,
            timeoutMs
          ).catch(() => void 0);
          throw new HarmonyError("STALE_SNAPSHOT", "Directory changed during move; verified destination remains as a copy; inspect the source before retrying");
        }
        const removed = await this.fileShell(
          serial,
          scope,
          `h=${quoteDeviceShell(heldSource)}; rm -r "$h" && printf '__PIORA_REMOVED__'`,
          "device_move_remove_source",
          signal,
          timeoutMs
        );
        if (removed !== "__PIORA_REMOVED__" || await this.fileKind(serial, scope, heldSource, signal) !== "missing" || await digest(target, signal) !== originalHash) {
          throw new HarmonyError("INVALID_RESPONSE", "Destination is verified but source cleanup is incomplete; inspect both directories", { details: { dispatchState: "sent" } });
        }
      } else if (move) {
        const removed = await this.fileShell(
          serial,
          scope,
          `s=${quoteDeviceShell(source)}; h=$(sha256sum "$s" 2>/dev/null); case "$h" in ${originalHash}' '*) rm "$s" && printf '__PIORA_REMOVED__';; *) printf '__PIORA_CHANGED__';; esac`,
          "device_move_remove_source",
          signal,
          timeoutMs
        );
        if (removed === "__PIORA_CHANGED__") throw new HarmonyError("STALE_SNAPSHOT", "Source changed before removal; verified destination remains as a copy");
        if (removed !== "__PIORA_REMOVED__" || await this.fileKind(serial, scope, source, signal) !== "missing" || await digest(target, signal) !== originalHash) {
          throw new HarmonyError("INVALID_RESPONSE", "Destination was copied, but source removal could not be verified; inspect both paths", { details: { dispatchState: "sent" } });
        }
      }
    } finally {
      if (stagedMayExist) await this.fileShell(
        serial,
        scope,
        `s=${quoteDeviceShell(staged)}; if [ -d "$s" ] && [ ! -L "$s" ]; then rm -r "$s"; elif [ -f "$s" ] && [ ! -L "$s" ]; then rm "$s"; fi`,
        "device_copy_cleanup",
        void 0,
        1e4
      ).catch(() => void 0);
    }
  }
  async chmodPath(serial, scope, path, mode, signal) {
    const remote = validateWritableDeviceFilePath(scope, path);
    if (typeof mode !== "string" || !/^[0-7]{3}$/.test(mode)) throw new HarmonyError("INVALID_ARGUMENT", "Permissions must use three octal digits");
    const kind = await this.fileKind(serial, scope, remote, signal);
    if (kind !== "file" && kind !== "directory") throw new HarmonyError("INVALID_ARGUMENT", "Only regular files and directories can change permissions");
    const quoted = quoteDeviceShell(remote);
    const result = await this.fileShell(
      serial,
      scope,
      `p=${quoted}; if [ -L "$p" ] || { [ ! -f "$p" ] && [ ! -d "$p" ]; }; then printf '__PIORA_FILE_ERROR__'; else chmod ${mode} "$p" && stat -c '%a' "$p"; fi`,
      "device_chmod",
      signal
    );
    if (!/^[0-7]{3,4}$/.test(result) || Number.parseInt(result, 8) !== Number.parseInt(mode, 8)) {
      throw new HarmonyError("INVALID_RESPONSE", "Device file permissions could not be verified", { details: { dispatchState: "sent" } });
    }
  }
  async readTextFile(serial, scope, path, signal, encoding = "auto") {
    const remote = validateDeviceFilePath(scope, path);
    if (await this.fileKind(serial, scope, remote, signal) !== "file") throw new HarmonyError("INVALID_ARGUMENT", "Choose a regular device text file");
    const sizeText = await this.fileShell(serial, scope, `stat -c '%s' ${quoteDeviceShell(remote)}`, "device_text_size", signal);
    const size = Number(sizeText);
    if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size) || size > MAX_DEVICE_TEXT_BYTES) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Text preview is limited to 2 MiB files");
    }
    const directory = await mkdtemp3(join11(tmpdir2(), "piora-harmony-text-"));
    const local = join11(directory, "preview.txt");
    try {
      await this.pullFile(serial, scope, remote, local, signal);
      const bytes = await readFile4(local);
      if (bytes.length !== size) throw new HarmonyError("INVALID_RESPONSE", "Device file is incomplete");
      return { ...decodeDeviceText(bytes, encoding), hash: createHash5("sha256").update(bytes).digest("hex"), size };
    } finally {
      await rm4(directory, { recursive: true, force: true });
    }
  }
  async saveTextFile(serial, scope, path, text2, expectedHash, signal, newlineMode, encoding) {
    const remote = validateWritableDeviceFilePath(scope, path);
    if (typeof text2 !== "string" || text2.includes("\0") || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Text and the expected SHA-256 are required");
    }
    const requestedEncoding = encoding?.replace("-bom", "");
    const current = await this.readTextFile(serial, scope, remote, signal, requestedEncoding);
    if (current.hash !== expectedHash) throw new HarmonyError("STALE_SNAPSHOT", "The device file changed since it was opened; reload before saving");
    if (encoding && encoding !== current.encoding) throw new HarmonyError("STALE_SNAPSHOT", "Device text encoding changed; reload before saving");
    const bytes = encodeDeviceText(text2, current.encoding ?? "utf-8", current.newline ?? "lf", newlineMode);
    const directory = await mkdtemp3(join11(tmpdir2(), "piora-harmony-edit-"));
    const local = join11(directory, "edit.txt");
    const staged = validateWritableDeviceFilePath(scope, `${remote}.piora-${randomUUID6()}.tmp`);
    const newHash = createHash5("sha256").update(bytes).digest("hex");
    let uploaded = false;
    try {
      await writeFile3(local, bytes, { mode: 384 });
      await this.pushFile(serial, scope, local, staged, false, signal);
      uploaded = true;
      const target = quoteDeviceShell(remote), temporary = quoteDeviceShell(staged);
      const script = `p=${target}; t=${temporary}; if ! command -v sha256sum >/dev/null 2>&1; then printf '__PIORA_NO_HASH__'; elif [ -L "$p" ] || [ ! -f "$p" ] || [ ! -f "$t" ]; then printf '__PIORA_FILE_ERROR__'; else sum=$(sha256sum "$p" 2>/dev/null); case "$sum" in ${expectedHash}' '*) mv -f "$t" "$p" && printf '__PIORA_APPLIED__';; *) printf '__PIORA_STALE__';; esac; fi`;
      const result = await this.fileShell(serial, scope, script, "device_text_replace", signal);
      if (result === "__PIORA_STALE__") throw new HarmonyError("STALE_SNAPSHOT", "The device file changed during save; reload before retrying", { details: { dispatchState: "sent" } });
      if (result === "__PIORA_NO_HASH__") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Device sha256sum is required for safe text editing");
      if (result !== "__PIORA_APPLIED__") throw new HarmonyError("INVALID_RESPONSE", "Device text replacement could not be confirmed", { details: { dispatchState: "unknown" } });
      uploaded = false;
      if ((await this.readTextFile(serial, scope, remote, signal, requestedEncoding)).hash !== newHash) {
        throw new HarmonyError("INVALID_RESPONSE", "Saved device text failed content verification", { details: { dispatchState: "sent" } });
      }
    } finally {
      if (uploaded) await this.run([
        "-t",
        serial,
        "shell",
        ...scope.kind === "sandbox" ? ["-b", scope.bundleName] : [],
        `t=${quoteDeviceShell(staged)}; if [ -f "$t" ] && [ ! -L "$t" ]; then rm "$t"; fi`
      ], "device_edit_cleanup", void 0, 5e3).catch(() => void 0);
      await rm4(directory, { recursive: true, force: true });
    }
  }
  async appTestAudio(serial, packet2, signal) {
    if (!/^[A-Za-z0-9+/=]{1,20000}$/.test(packet2)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid debug PCM packet");
    await this.requireUnlockedScreen(serial, signal);
    await this.shell(serial, ["aa", "start", "-b", "dev.piora.audio.fixture", "-a", "EntryAbility", "--ps", "pioraPcmPacket", packet2], "app_test_audio", signal);
  }
  async connectTcpDevice(address, remove, signal) {
    const endpoint = validateTcpDeviceAddress(address);
    const result = await this.run(remove ? ["tconn", endpoint, "-remove"] : ["tconn", endpoint], remove ? "tcp_disconnect" : "tcp_connect", signal, 15e3);
    const output = `${result.stdout.toString("utf8")}
${result.stderr.toString("utf8")}`;
    if (/\[fail\]|connect failed|disconnect failed/i.test(output)) throw new HarmonyError("COMMAND_FAILED", `HDC TCP ${remove ? "disconnect" : "connect"} failed: ${output.trim().slice(0, 300)}`);
    const listing = await this.run(["list", "targets"], "tcp_verify", signal, 8e3);
    const connected = listing.stdout.toString("utf8").split(/\r?\n/).some((line) => {
      const device = parseDeviceLine(line);
      return device?.serial === endpoint && device.state === "online";
    });
    if (connected === remove) throw new HarmonyError("INVALID_RESPONSE", `HDC TCP ${remove ? "disconnect" : "connect"} could not be verified in the device list`);
  }
  async listDevices(signal) {
    let result;
    try {
      result = await this.run(["list", "targets", "-v"], "list_devices", signal, 8e3);
    } catch (error) {
      if (!isHarmonyError(error) || error.code !== "COMMAND_FAILED") throw error;
      result = await this.run(["list", "targets"], "list_devices_legacy", signal, 8e3);
    }
    const parsed = result.stdout.toString("utf8").split(/\r?\n/).map(parseDeviceLine).filter(Boolean);
    const unique = [...new Map(parsed.map((device) => [device.serial, device])).values()];
    const online = new Set(unique.filter((device) => device.state === "online").map((device) => device.serial));
    for (const serial of this.deviceInfoBySerial.keys()) {
      if (!online.has(serial)) {
        this.deviceInfoBySerial.delete(serial);
        this.capabilitiesBySerial.delete(serial);
      }
    }
    return await Promise.all(unique.map(async ({ serial, state, transport, transportEvidence }) => {
      if (state !== "online") {
        return { serial, state, transport, transportEvidence, capabilities: { ...NO_UITEST_CAPABILITIES, launchApp: false } };
      }
      const cached = this.deviceInfoBySerial.get(serial);
      if (cached && cached.expiresAt > Date.now() && cached.device.transport === transport) return { ...cached.device, state, transport, transportEvidence };
      let responseSample;
      let channelNotReady = false;
      const [model, product, userName, persistedName, deviceName, osVersion, apiVersion, uitestVersion] = await Promise.all([
        this.safeInfo(serial, ["param", "get", "const.product.model"], signal),
        this.safeInfo(serial, ["param", "get", "const.product.name"], signal),
        this.safeInfo(serial, ["settings", "get", "secure", "unified_device_name"], signal),
        this.safeInfo(serial, ["param", "get", "persist.sys.device_name"], signal),
        this.safeInfo(serial, ["param", "get", "const.product.devicename"], signal),
        this.safeInfo(serial, ["param", "get", "const.product.software.version"], signal),
        this.safeInfo(serial, ["param", "get", "const.ohos.apiversion"], signal, (result2, value) => {
          if (/^\d+$/.test(value) && Number.isFinite(result2.durationMs) && result2.durationMs >= 0 && result2.durationMs <= 6e4) {
            responseSample = { durationMs: Math.round(result2.durationMs), sampledAt: (/* @__PURE__ */ new Date()).toISOString() };
          }
        }, (error) => {
          if (isHarmonyError(error) && error.details?.reason === "hdc-channel-not-ready") channelNotReady = true;
        }),
        this.safeInfo(serial, ["uitest", "--version"], signal)
      ]);
      if ((channelNotReady || transport === "unknown" && /^COM\d+$/i.test(serial)) && ![model, product, userName, persistedName, deviceName, osVersion, apiVersion, uitestVersion].some(Boolean)) {
        return {
          serial,
          state: "unknown",
          connectionIssue: "hdc-channel-not-ready",
          transport,
          transportEvidence,
          capabilities: { ...NO_UITEST_CAPABILITIES, launchApp: false }
        };
      }
      const capabilities = capabilitiesForUiTest(uitestVersion);
      this.capabilitiesBySerial.set(serial, capabilities);
      const deviceInfo = {
        serial,
        transport,
        transportEvidence,
        responseSample,
        model,
        product,
        name: preferredDeviceName([userName, persistedName, deviceName], model, product),
        osVersion,
        apiVersion,
        uitestVersion,
        capabilities
      };
      this.deviceInfoBySerial.set(serial, { device: deviceInfo, expiresAt: Date.now() + 3e4 });
      return { ...deviceInfo, state };
    }));
  }
  async probeCapabilities(serial, signal) {
    const help = async (args) => {
      try {
        const result = await this.shell(serial, args, "capability_probe", signal, 8e3);
        return Buffer.concat([result.stdout, result.stderr]).toString("utf8").slice(0, 64 * 1024);
      } catch (error) {
        if (signal?.aborted) throw error;
        return void 0;
      }
    };
    const [uitest, input, uinput] = await Promise.all([
      help(["uitest", "help"]),
      help(["uitest", "uiInput", "help"]),
      help(["uinput", "--help"])
    ]);
    return capabilitiesFromHelp({ uitest, input, uinput });
  }
  async doctorProbes(serial, signal) {
    const probe = async (args, local = false) => {
      try {
        const result = local ? await this.run(args, "doctor_host_version", signal, 8e3) : await this.shell(serial, args, "doctor_read_only", signal, 8e3);
        return Buffer.concat([result.stdout, result.stderr]).toString("utf8").slice(0, 64 * 1024);
      } catch (error) {
        if (signal?.aborted) throw error;
        return "";
      }
    };
    const [version, mirror, lock, install, uinput] = await Promise.all([
      probe(["-v"], true),
      probe(["bm", "dump", "-n", MIRROR_BUNDLE2]),
      probe(["hidumper", "-s", "ScreenlockService", "-a", "-all"]),
      probe(["bm", "help"]),
      probe(["uinput", "--help"])
    ]);
    const check = (name, known, reason) => ({ name, status: known ? "passed" : "unknown", reason });
    return { hdcVersion: version.trim().split(/\r?\n/)[0]?.slice(0, 160), checks: [
      check("video-component", mirror.includes(MIRROR_BUNDLE2) && !/not found|not exist|failed/i.test(mirror), "Package presence only; video connection and initialization are separate"),
      check("screen-unlocked", parseHarmonyScreenLockState(lock) === "unlocked", "Read-only lock inspection; unlock manually if required"),
      check("package-install-command", /\binstall\b/.test(install), "Help availability only; installation may still be denied by the device"),
      check("bounded-uinput-protocol", ["--down", "--up", "--interval"].every((token) => uinput.includes(token)), "Help evidence only; physical key/touch behavior requires calibration")
    ] };
  }
  async requireHoldProtocol(serial, kind, signal) {
    const result = await this.shell(serial, ["uinput", "--help"], "hold_protocol_probe", signal, 8e3);
    const help = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    if (!help.includes(kind === "key" ? "--keyboard" : "--touch") || !["--down", "--up", "--interval"].every((token) => help.includes(token))) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This device does not advertise the required bounded down/interval/up protocol", { details: { dispatchState: "not-sent" } });
    }
  }
  async keyHold(serial, key, durationMs, signal) {
    await this.requireUnlockedScreen(serial, signal);
    await this.requireHoldProtocol(serial, "key", signal);
    const code = String(physicalKeyCode(key));
    return await runBoundedHold({
      durationMs,
      minMs: 50,
      maxMs: key === "power" ? 3e3 : 5e3,
      signal,
      dispatch: async (inner) => {
        await this.shell(serial, ["uinput", "-K", "-d", code, "-i", String(durationMs), "-u", code], "key_hold", inner, durationMs + 5e3);
      },
      release: async () => {
        await this.shell(serial, ["uinput", "-K", "-u", code], "key_hold_release", void 0, 3e3);
      }
    });
  }
  async touchHold(serial, x, y, durationMs, signal) {
    if (![x, y].every((value) => Number.isInteger(value) && value >= 0 && value < 16384)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid touch coordinate");
    await this.requireUnlockedScreen(serial, signal);
    await this.requireHoldProtocol(serial, "touch", signal);
    return await runBoundedHold({
      durationMs,
      minMs: 50,
      maxMs: 15e3,
      signal,
      dispatch: async (inner) => {
        await this.shell(serial, ["uinput", "-T", "-d", String(x), String(y), "-i", String(durationMs), "-u", String(x), String(y)], "touch_hold", inner, durationMs + 5e3);
      },
      release: async () => {
        await this.shell(serial, ["uinput", "-T", "-u", String(x), String(y)], "touch_hold_release", void 0, 3e3);
      }
    });
  }
  async listProcesses(serial, signal) {
    validateSerial(serial);
    try {
      return parseProcessList((await this.shell(serial, ["ps", "-A", "-o", "PID,NAME"], "list_processes", signal)).stdout);
    } catch (error) {
      if (isHarmonyError(error) && error.code === "COMMAND_ABORTED") throw error;
      return parseProcessList((await this.shell(serial, ["ps", "-ef"], "list_processes_legacy", signal)).stdout);
    }
  }
  async readLogs(serial, options) {
    validateSerial(serial);
    const limit = Math.max(1, Math.min(MAX_LOG_LINES, Math.round(options.limit ?? 400)));
    if (options.pid !== void 0 && (!Number.isSafeInteger(options.pid) || options.pid <= 0)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Harmony log PID must be a positive integer");
    }
    const query = options.query?.trim().slice(0, MAX_LOG_QUERY_LENGTH).toLocaleLowerCase();
    const args = ["hilog", "-z", String(limit), "-v", "time"];
    if (options.pid !== void 0) args.push("-P", String(options.pid));
    if (options.level) args.push("-L", { debug: "D", info: "I", warn: "W", error: "E", fatal: "F" }[options.level]);
    const result = await this.shell(serial, args, "read_logs", options.signal, 1e4);
    return result.stdout.toString("utf8").split(/\r?\n/).map(parseLogLine).filter((entry) => entry.raw.length > 0).filter((entry) => {
      if (!options.level || entry.level === "unknown") return true;
      const severity = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
      return severity[entry.level] >= severity[options.level];
    }).filter((entry) => !query || entry.raw.toLocaleLowerCase().includes(query)).slice(-limit);
  }
  async streamLogs(serial, onEntries, signal) {
    validateSerial(serial);
    await streamHdcLines(this.hdcPath, ["-t", serial, "shell", "hilog", "-v", "time"], (lines) => {
      const entries = lines.filter(Boolean).map(parseLogLine);
      if (entries.length) onEntries(entries);
    }, signal);
  }
  async pullGeneratedFile(serial, remotePath, operation, maxBytes, signal) {
    const directory = await mkdtemp3(join11(tmpdir2(), "piora-harmony-"));
    const localPath = join11(directory, operation === "screenshot" ? "screen.png" : "layout.json");
    try {
      if (operation !== "screenshot") {
        await this.shell(serial, ["chmod", "600", remotePath], `${operation}_protect`, signal);
      }
      await this.run(["-t", serial, "file", "recv", remotePath, localPath], `${operation}_pull`, signal, 2e4);
      const info = await stat2(localPath);
      if (info.size <= 0 || info.size > maxBytes) {
        throw new HarmonyError("INVALID_RESPONSE", `Harmony ${operation} file has an invalid size`, {
          details: { size: info.size, maxBytes }
        });
      }
      return await readFile4(localPath);
    } finally {
      await Promise.all([
        this.shell(serial, ["rm", remotePath], `${operation}_cleanup`).catch(() => void 0),
        rm4(directory, { recursive: true, force: true }).catch(() => void 0)
      ]);
    }
  }
  async sendFile(serial, localPath, remotePath, operation, signal) {
    validateSerial(serial);
    if (!/^\/data\/local\/tmp\/piora-[a-z]+-[0-9a-f-]+\.(?:txt|json|png)$/.test(remotePath)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid generated Harmony temporary path");
    }
    await this.run(["-t", serial, "file", "send", localPath, remotePath], operation, signal, 2e4);
  }
  async dumpTree(serial, signal) {
    const before = await this.activeWindow(serial, signal);
    const remotePath = `/data/local/tmp/piora-layout-${randomUUID6()}.json`;
    await this.shell(serial, ["uitest", "dumpLayout", "-p", remotePath], "dump_layout", signal);
    const data = await this.pullGeneratedFile(serial, remotePath, "layout", MAX_LAYOUT_BYTES, signal);
    try {
      const tree = JSON.parse(data.toString("utf8"));
      const observation = parseUiObservation(tree);
      const after = await this.activeWindow(serial, signal);
      if (before && after && before.windowId === after.windowId && before.appId === after.appId) {
        observation.quality = { ...observation.quality, ...after };
      } else if (before || after) {
        observation.quality = { treeStatus: "partial", scopeComplete: false, scope: "unknown" };
      } else {
        observation.quality = { ...observation.quality, scope: "unknown" };
      }
      return observation;
    } catch (error) {
      throw new HarmonyError("INVALID_RESPONSE", "Harmony UiTest returned invalid layout JSON", { cause: error });
    }
  }
  async activeWindow(serial, signal) {
    try {
      const windows = await this.shell(serial, ["hidumper", "-s", "WindowManagerService", "-a", "-a"], "focus_probe", signal, 5e3);
      const windowId = focusedWindowId(windows.stdout.toString("utf8"));
      if (!windowId) return void 0;
      const detail = await this.shell(serial, ["hidumper", "-s", "WindowManagerService", "-a", `-w ${windowId}`], "window_scope", signal, 5e3);
      return { windowId, appId: windowBundle(detail.stdout.toString("utf8"), windowId) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return void 0;
    }
  }
  async captureScreen(serial, signal) {
    const previous = this.screenshotTails.get(serial) ?? Promise.resolve();
    let release;
    const tail = new Promise((resolve6) => {
      release = resolve6;
    });
    this.screenshotTails.set(serial, tail);
    try {
      await previous;
      if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Screenshot capture was cancelled");
      return await this.captureScreenNow(serial, signal);
    } finally {
      release();
      if (this.screenshotTails.get(serial) === tail) this.screenshotTails.delete(serial);
    }
  }
  async captureScreenNow(serial, signal) {
    let paths = this.liveScreenshotPaths.get(serial);
    if (!paths) {
      const directory = await mkdtemp3(join11(tmpdir2(), "piora-harmony-live-"));
      paths = {
        directory,
        localPath: join11(directory, "screen.png"),
        remotePath: `/data/local/tmp/piora-screen-${randomUUID6()}.png`
      };
      this.liveScreenshotPaths.set(serial, paths);
    }
    await rm4(paths.localPath, { force: true }).catch(() => void 0);
    try {
      await this.shell(serial, ["uitest", "screenCap", "-p", paths.remotePath], "screen_capture", signal);
      await this.run(["-t", serial, "file", "recv", paths.remotePath, paths.localPath], "screenshot_pull", signal, 2e4);
      const info = await stat2(paths.localPath);
      if (info.size <= 0 || info.size > MAX_SCREENSHOT_BYTES) {
        throw new HarmonyError("INVALID_RESPONSE", "Harmony screenshot file has an invalid size", {
          details: { size: info.size, maxBytes: MAX_SCREENSHOT_BYTES }
        });
      }
      return parsePng(await readFile4(paths.localPath));
    } finally {
      await Promise.allSettled([
        this.shell(serial, ["rm", "-f", paths.remotePath], "screenshot_cleanup", void 0, 3e3),
        rm4(paths.localPath, { force: true })
      ]);
    }
  }
  async startRecording(serial, remoteName, signal, onFailure) {
    validateSerial(serial);
    if (!/^piora-recording-[0-9A-Za-z-]{8,96}\.mp4$/.test(remoteName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony recording name");
    if (this.ownedRecordings.has(serial) || this.recordingStarts.has(serial)) throw new HarmonyError("DEVICE_BUSY", "This runtime already owns a recording on the device");
    this.recordingStarts.add(serial);
    let connection;
    try {
      connection = await this.openVideoStream(serial, signal);
      const recording = await startOwnedRecording(connection, signal, onFailure);
      this.ownedRecordings.set(serial, { name: remoteName, recording });
    } catch (error) {
      try {
        await connection?.close();
      } catch (cause) {
        throw new HarmonyError("DEVICE_BUSY", "Recording startup forward cleanup is uncertain", { cause, details: { recordingStopped: true, cleanup: "uncertain" } });
      }
      throw new HarmonyError(isHarmonyError(error) ? error.code : "COMMAND_FAILED", error instanceof Error ? error.message : "Recording startup failed", { cause: error, details: { ...isHarmonyError(error) ? error.details : {}, recordingStopped: true, dispatchState: "not-sent" } });
    } finally {
      this.recordingStarts.delete(serial);
    }
  }
  async stopRecording(serial, remoteName, destinationPath, signal) {
    void signal;
    validateSerial(serial);
    const owned = this.ownedRecordings.get(serial);
    if (!owned || owned.name !== remoteName) throw new HarmonyError("INVALID_ARGUMENT", "No recording owned by this runtime matches the requested operation");
    try {
      return await owned.recording.stop(destinationPath);
    } catch (error) {
      throw new HarmonyError(isHarmonyError(error) ? error.code : "COMMAND_FAILED", error instanceof Error ? error.message : "Owned recording failed", { cause: error, details: { ...isHarmonyError(error) ? error.details : {}, recordingStopped: true } });
    } finally {
      this.ownedRecordings.delete(serial);
    }
  }
  bundledMirrorServerPath() {
    const toolsDirectory = process.env.PIORA_HARMONY_TOOLS_DIR?.trim();
    const serverPath = toolsDirectory ? join11(toolsDirectory, "OHScrcpyServer.hap") : join11(process.cwd(), "third_party", "harmony-tools", `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`, "OHScrcpyServer.hap");
    if (!serverPath || !existsSync4(serverPath)) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The bundled Harmony video service is missing from this Piora installation");
    }
    return serverPath;
  }
  mirrorPackagePath() {
    return this.bundledMirrorServerPath();
  }
  async displayGeometry(serial, signal) {
    const result = await this.shell(serial, ["hidumper", "-s", "DisplayManagerService", "-a", "-a"], "display_geometry", signal, 8e3);
    const geometry = parseDisplayGeometry(result.stdout.toString("utf8"));
    if (!geometry) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Native input geometry is unknown or has multiple displays; coordinate control is disabled");
    return geometry;
  }
  async requireUnlockedScreen(serial, signal) {
    const result = await this.shell(serial, ["hidumper", "-s", "ScreenlockService", "-a", "-all"], "screen_lock_state", signal, 8e3);
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    const lockState = parseHarmonyScreenLockState(output);
    if (lockState !== "unlocked") {
      throw new HarmonyError("SCREEN_LOCKED", "Unlock the phone yourself before starting screen mirroring; Piora never wakes or unlocks it automatically", {
        details: { reason: lockState === "locked" ? "locked" : "lock-state-unknown" }
      });
    }
  }
  async prepareDevice(serial, signal) {
    const readState = async () => parseScreenState((await this.shell(serial, ["hidumper", "-s", "ScreenlockService", "-a", "-all"], "screen_state", signal, 3e3)).stdout.toString("utf8"));
    let state = await readState();
    if (state.locked === void 0) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "Cannot verify phone lock state; no wake gesture was sent");
    if (!state.awake) {
      await delay(1e3, void 0, { signal });
      state = await readState();
    }
    if (!state.awake) {
      let complete = false;
      try {
        const reply = await this.shell(serial, ["uinput", "-K", "-d18", "-i120", "-u18"], "wake_device", signal, 3e3);
        complete = /you raised the key 18/.test(reply.stdout.toString("utf8"));
        if (!complete) throw new HarmonyError("COMMAND_FAILED", "Power-key injection was not confirmed", { details: { dispatchState: "unknown", reply: reply.stdout.toString("utf8").slice(0, 300) } });
      } finally {
        if (!complete) await this.shell(serial, ["uinput", "-K", "-u18"], "wake_release", void 0, 3e3).catch(() => void 0);
      }
      const deadline = Date.now() + 4e3;
      do {
        await delay(250, void 0, { signal });
        state = await readState();
      } while (!state.awake && Date.now() < deadline);
    }
    if (!state.awake) throw new HarmonyError("SCENARIO_FAILED", "Power key did not wake the phone; observe before retrying");
    if (state.locked) {
      const { nativeWidth: w, nativeHeight: h } = await this.displayGeometry(serial, signal);
      await this.swipe(serial, Math.round(w / 2), Math.round(h * 0.86), Math.round(w / 2), Math.round(h * 0.3), 450, signal);
      const deadline = Date.now() + 4e3;
      do {
        await delay(250, void 0, { signal });
        state = await readState();
      } while (state.locked && Date.now() < deadline);
    }
    if (state.locked !== false) throw new HarmonyError("SCREEN_LOCKED", "Phone still requires authentication; unlock it on the device. No password was entered.");
  }
  async observeMirrorInstallation(serial, signal, reason = "mirror-installation-state-unavailable", dispatchState = "not-sent") {
    const unavailable = (cause) => new HarmonyError(
      "OBSERVATION_UNAVAILABLE",
      reason === "mirror-uninstallation-unverified" ? "The previous capture component removal could not be verified" : "The capture component installation state could not be verified",
      { cause, details: { reason, dispatchState } }
    );
    let exactOutput;
    try {
      const result = await this.shell(serial, ["bm", "dump", "-n", MIRROR_BUNDLE2], "mirror_installation_state", signal, 8e3);
      exactOutput = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    } catch (cause) {
      if (signal?.aborted || isHarmonyError(cause) && cause.code === "COMMAND_ABORTED") throw cause;
      throw unavailable(cause);
    }
    try {
      return parseApplicationDetails(exactOutput, MIRROR_BUNDLE2);
    } catch (cause) {
      if (!mayMeanBundleIsAbsent(exactOutput)) throw unavailable(cause);
    }
    try {
      const result = await this.shell(serial, ["bm", "dump", "-a"], "mirror_installation_absence", signal, 8e3);
      const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "");
      if (/(?:^|\r?\n)\s*(?:error\b|fail(?:ed|ure)?\b|permission denied)/i.test(output)) {
        throw new Error("bundle list contains a failure response");
      }
      const applications = parseBundleList(output);
      if (applications.some((application) => application.bundleName === MIRROR_BUNDLE2)) {
        throw new Error("exact bundle lookup disagrees with the installed bundle list");
      }
      return void 0;
    } catch (cause) {
      if (signal?.aborted || isHarmonyError(cause) && cause.code === "COMMAND_ABORTED") throw cause;
      throw unavailable(cause);
    }
  }
  async previewMirrorHap(path, signal) {
    try {
      return await previewHapArtifact(path, signal);
    } catch (cause) {
      if (signal?.aborted || cause instanceof DOMException && cause.name === "AbortError") {
        throw new HarmonyError("COMMAND_ABORTED", "Harmony video component initialization was cancelled", {
          cause,
          retryable: true,
          details: { reason: "mirror-initialization-cancelled", dispatchState: "not-sent" }
        });
      }
      throw cause;
    }
  }
  async ensureMirrorServer(serial, signal) {
    const result = await this.shell(serial, ["bm", "dump", "-n", MIRROR_BUNDLE2], "mirror_server_check", signal, 8e3);
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").replace(/\0/g, "");
    if (!output.includes(MIRROR_BUNDLE2) || /(?:not\s+exist|not\s+found|failed)/i.test(output)) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Initialize the phone video component in the Harmony workbench; passive viewing never installs it", { details: { reason: "mirror-component-missing" } });
    }
    await this.requireUnlockedScreen(serial, signal);
  }
  async initializeMirror(serial, hapPath, signal) {
    if (this.nativeVideoStreaming(serial)) return;
    validateSerial(serial);
    await this.requireUnlockedScreen(serial, signal);
    const sourcePreview = await this.previewMirrorHap(hapPath, signal);
    if (sourcePreview.bundleName !== MIRROR_BUNDLE2 || !sourcePreview.abilities.includes("EntryAbility") || sourcePreview.versionCode === void 0 || sourcePreview.versionName === void 0) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The capture package has no supported foreground entry", { details: { reason: "mirror-package-invalid", dispatchState: "not-sent" } });
    }
    if (sourcePreview.minApiVersion !== void 0) {
      const api = await this.safeInfo(serial, ["param", "get", "const.ohos.apiversion"], signal);
      const deviceApi = api && /^\d{1,3}$/.test(api) ? Number(api) : void 0;
      if (deviceApi === void 0) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "\u65E0\u6CD5\u786E\u8BA4\u624B\u673A\u7CFB\u7EDF API \u7248\u672C\uFF0C\u672A\u521D\u59CB\u5316\u5B9E\u65F6\u89C6\u9891\u7EC4\u4EF6\u3002", {
        details: { reason: "mirror-device-api-unknown", dispatchState: "not-sent" }
      });
      if (deviceApi < sourcePreview.minApiVersion) throw new HarmonyError(
        "CAPABILITY_UNAVAILABLE",
        `\u5F53\u524D\u624B\u673A\u4E3A API ${deviceApi}\uFF0C\u5B9E\u65F6\u89C6\u9891\u7EC4\u4EF6\u6700\u4F4E\u9700\u8981 API ${sourcePreview.minApiVersion}\u3002\u8BF7\u4F7F\u7528\u517C\u5BB9\u6B64\u624B\u673A\u7CFB\u7EDF\u7684\u7EC4\u4EF6\uFF1B\u514D\u5B89\u88C5\u622A\u56FE\u9884\u89C8\u548C AI \u64CD\u4F5C\u53EF\u7EE7\u7EED\u4F7F\u7528\u3002`,
        {
          details: { reason: "mirror-device-api-incompatible", deviceApi, requiredApi: sourcePreview.minApiVersion, dispatchState: "not-sent" }
        }
      );
    }
    let installed = await this.observeMirrorInstallation(serial, signal);
    if (installedMirrorMatches(sourcePreview, installed)) {
      await this.launchApp(serial, MIRROR_BUNDLE2, "EntryAbility", signal);
      return;
    }
    const privateHapPath = await this.prepareMirrorHap(serial, hapPath, signal);
    const preview = await this.previewMirrorHap(privateHapPath, signal);
    if (preview.bundleName !== sourcePreview.bundleName || preview.versionCode !== sourcePreview.versionCode || preview.versionName !== sourcePreview.versionName || preview.moduleName !== sourcePreview.moduleName || !preview.abilities.includes("EntryAbility")) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The private capture package differs from the bundled component", {
        details: { reason: "mirror-private-package-invalid", dispatchState: "not-sent" }
      });
    }
    if (!installedMirrorMatches(preview, installed)) {
      if (installed) {
        await this.uninstallPackage(serial, MIRROR_BUNDLE2, signal);
        const remaining = await this.observeMirrorInstallation(
          serial,
          signal,
          "mirror-uninstallation-unverified",
          "sent"
        );
        if (remaining) {
          throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The previous capture component is still installed", {
            details: { reason: "mirror-uninstallation-unverified", dispatchState: "sent" }
          });
        }
      }
      await this.installPackage(serial, privateHapPath, false, signal);
      installed = await this.observeMirrorInstallation(serial, signal, "mirror-installation-unverified", "sent");
    }
    if (!installedMirrorMatches(preview, installed)) {
      throw new HarmonyError("OBSERVATION_UNAVAILABLE", "The installed capture component could not be verified", { details: { reason: "mirror-installation-unverified", dispatchState: "sent" } });
    }
    await this.launchApp(serial, MIRROR_BUNDLE2, "EntryAbility", signal);
  }
  async createMirrorForward(serial, signal) {
    const port = await reserveLoopbackPort();
    const record = this.forwardStore?.create(serial, port, MIRROR_DEVICE_PORT);
    if (record) this.forwards.set(port, record);
    await this.run(["-t", serial, "fport", `tcp:${port}`, `tcp:${MIRROR_DEVICE_PORT}`], "mirror_forward", signal, 8e3);
    if (record) {
      record.state = "established";
      this.forwardStore.save(record);
    }
    return port;
  }
  async removeMirrorForward(serial, port) {
    try {
      await this.run(["-t", serial, "fport", "rm", `tcp:${port}`, `tcp:${MIRROR_DEVICE_PORT}`], "mirror_forward_cleanup", void 0, 1500);
      const record = this.forwards.get(port);
      if (record) {
        this.forwardStore.clear(record);
        this.forwards.delete(port);
      }
    } catch (cause) {
      throw new HarmonyError("DEVICE_BUSY", "Owned video forward cleanup is uncertain; inspect the exact forward in device diagnostics", { cause, details: { cleanup: "uncertain", localPort: port, remotePort: MIRROR_DEVICE_PORT } });
    }
  }
  async openVideoStream(serial, signal, prepareAutomation) {
    let nativeError;
    if (this.videoPreference?.provider === "hos-scrcpy" && this.videoPreference.packageDirectory && Date.now() >= this.hosRetryAt) {
      try {
        await this.requireUnlockedScreen(serial, signal);
        const connection = await openHosScrcpyVideo({
          serial,
          hdcPath: this.hdcPath,
          packageDirectory: this.videoPreference.packageDirectory,
          javaPath: this.videoPreference.javaPath,
          signal,
          onFailure: () => {
            this.hosRetryAt = Date.now() + 6e4;
          }
        });
        this.videoClosers.add(connection.close);
        return { stream: connection.stream, close: async () => {
          try {
            await connection.close();
          } finally {
            this.videoClosers.delete(connection.close);
          }
        } };
      } catch (error) {
        if (signal?.aborted) throw error;
        this.hosRetryAt = Date.now() + 6e4;
      }
    }
    if (this.nativeVideoEnabled) {
      try {
        await this.screenshotTails.get(serial);
        await this.requireUnlockedScreen(serial, signal);
        const connection = await openNativeDevEcoVideo({
          serial,
          signal,
          prepareAutomation,
          cacheDirectory: join11(dirname6(defaultHarmonyConfigPath()), "native-video-cache"),
          command: async (args, operation, commandSignal) => {
            const result = await this.run(["-t", serial, ...args], operation, commandSignal, 8e3);
            return Buffer.concat([result.stdout, result.stderr]).toString("utf8");
          }
        });
        this.videoClosers.add(connection.close);
        return { stream: connection.stream, close: async () => {
          try {
            await connection.close();
          } finally {
            this.videoClosers.delete(connection.close);
          }
        } };
      } catch (error) {
        if (signal?.aborted || isHarmonyError(error) && ["SCREEN_LOCKED", "DEVICE_BUSY"].includes(error.code)) throw error;
        nativeError = error;
      }
    }
    try {
      return await this.openBundledVideoStream(serial, signal);
    } catch (error) {
      throw nativeError ?? error;
    }
  }
  async openBundledVideoStream(serial, signal) {
    validateSerial(serial);
    await this.ensureMirrorServer(serial, signal);
    const localPort = await this.createMirrorForward(serial, signal);
    let socket;
    try {
      let lastError;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          socket = await connectLoopback(localPort, signal);
          break;
        } catch (error) {
          lastError = error;
          if (signal?.aborted) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
        }
      }
      if (!socket) throw lastError ?? new Error("Harmony video service is unavailable");
      if (signal?.aborted) {
        socket.destroy();
        throw new Error("Harmony video connection was cancelled");
      }
    } catch (error) {
      await this.removeMirrorForward(serial, localPort);
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Unable to connect to the Harmony video service", {
        cause: error,
        retryable: true
      });
    }
    const videoSocket = socket;
    videoSocket.write(encodeMirrorVideoParameters());
    videoSocket.write(encodeMirrorPacket(16, Buffer.from([67])));
    const heartbeat = setInterval(() => {
      if (!videoSocket.destroyed && videoSocket.writable) videoSocket.write(encodeMirrorHeartbeat());
    }, 2e3);
    heartbeat.unref?.();
    let closed = false;
    let controller;
    let closing;
    const close = () => closing ??= (async () => {
      closed = true;
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
      videoSocket.removeAllListeners();
      videoSocket.destroy();
      try {
        await this.removeMirrorForward(serial, localPort);
      } finally {
        this.videoClosers.delete(close);
      }
    })();
    this.videoClosers.add(close);
    const abort = () => {
      try {
        controller?.close();
      } catch {
      }
      void close().catch(() => void 0);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const stream = new ReadableStream({
      start(streamController) {
        controller = streamController;
        videoSocket.on("data", (chunk) => {
          if (closed) return;
          streamController.enqueue(Uint8Array.from(chunk));
          if ((streamController.desiredSize ?? 1) <= 0) videoSocket.pause();
        });
        videoSocket.once("end", () => {
          if (!closed) streamController.close();
          void close().catch(() => void 0);
        });
        videoSocket.once("error", (error) => {
          if (!closed) streamController.error(error);
          void close().catch(() => void 0);
        });
        videoSocket.once("close", () => {
          if (!closed) streamController.close();
          void close().catch(() => void 0);
        });
      },
      pull() {
        if (!closed) videoSocket.resume();
      },
      async cancel() {
        await close();
      }
    });
    return { stream, close };
  }
  async dispose() {
    const cleanup = await Promise.allSettled([...this.videoClosers].map((close) => close()));
    await Promise.all([...this.ownedRecordings.values()].map((owned) => owned.recording.discard()));
    this.ownedRecordings.clear();
    const entries = [...this.liveScreenshotPaths.entries()];
    this.liveScreenshotPaths.clear();
    await Promise.all(entries.flatMap(([serial, paths]) => [
      this.shell(serial, ["rm", paths.remotePath], "screenshot_cleanup").catch(() => void 0),
      rm4(paths.directory, { recursive: true, force: true }).catch(() => void 0)
    ]));
    if (cleanup.some((result) => result.status === "rejected")) throw new HarmonyError("DEVICE_BUSY", "Video forward cleanup remains uncertain", { details: { cleanup: "uncertain" } });
  }
  async snapshot(serial, options) {
    validateSerial(serial);
    if (!options.includeTree && !options.includeScreenshot) {
      throw new HarmonyError("INVALID_ARGUMENT", "Snapshot must include a UI tree or screenshot");
    }
    const known = this.capabilitiesBySerial.get(serial);
    if (options.includeTree && known?.uiTree === false || options.includeScreenshot && known?.screenshot === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest snapshot capability is unavailable on this device");
    }
    const snapshot = {};
    if (options.includeTree) {
      const layout = await this.dumpTree(serial, options.signal);
      snapshot.tree = layout.tree;
      snapshot.nodes = layout.nodes;
      snapshot.quality = layout.quality;
    }
    if (options.includeScreenshot) snapshot.screenshot = await this.captureScreen(serial, options.signal);
    return snapshot;
  }
  async tap(serial, x, y, signal) {
    if (this.capabilitiesBySerial.get(serial)?.tap === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest tap injection is unavailable on this device");
    }
    await this.shell(serial, ["uitest", "uiInput", "click", String(validateCoordinate(x, "x")), String(validateCoordinate(y, "y"))], "tap", signal);
  }
  async doubleTap(serial, x, y, signal) {
    if (this.capabilitiesBySerial.get(serial)?.tap === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest double-tap injection is unavailable on this device");
    }
    await this.shell(serial, ["uitest", "uiInput", "doubleClick", String(validateCoordinate(x, "x")), String(validateCoordinate(y, "y"))], "double_tap", signal);
  }
  async longPress(serial, x, y, signal) {
    if (this.capabilitiesBySerial.get(serial)?.tap === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest long-press injection is unavailable on this device");
    }
    await this.shell(serial, ["uitest", "uiInput", "longClick", String(validateCoordinate(x, "x")), String(validateCoordinate(y, "y"))], "long_press", signal);
  }
  async swipe(serial, fromX, fromY, toX, toY, durationMs = 500, signal) {
    if (this.capabilitiesBySerial.get(serial)?.swipe === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest swipe injection is unavailable on this device");
    }
    const values2 = [
      validateCoordinate(fromX, "fromX"),
      validateCoordinate(fromY, "fromY"),
      validateCoordinate(toX, "toX"),
      validateCoordinate(toY, "toY")
    ];
    if (!Number.isFinite(durationMs) || durationMs < 50 || durationMs > 3e4) {
      throw new HarmonyError("INVALID_ARGUMENT", "durationMs must be between 50 and 30000");
    }
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const velocity = Math.max(200, Math.min(4e4, Math.round(distance / (durationMs / 1e3))));
    await this.shell(serial, ["uitest", "uiInput", "swipe", ...values2.map(String), String(velocity)], "swipe", signal);
  }
  async drag(serial, fromX, fromY, toX, toY, durationMs = 800, signal) {
    const values2 = [
      validateCoordinate(fromX, "fromX"),
      validateCoordinate(fromY, "fromY"),
      validateCoordinate(toX, "toX"),
      validateCoordinate(toY, "toY")
    ];
    if (!Number.isFinite(durationMs) || durationMs < 50 || durationMs > 3e4) {
      throw new HarmonyError("INVALID_ARGUMENT", "durationMs must be between 50 and 30000");
    }
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const velocity = Math.max(200, Math.min(4e4, Math.round(distance / (durationMs / 1e3))));
    await this.shell(serial, ["uitest", "uiInput", "drag", ...values2.map(String), String(velocity)], "drag", signal);
  }
  async fling(serial, fromX, fromY, toX, toY, durationMs = 250, signal) {
    const values2 = [
      validateCoordinate(fromX, "fromX"),
      validateCoordinate(fromY, "fromY"),
      validateCoordinate(toX, "toX"),
      validateCoordinate(toY, "toY")
    ];
    if (!Number.isFinite(durationMs) || durationMs < 50 || durationMs > 3e4) {
      throw new HarmonyError("INVALID_ARGUMENT", "durationMs must be between 50 and 30000");
    }
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const velocity = Math.max(200, Math.min(4e4, Math.round(distance / (durationMs / 1e3))));
    await this.shell(serial, ["uitest", "uiInput", "fling", ...values2.map(String), String(velocity)], "fling", signal);
  }
  async inputText(serial, text2, signal) {
    validateSerial(serial);
    let capabilities = this.capabilitiesBySerial.get(serial);
    if (!capabilities) {
      capabilities = capabilitiesForUiTest(await this.safeInfo(serial, ["uitest", "--version"], signal));
      this.capabilitiesBySerial.set(serial, capabilities);
    }
    if (!capabilities.inputText) {
      throw new HarmonyError(
        "CAPABILITY_UNAVAILABLE",
        "Safe coordinate-free text input requires Harmony UiTest 5.1.1.1 or newer"
      );
    }
    if (typeof text2 !== "string" || text2.length === 0) {
      throw new HarmonyError("INVALID_ARGUMENT", "Input text must not be empty");
    }
    if (text2.includes("\0")) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony text input does not support NUL characters");
    }
    const data = Buffer.from(text2, "utf8");
    if (data.length > MAX_INPUT_TEXT_BYTES) {
      throw new HarmonyError("INVALID_ARGUMENT", `Input text exceeds ${MAX_INPUT_TEXT_BYTES} UTF-8 bytes`);
    }
    const id = randomUUID6();
    const directory = await mkdtemp3(join11(tmpdir2(), "piora-harmony-input-"));
    const localPath = join11(directory, "input.txt");
    const remotePath = `/data/local/tmp/piora-input-${id}.txt`;
    try {
      await writeFile3(localPath, data, { mode: 384 });
      await this.sendFile(serial, localPath, remotePath, "input_text_send", signal);
      await this.shell(serial, ["chmod", "600", remotePath], "input_text_protect", signal);
      const command = `v="$(cat\${IFS}${remotePath};printf\${IFS}x)";v="\${v%x}";uitest\${IFS}uiInput\${IFS}text\${IFS}"$v"`;
      await this.shell(serial, [command], "input_text", signal);
    } finally {
      await this.shell(serial, ["rm", remotePath], "input_text_cleanup").catch(() => void 0);
      await rm4(directory, { recursive: true, force: true }).catch(() => void 0);
    }
  }
  async pressKey(serial, key, signal) {
    if (this.capabilitiesBySerial.get(serial)?.keys === false) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Harmony UiTest key injection is unavailable on this device");
    }
    const value = { back: "Back", home: "Home", recents: "2720", enter: "2054" }[key];
    if (!value) throw new HarmonyError("INVALID_ARGUMENT", "Unsupported key");
    await this.shell(serial, ["uitest", "uiInput", "keyEvent", value], "press_key", signal);
  }
  async launchApp(serial, bundleName, abilityName, signal) {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName) || abilityName !== void 0 && !APP_IDENTIFIER_PATTERN.test(abilityName)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle or ability name");
    }
    if (!abilityName) {
      const [app2] = await this.applications(serial, "", bundleName, signal);
      const abilities = app2?.abilities ?? [];
      if (abilities.length === 1) abilityName = abilities[0];
      else throw new HarmonyError("INVALID_ARGUMENT", "Choose an explicit launch ability from applications; the bundle has no unique entry", { details: { abilities, dispatchState: "not-sent" } });
    }
    const args = ["aa", "start", "-b", bundleName, "-a", abilityName];
    const result = await this.shell(serial, args, "launch_app", signal);
    requireDeviceReply(result, /^\s*start ability successfully\.?\s*$/im, "launch_app", "starting the application");
  }
  async installPackage(serial, hapPathValue, replace = true, signal) {
    if (!isAbsolute6(hapPathValue) || extname2(hapPathValue).toLowerCase() !== ".hap") {
      throw new HarmonyError("INVALID_ARGUMENT", "A valid absolute HAP package path is required");
    }
    const hapPath = resolve5(hapPathValue);
    let details;
    try {
      details = await stat2(hapPath);
    } catch (error) {
      throw new HarmonyError("INVALID_ARGUMENT", "The HAP package does not exist", { cause: error });
    }
    if (!details.isFile() || details.size <= 0 || details.size > 2 * 1024 * 1024 * 1024) {
      throw new HarmonyError("INVALID_ARGUMENT", "The HAP package is invalid or exceeds the installation limit");
    }
    const result = await this.run(["-t", serial, "install", ...replace ? ["-r"] : [], hapPath], "install_package", signal, 12e4);
    requireDeviceReply(result, /^\s*install bundle successfully\.?\s*$/im, "install_package", "installing the package");
  }
  async stopApp(serial, bundleName, signal) {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    await this.shell(serial, ["aa", "force-stop", bundleName], "stop_app", signal);
  }
  async clearAppData(serial, bundleName, signal) {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    const result = await this.shell(serial, ["bm", "clean", "-d", "-n", bundleName], "clear_app_data", signal, 3e4);
    requireDeviceReply(result, /^\s*clean bundle data files successfully\.?\s*$/im, "clear_app_data", "clearing the app data");
  }
  async clearAppCache(serial, bundleName, signal) {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    const result = await this.shell(serial, ["bm", "clean", "-c", "-n", bundleName], "clear_app_cache", signal, 3e4);
    requireDeviceReply(result, /^\s*clean bundle cache files successfully\.?\s*$/im, "clear_app_cache", "clearing the app cache");
  }
  async uninstallPackage(serial, bundleName, signal) {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    const result = await this.run(["-t", serial, "uninstall", bundleName], "uninstall_package", signal, 12e4);
    requireDeviceReply(result, /^\s*uninstall bundle successfully\.?\s*$/im, "uninstall_package", "uninstalling the package");
  }
  async setAppEnabled(serial, bundleName, enabled, signal) {
    if (!APP_IDENTIFIER_PATTERN.test(bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony bundle name");
    const operation = enabled ? "enable_app" : "disable_app";
    let result;
    try {
      result = await this.shell(serial, ["bm", enabled ? "enable" : "disable", "-n", bundleName], operation, signal);
    } catch (error) {
      if (!isHarmonyError(error) || error.code !== "COMMAND_FAILED") throw error;
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "bm enable/disable was refused; this operation requires a root device build", { cause: error, details: { dispatchState: "sent" } });
    }
    const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    if (!new RegExp(`${enabled ? "enable" : "disable"} bundle successfully`, "i").test(output)) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This device did not confirm the app state change; bm enable/disable requires a root build", { details: { dispatchState: "sent" } });
    }
  }
};
function createHdcBackend(options = {}) {
  try {
    return new HdcBackend(options);
  } catch (error) {
    if (isHarmonyError(error)) throw error;
    throw new HarmonyError("HDC_INVALID", "Unable to initialize HDC", { cause: error });
  }
}

// vendor/lib/harmony/hybrid-backend.ts
function abortedDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new HarmonyError("COMMAND_ABORTED", "Harmony automation was cancelled", { retryable: true }));
  return new Promise((resolve6, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new HarmonyError("COMMAND_ABORTED", "Harmony automation was cancelled", { retryable: true }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve6();
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
  });
}
var HybridHarmonyBackend = class {
  kind = "hdc-uitest+hypium";
  hdcPath;
  hdc;
  hypium;
  constructor(options = {}) {
    this.hdc = options.hdcBackend ?? createHdcBackend(options);
    this.hdcPath = this.hdc.hdcPath;
    this.hypium = options.hypiumDriver ?? new HypiumWorkerClient(this.hdcPath);
  }
  automationStatus() {
    return this.hypium.status();
  }
  async prepareDevice(serial, signal) {
    await this.hdc.prepareDevice(serial, signal);
  }
  automationDiagnostics() {
    return { provider: "hypium", sessions: this.automationStatus() };
  }
  async connectTcpDevice(address, remove, signal) {
    await this.hdc.connectTcpDevice(address, remove, signal);
  }
  async listDevices(signal) {
    const devices = await this.hdc.listDevices(signal);
    await Promise.all(devices.filter((device) => device.state !== "online").map(async (device) => await this.hypium.invalidate(device.serial)));
    return devices;
  }
  async listProcesses(serial, signal) {
    return await this.hdc.listProcesses(serial, signal);
  }
  async doctorProbes(serial, signal) {
    return this.hdc.doctorProbes(serial, signal);
  }
  interruptedForwards(serial) {
    return this.hdc.interruptedForwards(serial);
  }
  async probeCapabilities(serial, signal) {
    return await this.hdc.probeCapabilities(serial, signal);
  }
  async applications(...args) {
    return await this.hdc.applications(...args);
  }
  async appTestAudio(...args) {
    return await this.hdc.appTestAudio(...args);
  }
  async keyHold(...args) {
    return await this.hdc.keyHold(...args);
  }
  async touchHold(...args) {
    return await this.hdc.touchHold(...args);
  }
  async streamLogs(serial, onEntries, signal) {
    await this.hdc.streamLogs(serial, onEntries, signal);
  }
  async readLogs(serial, options) {
    return await this.hdc.readLogs(serial, options);
  }
  async snapshot(serial, options) {
    return await this.hdc.snapshot(serial, options);
  }
  async startRecording(serial, remoteName, signal, onFailure) {
    await this.hdc.startRecording(serial, remoteName, signal, onFailure);
  }
  async stopRecording(serial, remoteName, destinationPath, signal) {
    return await this.hdc.stopRecording(serial, remoteName, destinationPath, signal);
  }
  async openVideoStream(serial, signal) {
    return await this.hdc.openVideoStream(serial, signal, async () => {
      await this.hypium.waitForIdle(serial, 100, 2e3, signal);
    });
  }
  mirrorPackagePath() {
    return this.hdc.mirrorPackagePath();
  }
  async displayGeometry(serial, signal) {
    return await this.hdc.displayGeometry(serial, signal);
  }
  async initializeMirror(serial, hapPath, signal) {
    await this.hdc.initializeMirror(serial, hapPath, signal);
  }
  async preferHypium(serial, operation, signal, args, fallback) {
    const lock = acquireDeviceLock(serial, nativeRuntimeLockDirectory());
    try {
      const video = this.hdc.nativeVideoStreaming?.(serial) || await this.hdc.nativeVideoPresent?.(serial, signal);
      if (video && operation !== "input_text") {
        await fallback();
        return;
      }
      const result = await this.hypium.execute(serial, operation, args, signal, !video);
      if (!result.used) await fallback();
    } finally {
      lock.release();
    }
  }
  async tap(serial, x, y, signal) {
    await this.preferHypium(
      serial,
      "tap",
      signal,
      [x, y],
      async () => await this.hdc.tap(serial, x, y, signal)
    );
  }
  async doubleTap(serial, x, y, signal) {
    await this.preferHypium(
      serial,
      "double_tap",
      signal,
      [x, y],
      async () => await this.hdc.doubleTap(serial, x, y, signal)
    );
  }
  async longPress(serial, x, y, signal) {
    await this.preferHypium(
      serial,
      "long_press",
      signal,
      [x, y],
      async () => await this.hdc.longPress(serial, x, y, signal)
    );
  }
  async swipe(serial, fromX, fromY, toX, toY, durationMs = 500, signal) {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const speed = Math.max(200, Math.min(4e4, Math.round(distance / (durationMs / 1e3))));
    await this.preferHypium(
      serial,
      "swipe",
      signal,
      [fromX, fromY, toX, toY, speed],
      async () => await this.hdc.swipe(serial, fromX, fromY, toX, toY, durationMs, signal)
    );
  }
  async drag(serial, fromX, fromY, toX, toY, durationMs = 800, signal) {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const speed = Math.max(200, Math.min(4e4, Math.round(distance / (durationMs / 1e3))));
    await this.preferHypium(
      serial,
      "drag",
      signal,
      [fromX, fromY, toX, toY, speed],
      async () => await this.hdc.drag(serial, fromX, fromY, toX, toY, durationMs, signal)
    );
  }
  async fling(serial, fromX, fromY, toX, toY, durationMs = 250, signal) {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const speed = Math.max(200, Math.min(4e4, Math.round(distance / (durationMs / 1e3))));
    await this.preferHypium(
      serial,
      "fling",
      signal,
      [fromX, fromY, toX, toY, speed],
      async () => await this.hdc.fling(serial, fromX, fromY, toX, toY, durationMs, signal)
    );
  }
  async inputText(serial, text2, signal) {
    await this.preferHypium(serial, "input_text", signal, [text2], async () => {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Exact text input requires semantic readback", { details: { dispatchState: "not-sent" } });
    });
  }
  async pressKey(serial, key, signal) {
    await this.preferHypium(serial, "press_key", signal, [key], async () => await this.hdc.pressKey(serial, key, signal));
  }
  async launchApp(serial, bundleName, abilityName, signal) {
    await this.hdc.launchApp(serial, bundleName, abilityName, signal);
  }
  async installPackage(serial, hapPath, replace = true, signal) {
    await this.hdc.installPackage(serial, hapPath, replace, signal);
  }
  async listFiles(serial, scope, path, signal, offset = 0) {
    return await this.hdc.listFiles(serial, scope, path, signal, offset);
  }
  async statFile(serial, scope, path, signal) {
    return await this.hdc.statFile(serial, scope, path, signal);
  }
  async isSqliteFile(serial, scope, path, signal) {
    return await this.hdc.isSqliteFile(serial, scope, path, signal);
  }
  async pullFile(serial, scope, path, destinationPath, signal) {
    return await this.hdc.pullFile(serial, scope, path, destinationPath, signal);
  }
  async pushFile(serial, scope, sourcePath, path, overwrite, signal) {
    await this.hdc.pushFile(serial, scope, sourcePath, path, overwrite, signal);
  }
  async createDirectory(serial, scope, path, signal) {
    await this.hdc.createDirectory(serial, scope, path, signal);
  }
  async deletePath(serial, scope, path, signal) {
    await this.hdc.deletePath(serial, scope, path, signal);
  }
  async renamePath(serial, scope, path, newPath, signal) {
    await this.hdc.renamePath(serial, scope, path, newPath, signal);
  }
  async copyPath(serial, scope, path, newPath, move, signal) {
    await this.hdc.copyPath(serial, scope, path, newPath, move, signal);
  }
  async chmodPath(serial, scope, path, mode, signal) {
    await this.hdc.chmodPath(serial, scope, path, mode, signal);
  }
  async readTextFile(serial, scope, path, signal, encoding) {
    return await this.hdc.readTextFile(serial, scope, path, signal, encoding);
  }
  async saveTextFile(serial, scope, path, text2, expectedHash, signal, newlineMode, encoding) {
    await this.hdc.saveTextFile(serial, scope, path, text2, expectedHash, signal, newlineMode, encoding);
  }
  async runShellCommand(serial, scope, command, signal) {
    return await this.hdc.runShellCommand(serial, scope, command, signal);
  }
  async stopApp(serial, bundleName, signal) {
    await this.hdc.stopApp(serial, bundleName, signal);
  }
  async clearAppData(serial, bundleName, signal) {
    await this.hdc.clearAppData(serial, bundleName, signal);
  }
  async clearAppCache(serial, bundleName, signal) {
    await this.hdc.clearAppCache(serial, bundleName, signal);
  }
  async uninstallPackage(serial, bundleName, signal) {
    await this.hdc.uninstallPackage(serial, bundleName, signal);
  }
  async setAppEnabled(serial, bundleName, enabled, signal) {
    await this.hdc.setAppEnabled(serial, bundleName, enabled, signal);
  }
  async waitForIdle(serial, idleMs, timeoutMs, signal) {
    const lock = acquireDeviceLock(serial, nativeRuntimeLockDirectory());
    try {
      const video = this.hdc.nativeVideoStreaming?.(serial) || await this.hdc.nativeVideoPresent?.(serial, signal);
      if (await this.hypium.waitForIdle(serial, idleMs, timeoutMs, signal, !video)) return { strategy: "driver_idle" };
    } finally {
      lock.release();
    }
    await abortedDelay(idleMs, signal);
    return { strategy: "bounded_delay" };
  }
  async semanticAction(serial, request, signal) {
    const lock = acquireDeviceLock(serial, nativeRuntimeLockDirectory());
    try {
      const video = this.hdc.nativeVideoStreaming?.(serial) || await this.hdc.nativeVideoPresent?.(serial, signal);
      return await this.hypium.semanticAction(serial, request, signal, !video);
    } finally {
      lock.release();
    }
  }
  async resetAutomation(serial) {
    await this.hypium.reset(serial);
  }
  async dispose() {
    const results = await Promise.allSettled([this.hypium.reset(), Promise.resolve(this.hdc.dispose())]);
    if (results.some((result) => result.status === "rejected")) throw new HarmonyError("DEVICE_BUSY", "Harmony provider cleanup is uncertain", { details: { cleanup: "uncertain" } });
  }
};

// vendor/lib/harmony/hypium-backend.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join12 } from "node:path";
import { lockSync } from "proper-lockfile";
var CONNECT_TIMEOUT_MS = 2e4;
var DRIVER_COOLDOWN_MS = 3e4;
function disableHypiumTelemetry(directory = join12(homedir4(), ".hypium")) {
  const path = join12(directory, ".hypium_driver_config");
  try {
    mkdirSync4(directory, { recursive: true });
    const release = lockSync(path, { realpath: false });
    try {
      let settings = {};
      try {
        settings = JSON.parse(readFileSync4(path, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid Hypium settings");
      if (settings.telemetry !== false) writePrivateFileAtomicSync(path, `${JSON.stringify({ ...settings, telemetry: false })}
`);
    } finally {
      release();
    }
  } catch (error) {
    throw new HarmonyError(
      "AUTOMATION_DRIVER_UNAVAILABLE",
      "Hypium telemetry could not be disabled, so Piora refused to start the third-party driver",
      { cause: error, retryable: true, details: { dispatchState: "not-sent" } }
    );
  }
}
function timeout(promise, milliseconds, message) {
  return new Promise((resolve6, reject) => {
    const timer = setTimeout(() => reject(new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", message, { retryable: true })), milliseconds);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve6(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function withAbort(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new HarmonyError("COMMAND_ABORTED", "Harmony automation was cancelled", { retryable: true }));
  }
  return new Promise((resolve6, reject) => {
    const abort = () => {
      onAbort();
      reject(new HarmonyError("COMMAND_ABORTED", "Harmony automation was cancelled", { retryable: true }));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve6(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}
function matchPattern(module, selector) {
  if (selector.match === "contains") return module.MatchPattern.CONTAINS;
  if (selector.match === "starts_with") return module.MatchPattern.STARTS_WITH;
  if (selector.match === "ends_with") return module.MatchPattern.ENDS_WITH;
  return module.MatchPattern.EQUALS;
}
function selectorBy(module, selector) {
  validateHarmonySelector(selector);
  if (selector.description !== void 0 || selector.visible !== void 0) {
    throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This selector requires Piora's layout fallback instead of Hypium semantic lookup", { details: { dispatchState: "not-sent" } });
  }
  const pattern = matchPattern(module, selector);
  let by;
  const extend = (next, seed) => {
    by = by ? next(by) : seed();
  };
  if (selector.id) extend((source) => source.id(selector.id, pattern), () => module.BY.id(selector.id, pattern));
  if (selector.text) extend((source) => source.text(selector.text, pattern), () => module.BY.text(selector.text, pattern));
  if (selector.type) extend((source) => source.type(selector.type, pattern), () => module.BY.type(selector.type, pattern));
  if (selector.hint) extend((source) => source.hint(selector.hint, pattern), () => module.BY.hint(selector.hint, pattern));
  if (selector.inWindow) extend((source) => source.inWindow(selector.inWindow), () => module.BY.inWindow(selector.inWindow));
  for (const key of ["clickable", "scrollable", "enabled", "focused", "selected", "checked"]) {
    const value = selector[key];
    if (value === void 0) continue;
    extend((source) => source[key](value), () => module.BY[key](value));
  }
  if (!by) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Hypium requires a supported semantic selector field", { details: { dispatchState: "not-sent" } });
  if (selector.within) by = by.within(selectorBy(module, selector.within));
  if (selector.before) by = by.isBefore(selectorBy(module, selector.before));
  if (selector.after) by = by.isAfter(selectorBy(module, selector.after));
  return by;
}
async function resolveSemanticComponent(driver, module, selector, timeoutMs) {
  const by = selectorBy(module, selector);
  const awaited = driver.findComponent(by, timeoutMs);
  if (!await awaited.exist()) {
    throw new HarmonyError("UI_TARGET_NOT_FOUND", "No UI element matched the requested selector", { retryable: true });
  }
  const matches = await driver.findComponents(by);
  if (selector.index !== void 0) {
    const indexed = matches[selector.index];
    if (!indexed) {
      throw new HarmonyError("UI_TARGET_NOT_FOUND", "The requested UI selector index was not found", {
        details: { matchCount: matches.length, requestedIndex: selector.index },
        retryable: true
      });
    }
    return indexed;
  }
  if (matches.length > 1) {
    throw new HarmonyError("UI_TARGET_AMBIGUOUS", "The UI selector matched more than one element; add a stable id, relationship, or index", {
      details: { matchCount: matches.length },
      retryable: true
    });
  }
  return matches[0] ?? awaited;
}
var EDITABLE_TYPES = /* @__PURE__ */ new Set(["TextInput", "TextArea", "TextField", "SearchField", "Search"]);
async function resolveFocusedEditable(driver, module) {
  const focused = await driver.findComponents(module.BY.focused(true));
  const inputs = [];
  for (const component of focused) if (EDITABLE_TYPES.has(await component.getType())) inputs.push(component);
  const unique = /* @__PURE__ */ new Map();
  for (let component of inputs) {
    if (await component.getType() === "Search") {
      const id2 = await component.getId();
      component = await resolveSemanticComponent(driver, module, { type: "SearchField", within: { type: "Search", focused: true, ...id2 ? { id: id2 } : {} } }, 1e3);
    }
    const id = await component.getId();
    const bounds = await component.getBounds();
    unique.set(JSON.stringify([await component.getType(), id, bounds]), component);
  }
  const candidates = [...unique.values()];
  if (candidates.length !== 1) throw new HarmonyError(
    candidates.length ? "UI_TARGET_AMBIGUOUS" : "UI_TARGET_NOT_FOUND",
    candidates.length ? "More than one editable field is focused; use an explicit input selector" : "No editable field is focused; tap an input field before typing",
    { retryable: true, details: { matchCount: candidates.length, dispatchState: "not-sent" } }
  );
  return candidates[0];
}
async function resolveEditableComponent(driver, module, selector, timeoutMs) {
  const component = await resolveSemanticComponent(driver, module, selector, timeoutMs);
  const type = await component.getType();
  if (type === "Search") {
    const id = await component.getId();
    return await resolveSemanticComponent(driver, module, { type: "SearchField", within: { type: "Search", ...id ? { id } : selector } }, timeoutMs);
  }
  if (!EDITABLE_TYPES.has(type)) throw new HarmonyError("INVALID_ARGUMENT", "Text input requires an editable field, not a layout container", { details: { dispatchState: "not-sent" } });
  return component;
}
var HypiumAutomationDriver = class {
  importDriver;
  now;
  preparePrivacy;
  modulePromise;
  sessions = /* @__PURE__ */ new Map();
  ready = /* @__PURE__ */ new Map();
  cooldowns = /* @__PURE__ */ new Map();
  constructor(options) {
    this.importDriver = options.importDriver ?? (async () => {
      const imported = await import("hypium-driver");
      return imported.default ?? imported;
    });
    this.now = options.now ?? Date.now;
    this.preparePrivacy = options.preparePrivacy ?? disableHypiumTelemetry;
  }
  async module() {
    if (!this.modulePromise) {
      this.preparePrivacy();
      this.modulePromise = this.importDriver().catch((error) => {
        this.modulePromise = void 0;
        throw new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", "Unable to load hypium-driver", { cause: error, retryable: true, details: { dispatchState: "not-sent" } });
      });
    }
    return await this.modulePromise;
  }
  async connect(serial) {
    const coolingUntil = this.cooldowns.get(serial) ?? 0;
    if (coolingUntil > this.now()) {
      throw new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", "Hypium is cooling down after a connection failure", {
        details: { dispatchState: "not-sent", retryAt: new Date(coolingUntil).toISOString() },
        retryable: true
      });
    }
    const existing = this.sessions.get(serial);
    if (existing) return await existing;
    const connection = (async () => {
      const driverModule = await this.module();
      try {
        const rawConnection = driverModule.UiDriver.connect({
          deviceSn: serial,
          hdcExecTimeout: 15e3,
          rpcTimeout: 3e4,
          implicitWaitTime: 1e3,
          samplingTime: 15
        });
        let driver;
        try {
          driver = await timeout(rawConnection, CONNECT_TIMEOUT_MS, "Timed out connecting the Hypium automation driver");
        } catch (error) {
          void rawConnection.then(async (lateDriver) => await lateDriver.disconnect()).catch(() => void 0);
          throw error;
        }
        this.ready.set(serial, driver);
        this.cooldowns.delete(serial);
        return driver;
      } catch (error) {
        this.cooldowns.set(serial, this.now() + DRIVER_COOLDOWN_MS);
        throw new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", "Hypium could not connect to the Harmony device", {
          cause: error,
          retryable: true,
          details: { dispatchState: "not-sent" }
        });
      }
    })();
    this.sessions.set(serial, connection);
    try {
      return await connection;
    } catch (error) {
      if (this.sessions.get(serial) === connection) this.sessions.delete(serial);
      throw error;
    }
  }
  async run(serial, operation, signal, task, allowConnect = true) {
    if (!allowConnect && !this.ready.has(serial)) throw new HarmonyError("AUTOMATION_DRIVER_UNAVAILABLE", "Live video requires an existing UI agent; initialization was deferred", { details: { dispatchState: "not-sent" } });
    const driver = await withAbort(this.connect(serial), signal, () => {
      void this.invalidate(serial);
    });
    const driverModule = await this.module();
    try {
      return await withAbort(task(driver, driverModule), signal, () => {
        void this.invalidate(serial);
      });
    } catch (error) {
      if (error instanceof HarmonyError) throw error;
      await this.invalidate(serial);
      throw new HarmonyError("AUTOMATION_DRIVER_FAILED", "Hypium automation failed", {
        cause: error,
        details: { operation },
        retryable: true
      });
    }
  }
  async tryRun(serial, operation, signal, task, allowConnect = true) {
    try {
      const value = await this.run(serial, operation, signal, task, allowConnect);
      return { used: true, value };
    } catch (error) {
      if (error instanceof HarmonyError && error.code === "AUTOMATION_DRIVER_UNAVAILABLE") return { used: false };
      throw error;
    }
  }
  async execute(serial, operation, args, signal, allowConnect = true) {
    return await this.tryRun(serial, operation, signal, async (driver, module) => {
      if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Driver operation cancelled", { details: { dispatchState: "not-sent" } });
      const n = args.map(Number);
      if (operation === "tap") return await driver.click(n[0], n[1]);
      if (operation === "double_tap") return await driver.doubleClick(n[0], n[1]);
      if (operation === "long_press") return await driver.longClick(n[0], n[1]);
      if (operation === "swipe" || operation === "drag") return await driver[operation](n[0], n[1], n[2], n[3], n[4]);
      if (operation === "fling") return await driver.fling(n[0], n[1], n[2], n[3], 20, n[4]);
      if (operation === "press_key") {
        if (args[0] === "back") return await driver.pressBack();
        if (args[0] === "home") return await driver.pressHome();
        if (args[0] !== "recents" && args[0] !== "enter") throw new HarmonyError("INVALID_ARGUMENT", "Unsupported logical key");
        return await driver.triggerKey(args[0] === "recents" ? module.KeyCode.APPSELECT : module.KeyCode.ENTER);
      }
      if (operation === "input_text") {
        const component = await resolveFocusedEditable(driver, module);
        if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Text operation cancelled");
        await component.inputText(String(args[0]));
        if (await component.getText() !== args[0]) throw new HarmonyError("SCENARIO_FAILED", "Focused text readback mismatch", { details: { dispatchState: "sent", verification: "failed" } });
        return;
      }
      throw new HarmonyError("INVALID_ARGUMENT", "Unsupported worker operation");
    }, allowConnect);
  }
  async semanticAction(serial, request, signal, allowConnect = true) {
    if (request.action === "scroll_find") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Use bounded layout scrolling; Hypium scrollSearch cannot enforce a swipe budget", { details: { dispatchState: "not-sent" } });
    return await this.run(serial, request.action, signal, async (driver, module) => {
      const timeoutMs = Math.max(100, Math.min(6e4, Math.round(request.timeoutMs ?? 3e3)));
      const component = request.action === "input_text" || request.action === "clear_text" ? await resolveEditableComponent(driver, module, request.selector, timeoutMs) : await resolveSemanticComponent(driver, module, request.selector, timeoutMs);
      if (!await component.exist()) throw new HarmonyError("UI_TARGET_NOT_FOUND", "No UI element matched the requested selector", { retryable: true });
      const check = () => {
        if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Semantic action was cancelled", { details: { dispatchState: "not-sent" } });
      };
      check();
      if (request.action === "tap") await component.click();
      else if (request.action === "double_tap") await component.doubleClick();
      else if (request.action === "long_press") await component.longClick();
      else if (request.action === "input_text" || request.action === "clear_text") {
        if (request.action === "input_text" && typeof request.text !== "string") throw new HarmonyError("INVALID_ARGUMENT", "Semantic text input requires text");
        const before = await component.getText();
        const expected = request.action === "clear_text" ? "" : (request.append ? before : "") + request.text;
        check();
        if (request.action === "clear_text") await component.clearText();
        else await component.inputText(request.text, request.append ? { addition: true } : void 0);
        const after = await component.getText();
        if (after !== expected) throw new HarmonyError("SCENARIO_FAILED", "Text readback did not match the requested value", {
          details: { dispatchState: "sent", effect: "unknown", verification: "failed", expectedLength: expected.length, actualLength: after.length }
        });
      }
      return { strategy: "hypium_semantic_rpc" };
    }, allowConnect);
  }
  async waitForIdle(serial, idleMs, timeoutMs, signal, allowConnect = true) {
    const result = await this.tryRun(serial, "wait_for_idle", signal, async (driver) => {
      await driver.waitForIdle(idleMs, timeoutMs);
      return true;
    }, allowConnect);
    return result.used;
  }
  status() {
    const serials = /* @__PURE__ */ new Set([...this.sessions.keys(), ...this.cooldowns.keys()]);
    return [...serials].map((serial) => {
      if (this.ready.has(serial)) return { serial, state: "ready" };
      if (this.sessions.has(serial)) return { serial, state: "connecting" };
      const retryAt = this.cooldowns.get(serial);
      return retryAt && retryAt > this.now() ? { serial, state: "cooldown", retryAt: new Date(retryAt).toISOString() } : { serial, state: "idle" };
    });
  }
  async invalidate(serial) {
    const promise = this.sessions.get(serial);
    this.sessions.delete(serial);
    const driver = this.ready.get(serial);
    this.ready.delete(serial);
    const resolved = driver ?? await promise?.catch(() => void 0);
    if (resolved) await timeout(Promise.resolve(resolved.disconnect()), 5e3, "Timed out disconnecting Hypium").catch(() => void 0);
  }
  async reset(serial) {
    if (serial) {
      this.cooldowns.delete(serial);
      await this.invalidate(serial);
      return;
    }
    const serials = /* @__PURE__ */ new Set([...this.sessions.keys(), ...this.ready.keys(), ...this.cooldowns.keys()]);
    this.cooldowns.clear();
    await Promise.all([...serials].map(async (value) => await this.invalidate(value)));
  }
};
export {
  HybridHarmonyBackend,
  HypiumAutomationDriver
};
