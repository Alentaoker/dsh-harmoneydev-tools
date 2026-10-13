import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { HarmonyError } from './errors';
import type { HarmonyVideoConnection } from './types';
import { acquireDeviceLock, sharedDeviceLockDirectory } from './runtime/device-lock';

const MAX_PACKET = 8 * 1024 * 1024 + 8;
const brokers = new Map<string, Promise<Broker>>();
const viewers = new Map<string, number>();
export const sharedVideoDirectory = () => join(dirname(sharedDeviceLockDirectory()), 'video-broker');
export const sharedVideoStreaming = (serial: string) => (viewers.get(serial) ?? 0) > 0;

export interface SharedVideoOptions {
  serial: string;
  signal?: AbortSignal;
  directory?: string;
  openSource(signal: AbortSignal): Promise<HarmonyVideoConnection>;
  /** Internal limits/clock seams for lifecycle tests. Never sent by the UI. */
  idleMs?: number;
  replayBytes?: number;
  peerQueueBytes?: number;
  maxViewers?: number;
}
interface Record { version: 1; pid: number; nonce: string; port: number; token: string }
interface Peer { socket: Socket; acknowledged: boolean; waitingKey: boolean }
interface Broker { record: Record; closing: boolean; stopped: Promise<void>; stop(): Promise<void> }

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function recordPath(directory: string, serial: string) {
  return join(directory, createHash('sha256').update(serial).digest('hex') + '.broker.json');
}
function readRecord(path: string): Record | undefined {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    throw new HarmonyError('DEVICE_BUSY', 'Invalid video broker ownership path');
  }
  let record: Record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new HarmonyError('DEVICE_BUSY', 'Invalid video broker ownership record; explicit recovery is required'); }
  if (record?.version !== 1 || !Number.isInteger(record.pid) || record.pid < 1
    || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
    || !/^[a-f0-9-]{36}$/.test(record.nonce) || !/^[a-f0-9]{64}$/.test(record.token)) {
    throw new HarmonyError('DEVICE_BUSY', 'Invalid video broker ownership record; explicit recovery is required');
  }
  return record;
}
function aborted() { return new HarmonyError('COMMAND_ABORTED', 'Video subscription cancelled'); }

/** One encoder per physical device, including across desktop/web host processes.
 * Loopback clients can only subscribe. Input ownership is entirely separate.
 */
async function createBroker(options: SharedVideoOptions, directory: string, key: string): Promise<Broker> {
  const lock = acquireDeviceLock(options.serial, directory);
  const path = recordPath(directory, options.serial);
  const controller = new AbortController();
  const peers = new Set<Peer>();
  const sockets = new Set<Socket>();
  let source: Promise<HarmonyVideoConnection> | undefined;
  let connection: HarmonyVideoConnection | undefined;
  let ready = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopPromise: Promise<void> | undefined;
  let config: Buffer | undefined;
  let replay: Buffer[] = [];
  let replaySize = 0;
  let replayValid = false;
  const replayLimit = options.replayBytes ?? 8 * 1024 * 1024;
  const queueLimit = options.peerQueueBytes ?? 16 * 1024 * 1024;
  const server = createServer(socket => {
    sockets.add(socket);
    clearTimeout(idleTimer);
    socket.setNoDelay(true);
    let peer: Peer | undefined;
    let input = '';
    const handshakeTimer = setTimeout(() => socket.destroy(), 3000);
    const detach = () => {
      clearTimeout(handshakeTimer);
      sockets.delete(socket);
      if (peer) peers.delete(peer);
      armIdle();
    };
    socket.on('error', () => {});
    socket.once('close', detach);
    socket.on('data', bytes => {
      input += bytes.toString('utf8');
      if (input.length > 1024) { socket.destroy(); return; }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      let message: { token?: string; op?: string };
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!peer) {
        if (broker.closing || message?.token !== broker.record.token || peers.size >= (options.maxViewers ?? 16)) {
          socket.end(JSON.stringify({ ok: false, code: 'DEVICE_BUSY', message: 'Video subscription unavailable' }) + '\n');
          return;
        }
        clearTimeout(handshakeTimer);
        peer = { socket, acknowledged: false, waitingKey: true };
        peers.add(peer);
        if (ready) acknowledge(peer);
        else if (!source) {
          source = Promise.resolve().then(() => options.openSource(controller.signal));
          void pump().catch(() => {});
        }
      } else if (message?.op === 'close') {
        // A graceful last unsubscribe waits for exact daemon/forward cleanup.
        peers.delete(peer);
        sockets.delete(socket);
        clearTimeout(idleTimer);
        const done = peers.size || sockets.size ? Promise.resolve() : broker.stop();
        void done.then(() => socket.end(), () => socket.destroy());
      } else socket.destroy();
    });
  });
  const broker: Broker = {
    record: { version: 1, pid: process.pid, nonce: lock.owner.nonce, port: 0, token: randomBytes(32).toString('hex') },
    closing: false,
    get stopped() { return stopPromise ?? Promise.resolve(); },
    stop() {
      return stopPromise ??= (async () => {
        broker.closing = true;
        clearTimeout(idleTimer);
        server.close();
        controller.abort();
        let failure: unknown;
        try {
          connection ??= await source?.catch(() => undefined);
          await connection?.close();
        } catch (error) { failure = error; }
        for (const socket of sockets) socket.destroy();
        sockets.clear(); peers.clear(); replay = []; config = undefined;
        // Only retire our own record. Retain malformed/changed evidence.
        try {
          if (readRecord(path)?.nonce === broker.record.nonce) rmSync(path);
          else if (existsSync(path)) throw new HarmonyError('DEVICE_BUSY', 'Video broker ownership changed during cleanup');
        } catch (error) { failure ??= error; }
        try { lock.release(); } catch (error) { failure ??= error; }
        if (await brokers.get(key)?.catch(() => undefined) === broker) brokers.delete(key);
        if (failure) throw failure;
      })();
    },
  };
  function armIdle() {
    clearTimeout(idleTimer);
    if (!broker.closing && !peers.size && !sockets.size) {
      idleTimer = setTimeout(() => void broker.stop().catch(() => {}), options.idleMs ?? 750);
      idleTimer.unref?.();
    }
  }
  function send(peer: Peer, packet: Uint8Array) {
    if (peer.socket.destroyed) return false;
    if (peer.socket.writableLength + packet.byteLength > queueLimit) {
      // A slow viewer must not pause the encoder or accumulate an unbounded tee.
      peers.delete(peer); peer.socket.destroy(); return false;
    }
    peer.socket.write(packet); return true;
  }
  function acknowledge(peer: Peer) {
    if (peer.socket.destroyed || peer.acknowledged) return;
    peer.acknowledged = true;
    send(peer, Buffer.from(JSON.stringify({ ok: true, changeDriven: connection?.changeDriven === true }) + '\n'));
    if (replayValid) {
      for (const packet of replay) if (!send(peer, packet)) break;
      peer.waitingKey = false;
    }
  }
  function distribute(bytes: Uint8Array) {
    // The native packetizer supplies one complete packet per chunk. TCP clients
    // retain the existing fragmented-packet protocol and bounded browser parser.
    const packet = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (packet.length < 8 || packet.length > MAX_PACKET || packet.readUInt32BE(4) !== packet.length - 8) {
      throw new HarmonyError('INVALID_RESPONSE', 'Invalid shared video packet');
    }
    const type = packet.readUInt32BE();
    if (type === 2) {
      if (packet.length < 21) throw new HarmonyError('INVALID_RESPONSE', 'Invalid shared video configuration');
      config = packet; replay = []; replaySize = 0; replayValid = false;
      for (const peer of peers) peer.waitingKey = true;
      return;
    }
    if (type !== 3 || packet.length < 17) throw new HarmonyError('INVALID_RESPONSE', 'Invalid shared video picture');
    const keyframe = packet[8] === 1;
    if (keyframe && config) {
      replay = [config, packet]; replaySize = config.length + packet.length;
      replayValid = replaySize <= replayLimit;
      if (!replayValid) replay = [];
    } else if (replayValid) {
      replaySize += packet.length;
      if (replaySize <= replayLimit) replay.push(packet);
      else { replay = []; replayValid = false; }
    }
    for (const peer of peers) {
      if (!peer.acknowledged) continue;
      if (peer.waitingKey) {
        if (!keyframe || !config) continue;
        if (!send(peer, config)) continue;
        peer.waitingKey = false;
      }
      send(peer, packet);
    }
  }
  async function pump() {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      connection = await source!;
      if (broker.closing) { await connection.close(); return; }
      ready = true;
      for (const peer of peers) acknowledge(peer);
      reader = connection.stream.getReader();
      while (!broker.closing) {
        const next = await reader.read();
        if (next.done) throw new HarmonyError('CAPABILITY_UNAVAILABLE', 'Shared native video ended');
        distribute(next.value);
      }
    } catch (error) {
      if (!broker.closing) {
        for (const peer of peers) if (!peer.acknowledged) {
          peer.socket.write(JSON.stringify({ ok: false, code: (error as any)?.code ?? 'CAPABILITY_UNAVAILABLE',
            message: error instanceof Error ? error.message.slice(0, 512) : 'Shared native video failed' }) + '\n');
        }
        await broker.stop();
      }
    } finally { reader?.releaseLock(); }
  }
  try {
    // Reject untrusted ownership evidence even when the former owner is dead.
    readRecord(path);
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); accept(); });
    });
    server.on('error', () => void broker.stop().catch(() => {}));
    broker.record.port = (server.address() as { port: number }).port;
    const temporary = path + '.' + lock.owner.nonce + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(broker.record), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
    armIdle();
    return broker;
  } catch (error) {
    server.close(); lock.release(); throw error;
  }
}

async function locateBroker(options: SharedVideoOptions): Promise<Record> {
  const directory = resolve(options.directory ?? sharedVideoDirectory());
  const key = recordPath(directory, options.serial);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw aborted();
    const local = brokers.get(key);
    if (local) {
      const broker = await local;
      if (!broker.closing) return broker.record;
      await broker.stopped;
      continue;
    }
    const previous = readRecord(key);
    if (previous && alive(previous.pid)) return previous;
    const starting = createBroker(options, directory, key);
    brokers.set(key, starting);
    try { return (await starting).record; }
    catch (error) {
      if (brokers.get(key) === starting) brokers.delete(key);
      if (!(error instanceof HarmonyError) || error.code !== 'DEVICE_BUSY') throw error;
      // A different process may be publishing its loopback listener right now.
      if (readRecord(key)) continue;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new HarmonyError('DEVICE_BUSY', 'Video ownership is changing; reconnect after cleanup');
}

export async function openSharedVideo(options: SharedVideoOptions): Promise<HarmonyVideoConnection> {
  if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(options.serial)) throw new HarmonyError('INVALID_ARGUMENT', 'Invalid device serial');
  const record = await locateBroker(options);
  if (options.signal?.aborted) throw aborted();
  return new Promise((accept, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: record.port });
    socket.setNoDelay(true);
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let header = Buffer.alloc(0);
    let acknowledged = false, closed = false, counted = false;
    let closing: Promise<void> | undefined;
    let closeResolve: (() => void) | undefined;
    let closeReject: ((error: Error) => void) | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let finish: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const timer = setTimeout(() => fail(new HarmonyError('CAPABILITY_UNAVAILABLE', 'Shared video start timed out')), 40_000);
    const uncount = () => {
      if (!counted) return; counted = false;
      const count = (viewers.get(options.serial) ?? 1) - 1;
      if (count > 0) viewers.set(options.serial, count); else viewers.delete(options.serial);
    };
    const settle = () => {
      clearTimeout(timer); clearTimeout(closeTimer);
      options.signal?.removeEventListener('abort', abort);
      closed = true; uncount(); finish();
    };
    const fail = (error: Error) => {
      if (closed) return;
      settle();
      reject(error); try { controller?.error(error); } catch {}
      socket.destroy(); closeReject?.(error);
    };
    const abort = () => fail(aborted());
    const close = () => closing ??= new Promise<void>((resolveClose, rejectClose) => {
      if (closed) { resolveClose(); return; }
      closed = true; uncount();
      options.signal?.removeEventListener('abort', abort);
      closeResolve = resolveClose; closeReject = rejectClose;
      try { controller.close(); } catch {}
      // Keep draining queued video while the last unsubscribe awaits cleanup.
      socket.resume();
      socket.write(JSON.stringify({ op: 'close' }) + '\n');
      closeTimer = setTimeout(() => {
        socket.destroy(); rejectClose(new HarmonyError('DEVICE_BUSY', 'Video unsubscribe cleanup was not confirmed'));
      }, 15_000);
    });
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() { socket.resume(); },
      cancel() { return close(); },
    }, { highWaterMark: 512 * 1024, size: value => value.byteLength });
    const enqueue = (bytes: Uint8Array) => {
      if (!bytes.length || closed) return;
      controller.enqueue(bytes);
      if ((controller.desiredSize ?? 0) <= 0) socket.pause();
    };
    socket.once('connect', () => socket.write(JSON.stringify({ token: record.token }) + '\n'));
    socket.on('data', bytes => {
      if (closed) return;
      if (acknowledged) { enqueue(bytes); return; }
      const newline = bytes.indexOf(10);
      if (header.length + (newline < 0 ? bytes.length : newline) > 2048) { fail(new Error('Invalid video broker response')); return; }
      if (newline < 0) { header = Buffer.concat([header, bytes]); return; }
      let response: { ok: boolean; changeDriven?: boolean; code?: any; message?: string };
      try { response = JSON.parse(Buffer.concat([header, bytes.subarray(0, newline)]).toString('utf8')); }
      catch { fail(new Error('Invalid video broker response')); return; }
      if (response?.ok !== true) { fail(new HarmonyError(response?.code ?? 'CAPABILITY_UNAVAILABLE', response?.message ?? 'Video subscription rejected')); return; }
      header = Buffer.alloc(0); acknowledged = true; counted = true;
      viewers.set(options.serial, (viewers.get(options.serial) ?? 0) + 1);
      clearTimeout(timer);
      enqueue(bytes.subarray(newline + 1));
      accept({ stream, changeDriven: response.changeDriven === true, isLive: () => !closed && !socket.destroyed, finished, close });
    });
    socket.on('error', error => { if (!closed) fail(error); else { clearTimeout(closeTimer); closeReject?.(error); } });
    socket.once('end', () => { if (!closed) fail(new HarmonyError('CAPABILITY_UNAVAILABLE', 'Shared native video disconnected')); });
    socket.once('close', () => {
      if (!closed) fail(new HarmonyError('CAPABILITY_UNAVAILABLE', 'Shared native video disconnected'));
      settle(); closeResolve?.();
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
