import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { getHost } from './state';
import { getHarmonyDeviceManager } from '../vendor/lib/harmony';
import { resolveHarmonyStorage } from '../vendor/lib/harmony/artifacts';
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } from './file-access';
import { parseJsonWithinLimit } from '../vendor/lib/bounded-json';

async function powershell(script: string, input: unknown, signal?: AbortSignal) {
  return await new Promise<string>((resolve, reject) => {
    const program = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json;${script}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) child.kill();
    child.stdout.on('data', data => { output += data; if (output.length > 1_000_000) child.kill(); });
    child.stderr.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('close', code => { signal?.removeEventListener('abort', abort); code === 0 ? resolve(output) : reject(new Error(signal?.aborted ? '操作已取消' : error || `Desktop operation failed (${code})`)); });
    child.stdin.end(JSON.stringify(input));
  });
}
async function authorizedMediaPath(p: unknown) {
  if (typeof p !== 'string' || !isAbsolute(p) || !existsSync(p)) throw new Error('Invalid media path');
  const storage = resolveHarmonyStorage(getHarmonyDeviceManager().getConfig());
  if (!isExistingFilePathAllowed(p, new Set([storage.screenshotDirectory, storage.recordingDirectory]))) throw new Error('Choose a Harmony media file');
  return p;
}
const desktop = {
  path: '/api/harmony/desktop', methods: ['POST'], requestBody: 'streaming',
  async fetch(request: Request) {
    try {
      const data = await parseJsonWithinLimit(request, 16 * 1024) as any;
      let result: unknown;
      if (data.action === 'choose-runtime') {
        const script = data.kind === 'hdc'
          ? `Add-Type -AssemblyName System.Windows.Forms;$dialog=New-Object Windows.Forms.OpenFileDialog;$dialog.Filter='HDC|hdc.exe';if($dialog.ShowDialog() -eq 'OK'){$dialog.FileName}`
          : `Add-Type -AssemblyName System.Windows.Forms;$dialog=New-Object Windows.Forms.FolderBrowserDialog;$dialog.Description='选择 Harmony SDK 或 DevEco Studio 目录';if($dialog.ShowDialog() -eq 'OK'){$dialog.SelectedPath}`;
        result = (await powershell(script, {}, request.signal)).trim() || null;
      } else if (data.action === 'open-media') {
        const path = await authorizedMediaPath(data.path);
        await powershell(`Start-Process -FilePath $inputData.path -WindowStyle Hidden`, { path }, request.signal); result = true;
      } else if (data.action === 'copy-media') {
        const path = await authorizedMediaPath(data.path);
        await powershell(`Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;if($inputData.kind -eq 'screenshot'){$image=[Drawing.Image]::FromFile($inputData.path);try{[Windows.Forms.Clipboard]::SetImage($image)}finally{$image.Dispose()}}else{$files=New-Object Collections.Specialized.StringCollection;[void]$files.Add($inputData.path);[Windows.Forms.Clipboard]::SetFileDropList($files)}`, { path, kind: data.kind }, request.signal); result = true;
      } else if (data.action === 'clipboard-read') {
        result = await powershell(`Add-Type -AssemblyName System.Windows.Forms;[Console]::Write([Windows.Forms.Clipboard]::GetText())`, {}, request.signal);
      } else if (data.action === 'clipboard-write') {
        if (typeof data.text !== 'string' || data.text.length > 12_000) throw new Error('Clipboard text is too large');
        await powershell(`Add-Type -AssemblyName System.Windows.Forms;[Windows.Forms.Clipboard]::SetText($inputData.text)`, { text: data.text }, request.signal); result = true;
      } else if (data.action === 'authorize-drop') {
        // Dropped paths must already belong to a session's workspace. A request cannot grant itself access.
        if (!Array.isArray(data.paths) || data.paths.length > 20) throw new Error('Choose at most 20 files');
        const roots = await getAllowedFileRoots();
        if (data.paths.some((p: unknown) => typeof p !== 'string' || !isExistingFilePathAllowed(p, roots))) throw new Error('Files must belong to a Harness workspace');
        result = true;
      } else throw new Error('Unknown desktop operation');
      return Response.json({ result }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
  },
};
const session = {
  path: '/api/harmony/dsh-session', methods: ['GET'], requestBody: 'buffered',
  async fetch(request: Request) {
    const id = new URL(request.url).searchParams.get('sessionId');
    const session = getHost().sessions.list().find((s: any) => s.id === id);
    return Response.json({ cwd: session?.header.cwd || null });
  },
};
export const desktopRoutes: any[] = [desktop, session];
