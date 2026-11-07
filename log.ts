// PTY の生ログからコマンド出力だけを取り出す。

/** xterm のバッファのうち、ここで使う部分だけ */
export type Buf = {
  baseY: number;
  cursorX: number;
  cursorY: number;
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight: boolean): string } | undefined;
};

/**
 * カーソルがいる論理行（折り返しを連結したもの）と、その先頭からのカーソル位置を返す。
 * cursorY はビューポート基準なので baseY を足さないと、スクロール後に過去の行を読んでしまう。
 */
export function cursorLine(b: Buf, cols: number): { text: string; off: number } {
  const row = b.baseY + b.cursorY;
  let top = row;
  while (top > 0 && b.getLine(top)?.isWrapped) top--; // 折り返しの先頭まで遡る
  let text = "";
  for (let y = top; y <= row; y++) text += b.getLine(y)?.translateToString(false) ?? "";
  return { text, off: (row - top) * cols + b.cursorX };
}
const ANSI =
  /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][\x20-\x7e]|\x1b[=>]/g;

/**
 * Enter 直後から次の Enter までの生ログを、挿入用のテキストに整形する。
 * - ANSI エスケープと制御文字を除去
 * - 行内の \r は最後のセグメントを採用（上書き描画の近似）
 * - 末尾の「改行で終わっていない行」= 次のプロンプト(PS1) なので落とす
 *   （keepTail: コマンド実行中の途中挿入では、その行はプロンプトではなく出力なので残す）
 * ponytail: 改行なしで終わる出力（printf abc 等）は最終行がプロンプトと一緒に落ちる。
 *           困ったらシェル統合 (OSC 133) に切り替える。
 */
export function clean(raw: string, keepTail = false): string {
  const lines = raw
    .replace(ANSI, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n");
  // 末尾の部分行 = 次のプロンプト（末尾が改行なら空文字）。実行中なら出力なので残す
  if (!keepTail || lines[lines.length - 1] === "") lines.pop();
  const out = lines.map((l) => {
    const seg = l.split("\r").filter((s) => s !== "");
    return (seg.length ? seg[seg.length - 1] : "").replace(/\s+$/, "");
  });
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}
