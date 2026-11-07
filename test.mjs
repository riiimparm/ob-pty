// node test.mjs  (Node 22+ の型ストリップで .ts を直読み)
import assert from "node:assert";
import { clean, cursorLine } from "./log.ts";
import xterm from "@xterm/headless"; // CJS
const { Terminal } = xterm;

// zsh の実ログ（echo hello; stty size を実行した直後の生データ）
const real =
  "\u001b[?2004l\r\r\nhello\r\n40 100\r\n\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m   " +
  "       \r \r\r\u001b[0m\u001b[27m\u001b[24m\u001b[Jr@mbpho scratchpad % \u001b[K\u001b[?2004h";
assert.strictEqual(clean(real), "hello\n40 100");

// プロンプトだけ（出力なし）
assert.strictEqual(clean("\r\r\nr@host ~ % "), "");

// 進捗表示の \r 上書き
assert.strictEqual(clean("\r\n10%\r50%\r100%\r\ndone\r\nPS1> "), "100%\ndone");

// 末尾が改行で終わる場合もプロンプト行を落とさない
assert.strictEqual(clean("\r\na\r\nb\r\n"), "a\nb");

// 実行中の途中挿入: 末尾の未完成行はプロンプトではなく出力なので残す
assert.strictEqual(clean("\r\nline1\r\nDownloading: 42%", true), "line1\nDownloading: 42%");
// 実行中でも末尾が改行なら余計な空行は出ない
assert.strictEqual(clean("\r\nline1\r\n", true), "line1");
// 完了後は同じログでも末尾行(プロンプト)を落とす
assert.strictEqual(clean("\r\nline1\r\nr@host ~ % ", false), "line1");

// --- cursorLine: 報告された不具合の回帰テスト ---
// 画面がスクロールした後、長いコマンドが折り返しても、入力本体だけを取り出せること
const t = new Terminal({ cols: 40, rows: 6, scrollback: 200, allowProposedApi: true }); // headless は buffer に必要
const w = (s) => new Promise((r) => t.write(s, r));

for (let i = 1; i <= 12; i++) await w(`CONTAINER ID   IMAGE   PORTS line${i}\r\n`); // スクロールさせる
assert.ok(t.buffer.active.baseY > 0, "スクロールしていること");

await w("r@mbpho obsidian_memo % ");
const prompt = cursorLine(t.buffer.active, t.cols).off;
assert.strictEqual(prompt, 24); // PS1 の幅

const cmd = "docker run -p 8080:8080 docker.stirlingpdf.com/stirlingtools/stirling-pdf";
await w(cmd); // 40 桁なので 2 回折り返す
const cur = cursorLine(t.buffer.active, t.cols);
assert.strictEqual(cur.text.slice(prompt, cur.off).trim(), cmd);

// 折り返さない短いコマンドも従来どおり
await w("\r\nr@host % ");
const p2 = cursorLine(t.buffer.active, t.cols).off;
await w("ls -la");
const c2 = cursorLine(t.buffer.active, t.cols);
assert.strictEqual(c2.text.slice(p2, c2.off).trim(), "ls -la");

console.log("ok");
