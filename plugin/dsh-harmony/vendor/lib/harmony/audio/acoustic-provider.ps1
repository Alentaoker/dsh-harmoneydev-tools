param([ValidateSet('list','play')][string]$Action = 'list', [int]$DeviceId = -1, [string]$ExpectedName, [string]$AssetPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class PioraWaveOut {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Caps { public ushort manufacturer, product; public uint version; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name; public uint formats; public ushort channels,reserved; public uint support; }
  [StructLayout(LayoutKind.Sequential, Pack=2)] public struct Format { public ushort tag,channels; public uint rate,average; public ushort align,bits,extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Header { public IntPtr data; public uint length,recorded; public IntPtr user; public uint flags,loops; public IntPtr next,reserved; }
  [DllImport("winmm.dll")] public static extern uint waveOutGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Unicode)] public static extern uint waveOutGetDevCapsW(UIntPtr id,out Caps caps,uint size);
  [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr handle,uint id,ref Format format,IntPtr callback,IntPtr instance,uint flags);
  [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr handle,IntPtr header,uint size);
  [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr handle,IntPtr header,uint size);
  [DllImport("winmm.dll")] static extern uint waveOutReset(IntPtr handle);
  [DllImport("winmm.dll")] static extern uint waveOutUnprepareHeader(IntPtr handle,IntPtr header,uint size);
  [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr handle);
  static void Check(uint code) { if(code!=0) throw new Exception("Wave output error: "+code); }
  public static string Name(uint id) { Caps caps; Check(waveOutGetDevCapsW((UIntPtr)id,out caps,(uint)Marshal.SizeOf(typeof(Caps)))); return caps.name; }
  public static void Play(uint id,string name,string path) {
    if(Name(id)!=name) throw new Exception("Selected output device changed; recalibrate");
    byte[] wav=File.ReadAllBytes(path); Format f=new Format(); byte[] pcm=null;
    for(int o=12;o+8<=wav.Length;) { int n=BitConverter.ToInt32(wav,o+4); int s=o+8; if(n<0||n>wav.Length-s) throw new Exception("Invalid WAV"); string tag=System.Text.Encoding.ASCII.GetString(wav,o,4);
      if(tag=="fmt ") { f.tag=BitConverter.ToUInt16(wav,s); f.channels=BitConverter.ToUInt16(wav,s+2); f.rate=BitConverter.ToUInt32(wav,s+4); f.average=BitConverter.ToUInt32(wav,s+8); f.align=BitConverter.ToUInt16(wav,s+12); f.bits=BitConverter.ToUInt16(wav,s+14); }
      if(tag=="data") { pcm=new byte[n]; Array.Copy(wav,s,pcm,0,n); } o=s+n+(n%2);
    }
    if(pcm==null||f.tag!=1||f.bits!=16) throw new Exception("Only PCM16 is supported");
    IntPtr handle=IntPtr.Zero,header=IntPtr.Zero; GCHandle pinned=new GCHandle(); bool prepared=false;
    try { Check(waveOutOpen(out handle,id,ref f,IntPtr.Zero,IntPtr.Zero,0)); pinned=GCHandle.Alloc(pcm,GCHandleType.Pinned);
      Header h=new Header(); h.data=pinned.AddrOfPinnedObject(); h.length=(uint)pcm.Length; header=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Header))); Marshal.StructureToPtr(h,header,false);
      Check(waveOutPrepareHeader(handle,header,(uint)Marshal.SizeOf(typeof(Header)))); prepared=true;
      Check(waveOutWrite(handle,header,(uint)Marshal.SizeOf(typeof(Header)))); DateTime deadline=DateTime.UtcNow.AddSeconds(35);
      while((((Header)Marshal.PtrToStructure(header,typeof(Header))).flags&1)==0) { if(DateTime.UtcNow>deadline) throw new Exception("Playback timeout"); Thread.Sleep(10); }
    } finally { if(handle!=IntPtr.Zero) { waveOutReset(handle); if(prepared) waveOutUnprepareHeader(handle,header,(uint)Marshal.SizeOf(typeof(Header))); waveOutClose(handle); } if(header!=IntPtr.Zero) Marshal.FreeHGlobal(header); if(pinned.IsAllocated) pinned.Free(); }
  }
}
'@
if ($Action -eq 'list') {
  $devices = @(for ($i=0; $i -lt [PioraWaveOut]::waveOutGetNumDevs(); $i++) { @{ id=$i; name=[PioraWaveOut]::Name($i); provider='windows-waveout' } })
  ConvertTo-Json -InputObject $devices -Compress
} else {
  if ($DeviceId -lt 0 -or [string]::IsNullOrWhiteSpace($ExpectedName) -or -not [IO.Path]::IsPathRooted($AssetPath)) { throw 'Select an output and a local audio asset' }
  [PioraWaveOut]::Play($DeviceId,$ExpectedName,$AssetPath)
  '{"playback":"completed","recognition":"not-verified"}'
}
