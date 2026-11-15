// Resource Monitor — CPU/memory/system + process list with ports, search, sort, kill.
// Adapted from chuangmaster/herdr-agent-team/mods/resource-monitor for sidebar panel use.
// Runs ps/vm_stat/lsof on macOS; ss/ps/meminfo on Linux; PowerShell on Windows.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, settings, notify, props, layout, shared, setShared } from "herdr";
import { makeCollector, killProcess, platform } from "./sources.js";

const MAX_ROWS = 300;
const SETTINGS_KEY = "resource-monitor.settings";
const DEFAULTS = { lang: "en", intervalSec: 3 };
const INTERVALS = [1, 2, 3, 5, 10, 30, 0]; // 0 = paused

const I18N = {
  "zh-TW": {
    title: "Resource",
    summary: (n, ports, time) => `${n} processes · ${ports} with ports · ${time}`,
    cpuLabel: "CPU",
    cores: (n) => `${n} cores`,
    load: "Load",
    memLabel: "Memory",
    app: "App",
    wired: "Wired",
    compressed: "Compressed",
    cached: "Cached",
    used: "Used",
    swap: "Swap",
    pressure: "Pressure",
    placeholder: "Search name / PID / port (:5173 ports only)",
    sort: "Sort",
    cpu: "CPU",
    mem: "Memory",
    port: "Port",
    portsOnly: "With ports only",
    empty: "No matching processes",
    loading: "Loading…",
    more: (n) => `${n} more, narrow search`,
    term: "Terminate",
    kill: "Force kill",
    cancel: "Cancel",
    sent: (sig) => (sig === "KILL" ? "Force killed" : "Asked to quit"),
    failed: (name) => `Couldn't terminate ${name}`,
    refreshFailed: (e) => `Refresh failed: ${e}`,
    settings: "Settings",
    language: "Language",
    interval: "Refresh every",
    seconds: (n) => `${n}s`,
    paused: "Paused",
    refreshNow: "Refresh now",
    pausedNote: "Auto refresh paused",
  },
  en: {
    title: "Resource",
    summary: (n, ports, time) => `${n} procs · ${ports} ports · ${time}`,
    cpuLabel: "CPU",
    cores: (n) => `${n} cores`,
    load: "Load",
    memLabel: "Memory",
    app: "App",
    wired: "Wired",
    compressed: "Compressed",
    cached: "Cached",
    used: "Used",
    swap: "Swap",
    pressure: "Pressure",
    placeholder: "Search name / PID / port (:5173 ports only)",
    sort: "Sort",
    cpu: "CPU",
    mem: "Memory",
    port: "Port",
    portsOnly: "With ports only",
    empty: "No matching processes",
    loading: "Loading…",
    more: (n) => `${n} more, narrow search`,
    term: "Terminate",
    kill: "Force kill",
    cancel: "Cancel",
    sent: (sig) => (sig === "KILL" ? "Force killed" : "Asked to quit"),
    failed: (name) => `Couldn't terminate ${name}`,
    refreshFailed: (e) => `Refresh failed: ${e}`,
    settings: "Settings",
    language: "Language",
    interval: "Refresh every",
    seconds: (n) => `${n}s`,
    paused: "Paused",
    refreshNow: "Refresh now",
    pausedNote: "Auto refresh paused",
  },
};

function prefs() {
  const s = shared(SETTINGS_KEY);
  const out = { ...DEFAULTS, ...(s && typeof s === "object" ? s : {}) };
  if (!I18N[out.lang]) out.lang = DEFAULTS.lang;
  if (!INTERVALS.includes(out.intervalSec)) out.intervalSec = DEFAULTS.intervalSec;
  return out;
}

function setPref(patch) {
  setShared(SETTINGS_KEY, { ...prefs(), ...patch });
}

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

function fmtMem(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

export default class ResourceMonitor extends View {
  init(_props, cx) {
    this.procs = [];
    this.sys = null;
    this.os = platform();
    this.collect = makeCollector(this.os);
    this.filter = "";
    this.sort = "cpu";
    this.portsOnly = false;
    this.selected = null;
    this.busy = false;
    this.error = "";
    this.updatedAt = null;
    this.lastRun = 0;
    this.showSettings = false;
    this.inputs = {};
    for (const lang of Object.keys(I18N)) {
      const input = InputState.new({ placeholder: I18N[lang].placeholder });
      input.on("change", (_e, cx) => {
        this.filter = input.value();
        cx.notify();
      });
      this.inputs[lang] = input;
    }
    // In panel mode, don't auto-focus the input
    this.refresh(cx);
    cx.timer.every(1000, (cx) => {
      const { intervalSec } = prefs();
      if (!intervalSec || !this.isShown()) return;
      if (Date.now() - this.lastRun >= intervalSec * 1000 - 50) this.refresh(cx);
    });
  }

  setLang(lang) {
    const input = this.inputs[lang];
    if (input && input.value() !== this.filter) input.set_value(this.filter);
    setPref({ lang });
  }

  isShown() {
    if (props()?.overlay) return true;
    const root = layout();
    const panel = findNode(root, "panel");
    const body = findNode(root, "panel-body");
    if (!panel || !body || !findNode(body, "processes")) return true;
    return !panel.hidden && body.active === "processes";
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    this.lastRun = Date.now();
    cx.spawn(async (cx) => {
      try {
        const { procs, sys } = await this.collect();
        this.procs = procs;
        this.sys = sys;
        this.updatedAt = new Date();
        this.error = "";
      } catch (err) {
        this.error = String(err);
      } finally {
        this.busy = false;
        this.lastRun = Date.now();
      }
      cx.notify();
    });
  }

  kill(proc, signal, cx) {
    const tr = I18N[prefs().lang];
    cx.spawn(async (cx) => {
      let r;
      try {
        r = await killProcess(proc.pid, signal, this.os);
      } catch (err) {
        r = { code: -1, stderr: String(err) };
      }
      if (r.code === 0) {
        notify({ title: tr.sent(signal), body: `${proc.name} (PID ${proc.pid})`, level: "success", timeout: 3000 });
        this.selected = null;
      } else {
        notify({ title: tr.failed(proc.name), body: (r.stderr || `exit ${r.code}`).trim(), level: "error" });
      }
      cx.notify();
      this.refresh(cx);
    });
  }

  visible() {
    const q = this.filter.trim().toLowerCase();
    const portQuery = q.startsWith(":") ? q.slice(1) : null;
    const list = this.procs.filter((p) => {
      if (this.portsOnly && p.ports.length === 0) return false;
      if (!q) return true;
      if (portQuery !== null) return p.ports.some((x) => x.startsWith(portQuery));
      return (
        p.name.toLowerCase().includes(q) ||
        p.command.toLowerCase().includes(q) ||
        String(p.pid).startsWith(q) ||
        p.ports.some((x) => x.startsWith(q))
      );
    });
    const byPort = (p) => (p.ports.length ? parseInt(p.ports[0], 10) : Infinity);
    if (this.sort === "cpu") list.sort((a, b) => b.cpu - a.cpu || b.memMb - a.memMb);
    else if (this.sort === "mem") list.sort((a, b) => b.memMb - a.memMb || b.cpu - a.cpu);
    else list.sort((a, b) => byPort(a) - byPort(b) || b.cpu - a.cpu);
    return list;
  }

  chip(t, id, label, on, onClick) {
    return div()
      .id(id)
      .px(8)
      .py(2)
      .rounded(4)
      .text_size(10.5)
      .cursor_pointer()
      .border_1()
      .border_color(on ? t.accent : t.border)
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        onClick(cx);
        cx.notify();
      })
      .child(label);
  }

  button(t, id, label, color, onClick) {
    return div()
      .id(id)
      .px(8)
      .py(3)
      .rounded(4)
      .text_size(10.5)
      .cursor_pointer()
      .border_1()
      .border_color(color)
      .text_color(color)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  settingsPanel(t, tr, p) {
    const label = (text) => div().w(56).flex_none().text_size(10).text_color(t.dim).child(text);
    return v_flex()
      .p(8)
      .gap(6)
      .rounded(6)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(
        h_flex().gap(4).items_center().flex_wrap()
          .child(label(tr.language))
          .child(this.chip(t, "lang-en", "English", p.lang === "en", () => this.setLang("en")))
          .child(this.chip(t, "lang-zh", "繁體中文", p.lang === "zh-TW", () => this.setLang("zh-TW"))),
      )
      .child(
        h_flex().gap(4).items_center().flex_wrap()
          .child(label(tr.interval))
          .children(
            INTERVALS.map((sec) =>
              this.chip(t, `iv-${sec}`, sec ? tr.seconds(sec) : tr.paused, p.intervalSec === sec, () => setPref({ intervalSec: sec }))),
          ),
      )
      .child(
        h_flex().gap(4).items_center()
          .child(label(""))
          .child(this.button(t, "pm-refresh-now", `↻ ${tr.refreshNow}`, t.muted, (cx) => this.refresh(cx))),
      );
  }

  row(t, tr, mono, p) {
    const on = this.selected === p.pid;
    const hot = p.cpu >= 50;
    const head = h_flex()
      .gap(6)
      .items_center()
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).when(on, (d) => d.font_semibold()).child(p.name))
      .child(div().w(48).flex_none().font_family(mono).text_size(10.5).text_color(hot ? t.blocked : t.muted).child(`${p.cpu.toFixed(1)}%`))
      .child(div().w(56).flex_none().font_family(mono).text_size(10.5).text_color(t.muted).child(fmtMem(p.memMb)));

    const meta = h_flex()
      .gap(4)
      .items_center()
      .text_size(10)
      .child(div().font_family(mono).text_color(t.dim).child(`PID ${p.pid}`))
      .child(div().text_color(t.dim).child(p.user))
      .children(
        p.ports.slice(0, 5).map((port) =>
          div().px(4).rounded(3).bg(t.raised).font_family(mono).text_color(t.accent).child(`:${port}`)),
      )
      .when(p.ports.length > 5, (el) => el.child(div().text_color(t.dim).child(`+${p.ports.length - 5}`)));

    let el = v_flex()
      .id(`proc-${p.pid}`)
      .px(8)
      .py(4)
      .gap(2)
      .rounded(5)
      .cursor_pointer()
      .when(on, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.selected = on ? null : p.pid;
        cx.notify();
      })
      .child(head)
      .child(meta);

    if (on) {
      el = el
        .child(div().text_size(9.5).text_color(t.muted).font_family(mono).child(p.command))
        .child(
          h_flex()
            .pt(2)
            .gap(4)
            .flex_wrap()
            .child(this.button(t, `term-${p.pid}`, tr.term, t.blocked, (cx) => this.kill(p, "TERM", cx)))
            .child(this.button(t, `kill-${p.pid}`, tr.kill, t.ansi1, (cx) => this.kill(p, "KILL", cx)))
            .child(this.button(t, `cancel-${p.pid}`, tr.cancel, t.muted, (cx) => {
              this.selected = null;
              cx.notify();
            })),
        );
    }
    return el;
  }

  bar(t, segments) {
    return h_flex()
      .h(5)
      .w_full()
      .rounded(2)
      .overflow_hidden()
      .bg(t.raised)
      .children(
        segments
          .filter((s) => s.pct > 0)
          .map((s) => div().h_full().w(`${Math.min(100, s.pct).toFixed(2)}%`).bg(s.color)),
      );
  }

  overview(t, tr, mono, totalCpu) {
    const s = this.sys;
    if (!s) return null;
    const cpuPct = Math.min(100, totalCpu / s.ncpu);
    const usedMb = s.usedMb;
    const colorOf = { app: t.ansi4, used: t.ansi4, wired: t.ansi6, compressed: t.ansi5, cached: t.dim };
    const segments = s.segments.filter((g) => g.mb > 0);
    const pctOf = (mb) => (s.totalMb ? (mb / s.totalMb) * 100 : 0);
    const level = (pct, warn, crit) => (pct >= crit ? t.ansi1 : pct >= warn ? t.ansi3 : t.ansi2);
    const head = (label, value, color) =>
      h_flex()
        .items_center()
        .gap(6)
        .child(div().flex_1().text_size(10.5).text_color(t.muted).child(label))
        .child(div().font_family(mono).text_size(10.5).text_color(color ?? t.foreground).child(value));
    const legend = (color, label, mb) =>
      h_flex()
        .gap(4)
        .items_center()
        .child(div().size(6).rounded(1.5).bg(color))
        .child(div().text_color(t.dim).text_size(10).child(`${label} ${fmtMem(mb)}`));
    const swapPct = s.swapTotalMb ? (s.swapUsedMb / s.swapTotalMb) * 100 : 0;

    return v_flex()
      .p(8)
      .gap(4)
      .rounded(6)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(head(`${tr.cpuLabel} · ${tr.cores(s.ncpu)}`, `${cpuPct.toFixed(0)}%`, level(cpuPct, 60, 85)))
      .child(this.bar(t, [{ pct: cpuPct, color: level(cpuPct, 60, 85) }]))
      .when(!!s.load, (el) => el.child(div().text_size(9.5).text_color(t.dim).child(`${tr.load} ${s.load}`)))
      .child(div().h(1))
      .child(head(tr.memLabel, `${fmtMem(usedMb)} / ${fmtMem(s.totalMb)}`))
      .child(
        this.bar(t, segments.map((g) => ({ pct: pctOf(g.mb), color: colorOf[g.key] ?? t.muted }))),
      )
      .child(
        h_flex()
          .gap(8)
          .flex_wrap()
          .text_size(9.5)
          .children(segments.map((g) => legend(colorOf[g.key] ?? t.muted, tr[g.key] ?? g.key, g.mb))),
      )
      .child(
        h_flex()
          .gap(8)
          .flex_wrap()
          .text_size(9.5)
          .when(s.swapTotalMb > 0, (el) =>
            el.child(div().text_color(swapPct >= 80 ? t.ansi3 : t.dim).child(`${tr.swap} ${fmtMem(s.swapUsedMb)} / ${fmtMem(s.swapTotalMb)}`)))
          .when(s.pressure !== null, (el) =>
            el.child(div().text_color(level(s.pressure, 60, 85)).child(`${tr.pressure} ${s.pressure.toFixed(0)}%`))),
      );
  }

  render() {
    const t = theme();
    const p = prefs();
    const tr = I18N[p.lang];
    const mono = settings().font_family ?? "JetBrains Mono";
    const list = this.visible();
    const shown = list.slice(0, MAX_ROWS);
    const listening = this.procs.filter((x) => x.ports.length > 0).length;
    const totalCpu = this.procs.reduce((s, x) => s + x.cpu, 0);
    const time = this.updatedAt
      ? this.updatedAt.toLocaleTimeString(p.lang === "en" ? "en-US" : "zh-TW")
      : "—";
    const status = p.intervalSec ? time : `${time} · ${tr.pausedNote}`;

    return v_flex()
      .id("proc-monitor")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .p(10)
      .gap(8)
      .text_size(11)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(div().flex_1().text_size(12).font_semibold().text_color(t.foreground).child(tr.title))
          .child(
            h_flex()
              .id("pm-settings")
              .size(22)
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(5)
              .cursor_pointer()
              .text_color(this.showSettings ? t.foreground : t.muted)
              .when(this.showSettings, (el) => el.bg(t.selected))
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.showSettings = !this.showSettings;
                cx.notify();
              })
              .child(svg("mods/workspace-chrome/settings.svg").size(12)),
          ),
      )
      .when(this.showSettings, (el) => el.child(this.settingsPanel(t, tr, p)))
      .when(!!this.sys, (el) => el.child(this.overview(t, tr, mono, totalCpu)))
      .child(
        div()
          .text_size(9.5)
          .text_color(t.dim)
          .truncate()
          .child(tr.summary(this.procs.length, listening, status)),
      )
      .child(
        h_flex()
          .h(28)
          .flex_none()
          .px(8)
          .items_center()
          .rounded(6)
          .border_1()
          .border_color(t.input)
          .bg(t.background)
          .child(Input.new(this.inputs[p.lang]).flex_1().h_full().text_size(11).text_color(t.foreground)),
      )
      .child(
        h_flex()
          .gap(4)
          .flex_wrap()
          .items_center()
          .child(div().text_size(9.5).text_color(t.dim).child(tr.sort))
          .child(this.chip(t, "sort-cpu", tr.cpu, this.sort === "cpu", () => (this.sort = "cpu")))
          .child(this.chip(t, "sort-mem", tr.mem, this.sort === "mem", () => (this.sort = "mem")))
          .child(this.chip(t, "sort-port", tr.port, this.sort === "port", () => (this.sort = "port")))
          .child(div().w(4))
          .child(this.chip(t, "ports-only", this.portsOnly ? `✓ ${tr.portsOnly}` : tr.portsOnly, this.portsOnly, () => (this.portsOnly = !this.portsOnly))),
      )
      .when(!!this.error, (el) => el.child(div().text_size(10).text_color(t.blocked).child(tr.refreshFailed(this.error))))
      .child(
        v_flex()
          .id("pm-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .gap(1)
          .when(shown.length === 0, (el) =>
            el.child(div().p(10).text_color(t.dim).child(this.procs.length ? tr.empty : tr.loading)))
          .children(shown.map((x) => this.row(t, tr, mono, x)))
          .when(list.length > shown.length, (el) =>
            el.child(div().p(6).text_size(9.5).text_color(t.dim).child(tr.more(list.length - shown.length)))),
      );
  }
}