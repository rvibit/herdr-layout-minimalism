import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, theme, run, window, keys, shared, setShared, exec } from "herdr";

function sessionCounts() {
  try {
    const value = JSON.parse(shared("minimalism.sessions") ?? "{}");
    return { sessions: Number(value.sessions) || 0, working: Number(value.working) || 0 };
  } catch { return { sessions: 0, working: 0 }; }
}

export default class MinimalismSessionStatus extends View {
  init(_props, cx) {
    this.keepAwake = shared("keepAwake") ?? false;
    this.caffeinatePid = shared("keepAwakePid") ?? null;
    if (this.keepAwake) this.ensureCaffeinate();
  }

  async close(cx) {
    // Keep caffeinate running across reloads if keepAwake is on; PID is tracked in shared state.
  }

  toggleKeepAwake(cx) {
    const next = !this.keepAwake;
    this.keepAwake = next;
    setShared("keepAwake", next);
    cx.notify();

    if (next) {
      this.ensureCaffeinate();
    } else {
      this.stopCaffeinate();
    }
  }

  async ensureCaffeinate() {
    const platform = window()?.platform;
    const existing = shared("keepAwakePid") ?? this.caffeinatePid;
    if (existing) {
      try {
        const r = await exec("kill", ["-0", String(existing)], { timeout: 2000 });
        if (r.code === 0) {
          this.caffeinatePid = String(existing);
          setShared("keepAwakePid", this.caffeinatePid);
          return;
        }
      } catch {}
    }
    this.caffeinatePid = null;
    setShared("keepAwakePid", null);
    await this.startCaffeinate(platform);
  }

  async startCaffeinate(platform = window()?.platform) {
    if (platform === "macos") {
      try {
        const r = await exec("sh", ["-c", "caffeinate -di >/dev/null 2>&1 & echo $!"], { timeout: 5000 });
        const pid = (r.stdout || "").trim();
        if (r.code === 0 && pid) {
          this.caffeinatePid = pid;
          setShared("keepAwakePid", pid);
        }
      } catch {}
    } else if (platform === "linux") {
      try {
        const r = await exec("sh", ["-c", "systemd-inhibit --what=handle-lid-switch:sleep:idle --who=herdr-keep-awake --why='Keep screen awake' sleep infinity >/dev/null 2>&1 & echo $!"], { timeout: 5000 });
        const pid = (r.stdout || "").trim();
        if (r.code === 0 && pid) {
          this.caffeinatePid = pid;
          setShared("keepAwakePid", pid);
        }
      } catch {}
    } else if (platform === "windows") {
      // Best-effort placeholder; Windows would need a persistent SetThreadExecutionState loop.
      exec("powershell", ["-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"]).catch(() => {});
    }
  }

  async stopCaffeinate() {
    const pid = this.caffeinatePid ?? shared("keepAwakePid");
    if (pid) {
      try { await exec("kill", [String(pid)], { timeout: 2000 }); } catch {}
    }
    this.caffeinatePid = null;
    setShared("keepAwakePid", null);
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "\u2318" : "Ctrl+", ctrl: mac ? "\u2303" : "Ctrl+", shift: mac ? "\u21e7" : "Shift+", alt: mac ? "\u2325" : "Alt+", option: mac ? "\u2325" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const counts = sessionCounts();
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);

    const keepAwakeButton = h_flex()
      .id("keep-awake")
      .gap(6)
      .items_center()
      .text_color(this.keepAwake ? t.accent : t.muted)
      .child(svg("mods/minimalism-session-status/coffee.svg").size(13).text_color(this.keepAwake ? t.accent : t.muted))
      .child("Keep awake")
      .on_click((_e, cx) => this.toggleKeepAwake(cx));

    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center()
        .when(counts.working, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(6).flex_none().text_color(t.working).spin(900)))
        .when(!counts.working, el => el.child(div().size(6).rounded(3).bg(t.dim)))
        .child(`${counts.sessions} sessions, ${counts.working} working`))
      .child(div().flex_1())
      .child(keepAwakeButton)
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}