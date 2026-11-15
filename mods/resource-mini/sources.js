// Platform-specific command execution and collector creation.
// Uses parse.js for output parsing; no herdr imports here.

import { exec } from "herdr";
import {
  parsePsMac, parseLsof, parseSysMac, assembleMac,
  parsePsLinux, parseSs, parseSysLinux, parseProcStat, cpuFromSamples, assembleLinux,
  parseWindows, assembleWindows,
  LINUX_SCRIPT, LINUX_MARK,
} from "./parse.js";

export function platform() {
  // In Herdr's gpui-kit environment, use process.platform or fallback to uname
  try {
    const p = typeof process !== "undefined" ? process.platform : "";
    if (p === "win32") return "win";
    if (p === "linux") return "linux";
    return "mac";
  } catch {
    return "mac";
  }
}

// macOS / BSD: run ps, lsof, vm_stat, sysctl in parallel
export async function collectMac() {
  const [ps, lsof, vmStat, sysctl] = await Promise.all([
    exec("ps", ["-axo", "pid=,pcpu=,rss=,user=,comm="]),
    exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-iUDP", "-F", "pPn"]),
    exec("vm_stat"),
    exec("sysctl", ["-n", "hw.memsize", "hw.ncpu", "vm.swapusage", "vm.loadavg", "kern.memorystatus_level"]),
  ]);
  if (ps.code !== 0 || lsof.code !== 0 || vmStat.code !== 0 || sysctl.code !== 0) {
    throw new Error("macOS collectors failed");
  }
  return assembleMac(ps.stdout, lsof.stdout, vmStat.stdout, sysctl.stdout);
}

// Linux: one script, split by markers
export async function collectLinux() {
  const prev = globalThis.__rm_linux_prev ?? null;
  const r = await exec("sh", ["-c", LINUX_SCRIPT]);
  if (r.code !== 0) throw new Error("Linux collector failed");
  const result = assembleLinux(r.stdout, prev);
  globalThis.__rm_linux_prev = result.sample;
  return { procs: result.procs, sys: result.sys };
}

// Windows: PowerShell JSON output
const WIN_SCRIPT = `
$ErrorActionPreference = "Stop"
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,WorkingSetSize
$tcp = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalPort
$udp = Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalPort
$mem = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,SizeStoredInPagingFiles,FreeSpaceInPagingFiles
$cpu = Get-CimInstance Win32_Processor | Select-Object NumberOfLogicalProcessors
$pfs = @{}
foreach ($p in $procs) { $pfs[$p.ProcessId] = $p }
$out = @{
  procs = $procs | ForEach-Object { @{ i=$_.ProcessId; n=$_.Name; m=$_.WorkingSetSize; c=0; f=$_.CommandLine } }
  tcp = $tcp | ForEach-Object { @{ p=$_.OwningProcess; l=$_.LocalPort } }
  udp = $udp | ForEach-Object { @{ p=$_.OwningProcess; l=$_.LocalPort } }
  totalKb = $mem.TotalVisibleMemorySize
  freeKb = $mem.FreePhysicalMemory
  pfTotal = [math]::Round($mem.SizeStoredInPagingFiles / 1024)
  pfUsed = [math]::Round(($mem.SizeStoredInPagingFiles - $mem.FreeSpaceInPagingFiles) / 1024)
  ncpu = $cpu.NumberOfLogicalProcessors
}
$out | ConvertTo-Json -Depth 3 -Compress
`;

export async function collectWin() {
  const prev = globalThis.__rm_win_prev ?? null;
  const r = await exec("powershell", ["-NoProfile", "-Command", WIN_SCRIPT]);
  if (r.code !== 0) throw new Error("Windows collector failed");
  const result = assembleWindows(r.stdout, prev);
  globalThis.__rm_win_prev = result.sample;
  return { procs: result.procs, sys: result.sys };
}

// Kill a process by PID
export async function killProcess(pid, signal, os) {
  if (os === "win") {
    return exec("taskkill", signal === "KILL" ? ["/F", "/PID", String(pid)] : ["/PID", String(pid)]);
  }
  const sig = signal === "KILL" ? "-9" : "-15";
  return exec("kill", [sig, String(pid)]);
}

// Factory
export function makeCollector(os) {
  if (os === "win") return collectWin;
  if (os === "linux") return collectLinux;
  return collectMac;
}