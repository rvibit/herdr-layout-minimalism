import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, panes, spaces, theme, run, openOverlay, setAgentOrder, shared, setShared, nextCommand } from "herdr";
import Spaces from "./spaces-base.js";
import { frontend, providerFamily, sessionStatus } from "./model.js";
import { OpenCodeBridge } from "./opencode-bridge.js";
import { ScreenshotNames, screenshotMode } from "./screenshot.js";

const HARNESS = { opencode: "OpenCode", claude: "Claude Code", codex: "Codex", pi: "Pi" };
const STATUS = { working: "Working", blocked: "Waiting for input", done: "Done", idle: "Idle" };
const cleanTitle = (title) => title.replace(/^OC\s*\|\s*/, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function stateColor(status, t) {
  if (status === "blocked") return t.ansi1;
  if (status === "done") return t.ansi4;
  return t[status] ?? t.dim;
}

function stateIcon(status, t, size = 11) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(size - 3).mx(2).flex_none().text_color(t.working).spin(900);
  return div().size(6).mx(2).flex_none().rounded_full()
    .bg(status === "idle" ? t.chrome : stateColor(status, t))
    .border(1).border_color(stateColor(status, t));
}

export default class MinimalismWorkspaces extends Spaces {
  init(props, cx) {
    super.init(props, cx);
    this.bridge = new OpenCodeBridge();
    this.bridge.start(cx);
    this.screenshot = false;
    this.previewNames = new ScreenshotNames();
    cx.spawn(async (cx) => {
      for (;;) {
        this.screenshot = screenshotMode(await nextCommand(), this.screenshot);
        cx.notify();
      }
    });
  }

  sessionRows(space) {
    return space.tabs.flatMap((tab) => this.tabRows(tab));
  }

  tabRows(tab) {
    const ps = this.panesByTab.get(tab.id) ?? [];
    return ps.flatMap((pane) => this.paneRows(pane, tab));
  }

  paneRows(pane, tab) {
    const live = this.frontends.get(pane.terminal);
    if (!live) return [];
    const value = this.bridge.get(live);
    if (value) return value.sessions.map((session) => ({ ...session, kind: "session", address: live.address,
      status: sessionStatus(session, this.agentsByAddress.get(live.address)?.status ?? pane.status
        ?? terminals().find((t) => t.address === live.address)?.status),
      harness: live.harness, tab, focused: pane.focused && session.active,
      target: { type: "session", pid: live.pid, sessionID: session.id } }));
    return this.nativeRow(pane, tab, live);
  }

  nativeRow(pane, tab, live) {
    const agent = this.agentsByAddress.get(live.address);
    return [{ kind: "session", id: live.address, address: live.address, pid: live.pid, harness: live.harness,
      title: cleanTitle(agent?.title ?? "") || HARNESS[live.harness] || live.harness,
      status: agent?.status ?? pane.status ?? terminals().find((t) => t.address === live.address)?.status ?? "idle", provider: live.harness, model: null,
      focused: pane.focused, tab, target: { type: "terminal" } }];
  }

  openSession(row, cx) {
    run("pane.focus", { terminal: row.address });
    if (row.target.type === "session") this.bridge.focus(row.target, cx);
  }

  action(id, icon, tooltip, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((el) => el.bg(t.hover).text_color(t.foreground)).tooltip(tooltip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { cx.stop_propagation(); action(e, cx); })
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13));
  }

  labels({ w, g, tree }) {
    return this.previewNames.workspace({ id: w.id, name: w.name, folder: w.folder,
      branch: g?.branch ?? w.branch, worktree: Boolean(tree) }, this.screenshot);
  }

  spaceHeader(entry, t) {
    const { w, tree } = entry;
    const { name, branch, folder } = this.labels(entry);
    return h_flex().id(`workspace-${w.id}`).h(32).px(8).gap(8).items_center().rounded(6)
      .when(w.active, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id })).on_mouse_down("right", () => this.menu(w))
      .child(svg(`mods/workspace-chrome/${tree ? "branch" : "folder"}.svg`).size(13).flex_none().text_color(t.muted))
      .child(div().max_w(150).min_w(0).truncate().font_semibold().text_size(13.5).text_color(t.foreground)
        .tooltip([folder, branch ? `Branch: ${branch}` : ""].filter(Boolean).join("\n")).child(name))
      .when(Boolean(branch) && branch !== name, (el) => el.child(
        h_flex().flex_1().min_w(0).gap(4).items_center().text_color(t.dim).tooltip(`Branch: ${branch}`)
          .child(svg("mods/workspace-chrome/git-branch.svg").size(10).flex_none())
          .child(div().min_w(0).truncate().text_size(11.5).child(branch))));
  }

  // A branch under a workspace with more than one agent: a rail down the left
  // with an elbow into each agent, the last one closing the branch.
  branchConnector(branch, t) {
    return div().w(18).h(40).flex_none().relative()
      .child(div().absolute().left(7).top(0).w(1).h(branch.last ? 20 : 40).bg(t.border))
      .child(div().absolute().left(7).top(19.5).w(13).h(1).bg(t.border));
  }

  sessionRow(row, indent, t, branch = null) {
    const title = this.screenshot ? this.previewNames.name("session", `${row.address}:${row.id}`) : row.title;
    const family = providerFamily(row.provider, row.model);
    const harness = HARNESS[row.harness] ?? row.harness;
    const detail = [harness, row.model, STATUS[row.status]].filter(Boolean).join(" / ");
    const lead = branch ? 7 : 11;
    return h_flex().id(`session-${row.address}-${row.id}`).h(40).pl(indent + lead).pr(6).items_center().rounded(6)
      .hover((el) => el.bg(t.hover))
      .tooltip(`${title}\n${detail}`).on_click((_e, cx) => this.openSession(row, cx))
      .on_mouse_down("right", () => openOverlay({ mod: "minimalism-menu", kind: "popup", width: 200,
        props: { tab: "tab", target: { id: row.tab.id } } }))
      .when(Boolean(branch), (el) => el.child(this.branchConnector(branch, t)))
      .child(div().w(12).flex_none().child(stateIcon(row.status, t)))
      .child(v_flex().flex_1().min_w(0).ml(6).gap(2)
        .child(div().h(17).min_w(0).truncate().text_size(12.5).text_color(row.focused ? t.foreground : t.muted).child(title))
        .child(h_flex().h(15).gap(4).items_center().text_size(11).text_color(t.dim)
          .child(svg(`icons/${row.harness === "cursor-agent" ? "cursor" : row.harness}.svg`).size(10).flex_none())
          .child(div().flex_none().child(harness))
          .when(Boolean(family), (el) => el.child(div().size(10).ml(2).flex_none()
            .tooltip(family === "openai" ? "OpenAI model" : "Anthropic model")
            .child(svg(`mods/minimalism-workspaces/${family}.svg`).size(10))))
          .when(Boolean(row.model), (el) => el.child(div().min_w(0).truncate().child(row.model)))))
      // The active agent's mark: a bar beside the row, at its right edge, centred.
      // The close paren above ends the text stack, so this lands on the row itself.
      .when(row.focused, (el) => el.child(div().id(`session-active-${row.address}-${row.id}`)
        .w(2).h(18).flex_none().rounded(1).bg(t.accent).ml(6)));
  }

  row(entry, t) {
    const rows = this.rowsBySpace.get(entry.w.id) ?? [];
    const indent = entry.tree ? 12 : 0;
    const branched = rows.length > 1;
    return v_flex().id(`workspace-group-${entry.w.id}`).flex_none().pl(indent).mt(2)
      .child(this.spaceHeader(entry, t))
      .children(rows.map((row, i) => this.sessionRow(row, 0, t, branched ? { last: i === rows.length - 1 } : null)))
      .child(div().h(1).flex_none().mx(8).my(10).bg(t.border));
  }

  render(cx) {
    const t = theme();
    this.frontends = new Map(terminals().map(frontend).filter(Boolean).map((item) => [item.address, item]));
    this.bridge.update(this.frontends, cx);
    this.panesByTab = new Map();
    for (const pane of panes()) {
      const group = this.panesByTab.get(pane.tab) ?? [];
      group.push(pane);
      this.panesByTab.set(pane.tab, group);
    }
    this.agentsByAddress = new Map(agents().map((agent) => [agent.address, agent]));
    this.rowsBySpace = new Map(spaces().map((space) => [space.id, this.sessionRows(space)]));
    const sessions = [...this.rowsBySpace.values()].flat();
    const order = [...new Set(sessions.map((row) => row.address))];
    const orderSignature = JSON.stringify(order);
    if (orderSignature !== this.orderSignature) { this.orderSignature = orderSignature; setAgentOrder(order); }
    const counts = { sessions: sessions.length, working: sessions.filter((row) => row.status === "working").length };
    const serialized = JSON.stringify(counts);
    if (shared("minimalism.sessions") !== serialized) setShared("minimalism.sessions", serialized);
    return v_flex().id("minimalism-workspaces").size_full().min_h(0).bg(t.chrome)
      .child(h_flex().h(46).flex_none().pl(14).pr(10).gap(8).items_center()
        .child(div().flex_1().font_semibold().text_size(13).text_color(t.muted).child("Workspaces"))
        .child(div().text_size(12).text_color(t.dim).child(`${counts.working} working`))
        .child(this.action("workspace-add", "plus", "New space", () => run("space.new"))))
      .child(v_flex().id("workspace-scroll").flex_1().min_h(0).px(10).pt(6).pb(16)
        .overflow_y_scrollbar().children(this.grouped(t, false)));
  }
}