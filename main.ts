import { ChildProcess, execFile, spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  App,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownView,
  Notice,
  Plugin,
  SuggestModal,
  TFile,
} from "obsidian";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { clean, cursorLine } from "./log";

type Entry = { cmd: string; start: number };

const SHELLS = ["zsh", "bash"];

// GUI 起動の Obsidian は PATH が最小限で homebrew が入っていない（tmux が ENOENT になる）
const ENV = {
  ...process.env,
  PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(":"),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1 つの PTY セッション。生ログとコマンド境界を保持する。 */
class Session {
  log = "";
  entries: Entry[] = [];
  promptCol = -1; // プロンプト直後のカーソル列 = PS1 の幅
  alive = true;
  private subs = new Set<(d: string) => void>();

  /** tmux ペイン時のみ: 固定サイズ（ペインに合わせる） */
  size: [number, number] | null = null;
  /** 「ノート」で転記済みの位置 */
  noteMark = 0;

  /** pane が空なら自前の PTY、そうでなければ tmux ペインに接続している */
  constructor(
    readonly shell: string,
    readonly path: string,
    private proc: ChildProcess,
    readonly pane = "",
  ) {
    proc.stdout?.on("data", (b: Buffer) => this.emit(b.toString()));
    proc.stderr?.on("data", (b: Buffer) => this.emit(b.toString()));
    proc.on("exit", () => {
      this.alive = false;
      this.emit("\r\n[session closed]\r\n");
    });
  }

  private emit(s: string) {
    this.log += s; // ponytail: 無制限に伸びる。長時間セッションで困ったら世代管理を足す
    this.subs.forEach((f) => f(s));
  }

  sub(f: (d: string) => void) {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }

  write(d: string) {
    if (!this.pane) return void this.proc.stdin?.write(d);
    // tmux へは生バイトを16進で送る（制御文字・エスケープもそのまま通る）
    const hex = Buffer.from(d, "utf8").toString("hex").match(/../g) || [];
    execFile("tmux", ["send-keys", "-t", this.pane, "-H", ...hex], { env: ENV }, () => {});
  }

  /** winsize は slave デバイス経由で設定する（SIGWINCH も飛ぶ）。tmux 側は tmux が管理する */
  resize(cols: number, rows: number) {
    if (this.pane) return;
    execFile("stty", ["-f", this.path, "rows", String(rows), "cols", String(cols)], { env: ENV }, () => {});
  }

  kill() {
    if (this.pane) execFile("tmux", ["pipe-pane", "-t", this.pane], { env: ENV }, () => {}); // ペインは消さない
    this.proc.kill();
  }

  /**
   * この PTY の状態を ps で見る。
   * shell: 今動いているシェル名（`exec bash` 等にも追随する）
   * idle:  前景プロセスがシェル自身 = プロンプトに戻っている
   */
  state(): Promise<{ shell: string; idle: boolean }> {
    return new Promise((resolve) => {
      const args = ["-t", this.path.replace("/dev/", ""), "-o", "stat=,comm="];
      execFile("ps", args, { env: ENV }, (_e, out) => {
        const procs = (out || "")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [stat, ...rest] = l.trim().split(/\s+/);
            return { stat, comm: rest.join(" ").split("/").pop() || "" };
          });
        const shells = procs.map((p) => p.comm).filter((c) => SHELLS.includes(c));
        const fg = procs.find((p) => p.stat.includes("+")); // 前景プロセスグループ
        resolve({
          shell: shells.pop() || this.shell, // 最後 = 一番内側のシェル
          idle: !fg || SHELLS.includes(fg.comm),
        });
      });
    });
  }

  /** i 番目のコマンドの出力（PS1 とエスケープ除去済み）。running なら途中結果を返す */
  output(i: number, running = false) {
    const s = this.entries[i].start;
    const e = i + 1 < this.entries.length ? this.entries[i + 1].start : this.log.length;
    return clean(this.log.slice(s, e), running);
  }

  /**
   * xterm への入力を見てコマンド境界を記録する。
   * 位置は「折り返しも含めた論理行の先頭からのオフセット」で持つ。
   * cursorY はビューポート基準なので baseY を足さないとスクロール後に過去の行を読んでしまう。
   */
  track(term: Terminal, d: string) {
    const { text, off } = cursorLine(term.buffer.active, term.cols);
    if (this.promptCol < 0) this.promptCol = off; // プロンプト直後 = PS1 の幅
    if (!/[\r\x03]/.test(d)) return;
    if (d.includes("\r")) {
      const cmd = text.slice(this.promptCol, off).trim(); // PS1 を除いた入力本体
      if (cmd) this.entries.push({ cmd, start: this.log.length });
    }
    this.promptCol = -1;
  }
}

class Child extends MarkdownRenderChild {
  constructor(el: HTMLElement, private cleanup: () => void) {
    super(el);
  }
  onunload() {
    this.cleanup();
  }
}

export default class ObPty extends Plugin {
  sessions = new Map<string, Session>(); // key = tmux ペイン ID か PTY パス

  onload() {
    this.addRibbonIcon("terminal", "PTY ターミナルを挿入", () => this.insertBlock());
    this.addCommand({
      id: "insert-terminal",
      name: "ターミナルを挿入",
      callback: () => this.insertBlock(),
    });
    this.addCommand({
      id: "insert-tmux-pane",
      name: "tmux ペインを挿入",
      callback: () => this.insertTmuxBlock(),
    });
    this.registerMarkdownCodeBlockProcessor("term", (src, el, ctx) => {
      const { shell, path, pane } = this.blockArgs(src, el, ctx);
      const sess = this.sessions.get(pane || path);
      if (sess?.alive) this.renderTerm(sess, el, ctx);
      else this.renderStart(shell, path, pane, el, ctx);
    });
  }

  onunload() {
    this.sessions.forEach((s) => s.kill());
    this.sessions.clear();
  }

  /** ```term <bash|zsh> <pty path> / ```term tmux <pane id> のフェンス行を読む */
  blockArgs(src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const info = ctx.getSectionInfo(el);
    const line = info ? info.text.split("\n")[info.lineStart] : "";
    const arg = line.replace(/^\s*(?:```+|~~~+)\s*term\s*/, "").trim() || src.trim();
    const parts = arg.split(/\s+/).filter(Boolean);
    return {
      shell: parts.find((p) => SHELLS.includes(p)) || "",
      path: parts.find((p) => p.startsWith("/")) || "",
      pane: parts.find((p) => /^%\d+$/.test(p)) || "",
    };
  }

  async newSession(shell = "") {
    const cwd = (this.app.vault.adapter as any).basePath || process.env.HOME;
    const sess = await createSession(cwd, shell);
    this.sessions.set(sess.path, sess);
    return sess;
  }

  /** tmux ペインを選ばせてブロックを挿入する */
  async insertTmuxBlock() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return void new Notice("ノートを開いてから実行してください");
    let panes: string[];
    try {
      const fmt = "#{pane_id} #{session_name}:#{window_index}.#{pane_index} [#{pane_current_command}]";
      panes = (await tmux(["list-panes", "-a", "-F", fmt])).split("\n").filter(Boolean);
    } catch (e: any) {
      return void new Notice("ob-pty: " + e.message, 10000);
    }
    if (!panes.length) return void new Notice("tmux ペインがありません");
    new PaneModal(this.app, panes, (line) => {
      view.editor.replaceSelection("```term tmux " + line.split(" ")[0] + "\n```\n");
    }).open();
  }

  async insertBlock() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return void new Notice("ノートを開いてから実行してください");
    try {
      const sess = await this.newSession();
      view.editor.replaceSelection(fence(sess) + "\n```\n");
    } catch (e: any) {
      new Notice("ob-pty: " + e.message);
    }
  }

  /** セッションが無いブロック: 起動ボタンを出す */
  renderStart(
    shell: string,
    path: string,
    pane: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ) {
    const root = el.createDiv({ cls: "obpty obpty-dead" });
    root.createSpan({ text: pane || path ? `未接続: ${pane || path}` : "PTY 未指定" });
    const btn = root.createEl("button", { text: pane ? "接続" : "起動" });
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        if (pane) {
          const sess = await attachPane(pane);
          this.sessions.set(pane, sess);
          el.empty();
          this.renderTerm(sess, el, ctx);
          return;
        }
        const sess = await this.newSession(shell);
        await this.editBlock(el, ctx, (lines, info) => {
          lines[info.lineStart] = fence(sess);
        });
      } catch (e: any) {
        new Notice("ob-pty: " + e.message);
        btn.disabled = false;
      }
    };
  }

  renderTerm(sess: Session, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const root = el.createDiv({ cls: "obpty" });
    // ライブプレビュー(CodeMirror)にキー入力を奪われないようにする
    root.addEventListener("keydown", (e) => e.stopPropagation());
    root.addEventListener("mousedown", (e) => e.stopPropagation());

    const bar = root.createDiv({ cls: "obpty-bar" });
    bar.createSpan({ cls: "obpty-path", text: sess.pane ? `tmux ${sess.pane}` : sess.path });
    const sel = bar.createEl("select", { cls: "obpty-sel" });
    const ins = bar.createEl("button", { text: "挿入" });
    const note = bar.createEl("button", { text: "ノート" });
    note.title = "前回のノート以降の出力をノート末尾に追記";
    const stop = bar.createEl("button", { text: sess.pane ? "切断" : "終了" });
    const host = root.createDiv({ cls: "obpty-term" });

    const css = getComputedStyle(document.body);
    const color = (name: string, fallback: string) => {
      const v = css.getPropertyValue(name).trim();
      return /^(#|rgb)/.test(v) ? v : fallback;
    };
    const term = new Terminal({
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: color("--background-primary", "#1e1e1e"),
        foreground: color("--text-normal", "#dcddde"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    if (sess.size) term.resize(sess.size[0], sess.size[1]); // tmux ペインに合わせる
    term.write(sess.log.slice(-100000));
    term.onData((d) => {
      sess.track(term, d);
      sess.write(d);
      syncSel();
    });
    term.onResize(({ cols, rows }) => sess.resize(cols, rows));

    const syncSel = () => {
      if (sel.options.length === sess.entries.length) return;
      sel.empty();
      sess.entries.forEach((e, i) =>
        sel.createEl("option", { value: String(i), text: `${i + 1}: ${e.cmd.slice(0, 60)}` }),
      );
      sel.value = String(sess.entries.length - 1);
    };
    syncSel();

    const unsub = sess.sub((d) => {
      term.write(d);
      syncSel();
    });
    const ro = new ResizeObserver(() => {
      if (sess.size) return;
      try {
        fit.fit();
      } catch {}
    });
    ro.observe(host);

    ins.onclick = async () => {
      const i = Number(sel.value);
      const entry = sess.entries[i];
      if (!entry) return void new Notice("記録されたコマンドがありません");
      const { shell: sh, idle } = await sess.state();
      // 実行中のコマンドなら、終わるのを待たずにその時点までの出力を入れる
      const out = sess.output(i, !idle && i === sess.entries.length - 1);
      const prompt = sh === "zsh" ? "% " : "$ "; // zsh のデフォルトプロンプトに合わせる
      const block = ["```" + sh, prompt + entry.cmd, ...(out ? [out] : []), "```"];
      await this.editBlock(el, ctx, (lines, info) => {
        lines.splice(afterBlocks(lines, info.lineEnd + 1), 0, "", ...block);
      });
    };
    note.onclick = async () => {
      const { shell: sh, idle } = await sess.state();
      const text = clean(sess.log.slice(sess.noteMark), !idle);
      if (!text) return void new Notice("新しい出力がありません");
      sess.noteMark = sess.log.length;
      await this.appendToNote(ctx, ["```" + sh, text, "```"]);
    };
    stop.onclick = () => {
      sess.kill();
      this.sessions.delete(sess.pane || sess.path);
    };

    ctx.addChild(
      new Child(root, () => {
        unsub();
        ro.disconnect();
        term.dispose();
      }),
    );
  }

  /** ノート本文の末尾にブロックを追記する */
  async appendToNote(ctx: MarkdownPostProcessorContext, block: string[]) {
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) return void new Notice("ノートが見つかりません");
    await this.app.vault.process(file, (data) => data.replace(/\s*$/, "") + "\n\n" + block.join("\n") + "\n");
  }

  /** このコードブロックを含むノートを行単位で書き換える */
  async editBlock(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    fn: (lines: string[], info: { lineStart: number; lineEnd: number }) => void,
  ) {
    const info = ctx.getSectionInfo(el);
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!info || !(file instanceof TFile)) return void new Notice("ノートの位置を特定できません");
    await this.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      if (!/^\s*(?:```+|~~~+)\s*term\b/.test(lines[info.lineStart] ?? "")) return data;
      fn(lines, info);
      return lines.join("\n");
    });
  }
}

function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("tmux", args, { env: ENV }, (e, out) =>
      e
        ? reject(new Error(/ENOENT/.test(e.message) ? `tmux が見つかりません (PATH=${ENV.PATH})` : e.message.trim()))
        : resolve(out),
    ),
  );
}

/** tmux ペイン一覧から選ばせる */
class PaneModal extends SuggestModal<string> {
  constructor(app: App, private panes: string[], private cb: (line: string) => void) {
    super(app);
    this.setPlaceholder("tmux ペインを選択");
  }
  getSuggestions(q: string) {
    return this.panes.filter((p) => p.toLowerCase().includes(q.toLowerCase()));
  }
  renderSuggestion(p: string, el: HTMLElement) {
    el.setText(p);
  }
  onChooseSuggestion(p: string) {
    this.cb(p);
  }
}

/**
 * 既存の tmux ペインに接続する。
 * 出力は pipe-pane -> ファイル -> tail -f で受け、入力は send-keys -H で流す。
 * ponytail: ペインが閉じても tail は生き続ける。困ったら pane_dead を polling する。
 */
async function attachPane(pane: string): Promise<Session> {
  const fmt = "#{pane_tty} #{pane_width} #{pane_height} #{pane_current_command}";
  const [tty, cols, rows, cmd] = (await tmux(["display", "-p", "-t", pane, fmt])).trim().split(" ");
  if (!tty || !tty.startsWith("/dev/")) throw new Error(`ペイン ${pane} が見つかりません`);
  const file = join(tmpdir(), `obpty-${pane.slice(1)}-${Date.now()}.log`);
  writeFileSync(file, "");
  await tmux(["pipe-pane", "-t", pane, `cat >> '${file}'`]);
  const sess = new Session(SHELLS.includes(cmd) ? cmd : "sh", tty, spawn("tail", ["-n", "+1", "-f", file], { env: ENV }), pane);
  sess.size = [Number(cols), Number(rows)];
  // 今の画面を先に流し込む（pipe-pane は接続後の出力しか拾えないため）
  const snap = await tmux(["capture-pane", "-p", "-e", "-t", pane]);
  sess.log = snap.replace(/\n+$/, "").replace(/\n/g, "\r\n");
  return sess;
}

/** ターミナルブロックのフェンス行 */
const fence = (s: Session) => "```term " + s.shell + " " + s.path;

/** 直前に挿入したコードブロック群の下まで送る（挿入順を保つため） */
function afterBlocks(lines: string[], i: number) {
  for (;;) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (!lines[i]?.startsWith("```")) return i;
    i++;
    while (i < lines.length && !lines[i].startsWith("```")) i++;
    i++;
  }
}

/**
 * python3 の pty モジュールでログインシェルを起動する。
 * macOS の script(1) は stdin が tty でないと動かないためこちら。
 * slave デバイス名は子シェル内の `tty` をファイルに書かせて受け取る。
 */
async function createSession(cwd: string, shell: string): Promise<Session> {
  const f = join(tmpdir(), `obpty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const bin = shell || process.env.SHELL || "/bin/zsh";
  const proc = spawn(
    "python3",
    ["-c", "import pty,sys; pty.spawn(sys.argv[1:])", "/bin/sh", "-c", `tty > '${f}'; exec ${bin} -il`],
    { cwd, env: { ...ENV, TERM: "xterm-256color" } },
  );
  let err = "";
  proc.on("error", (e) => (err = e.message));
  for (let i = 0; i < 60 && !err; i++) {
    await sleep(50);
    const path = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
    if (path) {
      try {
        unlinkSync(f);
      } catch {}
      return new Session(bin.split("/").pop() || "sh", path, proc);
    }
  }
  proc.kill();
  throw new Error(err || "PTY を取得できませんでした（python3 が必要です）");
}
