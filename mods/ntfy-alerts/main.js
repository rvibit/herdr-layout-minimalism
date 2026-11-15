// ntfy-alerts: send a phone notification through ntfy when an agent needs you.
//
// Herdr considers an agent "needing you" when it is blocked (waiting for input or
// permission) or done (it finished while you weren't looking). This mod watches
// agents() and posts to the topic below on those transitions.
//
// It runs as a zero-size background block in the layouts that include it. State is
// shared between layouts/copies, so switching layouts or restarting a copy does not
// repeat a notification for the same agent.

import { View, div } from "gpui-kit";
import { agents, focused, shared, setShared, exec } from "herdr";

// ============ CONFIGURATION ============
// ntfy topic (POST to this URL publishes; subscribe to the same URL in the ntfy app).
// Leave empty to turn alerts off, e.g. "https://ntfy.sh/<your-private-topic>".
const NTFY_URL = "";
// Statuses worth a phone notification. "blocked": it needs input now.
// "done": it finished while you weren't looking.
const NOTIFY_STATUSES = ["blocked", "done"];
// Small guard against duplicate sends for the same agent/status.
const COOLDOWN_MS = 30_000;
// How often to look for status changes. A timer keeps working when the window
// is minimized or hidden, where render() may not run.
const CHECK_INTERVAL_MS = 5_000;
// Must not contain a newline (it goes in an HTTP header).
const MAX_TITLE = 120;
// =======================================

const STATE_KEY = "ntfy-alerts.state";

function readState() {
  const s = shared(STATE_KEY);
  return s && typeof s === "object" ? s : {};
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function agentName(agent) {
  const program = oneLine(agent.program?.name || agent.app || "agent");
  return program || "agent";
}

function agentTitle(agent) {
  const title = oneLine(agent.title || "");
  // Many programs prefix the title with their own short name ("OC | ...").
  return title.replace(/^[A-Za-z0-9_.-]{1,4}\s*\|\s*/, "") || "untitled agent";
}

function truncate(text, max) {
  const s = oneLine(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function post({ title, body, priority, tags }) {
  const res = await exec("curl", [
    "-sS",
    "--max-time", "15",
    "-X", "POST",
    NTFY_URL,
    "-H", `Title: ${title}`,
    "-H", `Priority: ${priority}`,
    "-H", `Tags: ${tags.join(",")}`,
    "-H", "Content-Type: text/plain; charset=utf-8",
    "--data-binary", body,
  ]);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `curl exited with ${res.code}`);
  }
}

export default class NtfyAlerts extends View {
  init(_props, cx) {
    this.inflight = new Set();
    // A timer, not render(): the window may be minimized or hidden, and the phone
    // should still be told. Statuses rarely change, so 5 s is gentle.
    this.check(cx);
    cx.timer.every(CHECK_INTERVAL_MS, (cx) => this.check(cx));
  }

  check(cx) {
    if (!NTFY_URL) return;
    const state = readState();
    const focus = focused();
    const now = Date.now();
    const next = {};
    const sends = [];
    let dirty = false;

    for (const agent of agents()) {
      const prev = state[agent.address] || {};
      const status = agent.status;
      next[agent.address] = { status, at: prev.at || 0 };

      if (status === prev.status) continue;
      dirty = true;
      if (!NOTIFY_STATUSES.includes(status)) continue;

      // You are looking at this agent's tab: Herdr's own toast/sound is enough.
      const looking = focus && focus.space === agent.space && focus.tab === agent.tab;
      if (agent.focused || looking) continue;

      if (now - (prev.at || 0) < COOLDOWN_MS) continue;

      const key = `${agent.address}:${status}`;
      if (this.inflight.has(key)) continue;
      this.inflight.add(key);

      next[agent.address].at = now;
      sends.push({ agent, status });
    }

    // Forget agents that are gone so the shared state stays small.
    for (const address of Object.keys(state)) {
      if (!(address in next)) dirty = true;
    }

    if (dirty) setShared(STATE_KEY, next);

    for (const { agent, status } of sends) {
      const blocked = status === "blocked";
      const body = [
        agentTitle(agent),
        `${agent.space_name || "space"} / ${agent.tab_name || "tab"}`,
        agent.address,
      ].join("\n");
      const title = truncate(`${blocked ? "Blocked" : "Finished"}: ${agentName(agent)}`, MAX_TITLE);

      cx.spawn(async () => {
        try {
          await post({
            title,
            body,
            priority: blocked ? "high" : "default",
            tags: blocked ? ["warning", "bell"] : ["white_check_mark"],
          });
        } catch (e) {
          console.error(`ntfy-alerts: ${e.message ?? e}`);
        } finally {
          this.inflight.delete(`${agent.address}:${status}`);
        }
      });
    }
  }

  // The block is empty: the mod only watches.
  render() {
    return div();
  }
}
