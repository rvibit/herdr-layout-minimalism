// Resource Mini — Collapsible sidebar resource monitor.
// Shows compact CPU%/RAM% when collapsed, full overview when expanded.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, settings, layout, shared, setShared } from "herdr";
import { makeCollector, platform } from "./sources.js";

const STORAGE_KEY = "resource-mini.collapsed";

function fmtMem(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function bar(t, segments, height = 5) {
  return h_flex()
    .h(height)
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

function level(pct, warn, crit, t) {
  return pct >= crit ? t.ansi1 : pct >= warn ? t.ansi3 : t.ansi2;
}

function head(label, value, color, t, mono) {
  return h_flex()
    .items_center()
    .gap(6)
    .child(div().flex_1().text_size(9).text_color(t.muted).child(label))
    .child(div().font_family(mono).text_size(9).text_color(color ?? t.foreground).child(value));
}

function legend(color, label, mb, t) {
  return h_flex()
    .gap(4)
    .items_center()
    .child(div().size(5).rounded(1).bg(color))
    .child(div().text_color(t.dim).text_size(8).child(`${label} ${fmtMem(mb)}`));
}

export default class ResourceMini extends View {
  sys = null;
  procs = [];
  timer = null;
  os = "mac";
  collect = null;
  collapsed = false;

  init(_props, cx) {
    this.os = platform();
    this.collect = makeCollector(this.os);
    // Read persisted collapse state
    this.collapsed = shared(STORAGE_KEY) ?? false;
    this.refresh(cx);
    this.timer = cx.timer.every(3000, (cx) => this.refresh(cx));
  }

  toggleCollapse(cx) {
    this.collapsed = !this.collapsed;
    setShared(STORAGE_KEY, this.collapsed);
    cx.notify();
  }

  async refresh(cx) {
    try {
      const { procs, sys } = await this.collect();
      this.procs = procs;
      this.sys = sys;
      cx.notify();
    } catch (e) {
      console.error("resource-mini refresh failed:", e);
    }
  }

  isShown() {
    const root = layout();
    const sidebar = root?.children?.[0];
    return sidebar?.id === "sidebar" && !sidebar.hidden;
  }

  render(cx) {
    if (!this.isShown() || !this.sys) return div().size_full().bg(theme().chrome).p(8);

    const t = theme();
    const mono = settings().font_family ?? "JetBrains Mono";
    const totalCpu = this.procs.reduce((s, p) => s + (p.cpu || 0), 0);
    const cpuPct = Math.min(100, totalCpu / this.sys.ncpu);
    const usedMb = this.sys.usedMb;
    const cpuColor = level(cpuPct, 60, 85, t);
    const memPct = this.sys.totalMb ? (usedMb / this.sys.totalMb) * 100 : 0;
    const memColor = level(memPct, 60, 85, t);

    if (this.collapsed) {
      // Compact view: just CPU% and RAM% with small bars
      return v_flex()
        .id("root")
        .size_full()
        .p(6)
        .gap(4)
        .bg(t.chrome)
        .on_click((_e, cx) => this.toggleCollapse(cx))
        .cursor_pointer()
        .children([
          h_flex().justify_between().children([
            div().text_color(t.foreground).text_size(10).font_semibold().child("Resources"),
            svg(`mods/workspace-chrome/chevron-${this.collapsed ? "right" : "down"}.svg`).size(10).text_color(t.muted),
          ]),
          // CPU mini
          h_flex().gap(6).items_center().children([
            div().w(28).text_color(t.muted).text_size(9).child("CPU"),
            bar(t, [{ pct: cpuPct, color: cpuColor }], 4).flex_1(),
            div().font_family(mono).text_size(9).font_bold().text_color(cpuColor).child(`${cpuPct.toFixed(0)}%`),
          ]),
          // RAM mini
          h_flex().gap(6).items_center().children([
            div().w(28).text_color(t.muted).text_size(9).child("RAM"),
            bar(t, [{ pct: memPct, color: memColor }], 4).flex_1(),
            div().font_family(mono).text_size(9).font_bold().text_color(memColor).child(`${memPct.toFixed(0)}%`),
          ]),
        ]);
    }

    // Expanded view: full overview
    const colorOf = { app: t.ansi4, used: t.ansi4, wired: t.ansi6, compressed: t.ansi5, cached: t.dim };
    const segments = this.sys.segments.filter((g) => g.mb > 0);
    const pctOf = (mb) => (this.sys.totalMb ? (mb / this.sys.totalMb) * 100 : 0);
    const swapPct = this.sys.swapTotalMb ? (this.sys.swapUsedMb / this.sys.swapTotalMb) * 100 : 0;

    const cpuChildren = [
      head(`CPU · ${this.sys.ncpu} cores`, `${cpuPct.toFixed(0)}%`, cpuColor, t, mono),
      bar(t, [{ pct: cpuPct, color: cpuColor }], 4),
    ];
    if (this.sys.load) cpuChildren.push(div().text_size(8).text_color(t.dim).child(`Load ${this.sys.load}`));

    const swapPressureChildren = [];
    if (this.sys.swapTotalMb > 0) {
      swapPressureChildren.push(div().text_color(swapPct >= 80 ? t.ansi3 : t.dim).child(`Swap ${fmtMem(this.sys.swapUsedMb)} / ${fmtMem(this.sys.swapTotalMb)}`));
    }
    if (this.sys.pressure !== null) {
      swapPressureChildren.push(div().text_color(level(this.sys.pressure, 60, 85, t)).child(`Pressure ${this.sys.pressure.toFixed(0)}%`));
    }

    return v_flex()
      .id("root")
      .size_full()
      .p(6)
      .gap(4)
      .bg(t.chrome)
      .on_click((_e, cx) => this.toggleCollapse(cx))
      .cursor_pointer()
      .children([
        // Header with chevron
        h_flex().justify_between().children([
          div().text_color(t.foreground).text_size(10).font_semibold().child("Resources"),
          svg(`mods/workspace-chrome/chevron-${this.collapsed ? "right" : "down"}.svg`).size(10).text_color(t.muted),
        ]),

        // CPU Section
        v_flex().gap(2).children(cpuChildren),

        // Divider
        div().h(1).bg(t.border).opacity(0.3),

        // Memory Section
        v_flex().gap(2).children([
          head("Memory", `${fmtMem(usedMb)} / ${fmtMem(this.sys.totalMb)}`, null, t, mono),
          bar(t, segments.map((g) => ({ pct: pctOf(g.mb), color: colorOf[g.key] ?? t.muted })), 5),
          // Legend
          h_flex().gap(6).flex_wrap().children(
            segments.map((g) => legend(colorOf[g.key] ?? t.muted, g.key, g.mb, t))
          ),
          // Swap & Pressure
          swapPressureChildren.length > 0
            ? h_flex().gap(8).flex_wrap().text_size(8).children(swapPressureChildren)
            : null,
        ]),
      ]);
  }

  async close(cx) {
    if (this.timer) this.timer.clear();
  }
}