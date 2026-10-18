/**
 * md-view —— 在本机默认浏览器打开 markdown 文件
 *
 * 用法：
 *   /view          自动打开当前会话最近消息中出现的最新 .md 文件
 *   /view <path>   打开指定文件（仅支持绝对路径或 ~ 开头的路径）
 *
 * 原理：起一个临时本地 HTTP 服务渲染 md，再按平台调用系统命令打开浏览器；
 * 成功后 60 秒自动关闭服务，避免端口泄漏。
 *
 * 提取 md 路径：字符集只收路径能出现的字符（ASCII 可见 + 中文/全角字母数字），
 * 遇到空白、ASCII 非路径标点、全角标点（如"（"）自动截断。
 * 解析为绝对路径：支持 ~ 开头和绝对路径（含 git-bash 的 /c/... 盘符写法）；
 * 相对路径返回 null（不支持）。
 * 从最新一条消息往回扫，返回第一条含 .md 路径的消息里最后出现的那个路径。
 * 按平台调用系统命令打开浏览器（WSL 走 Windows 的 cmd.exe）。
 *
 * 零依赖：手写极简 markdown 渲染器（HTML 转义防 XSS）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MD_RE = /\.md$/i;
const SERVER_TTL_MS = 60_000;

/**
 * 路径字符集（取反）：排除空白、控制字符、ASCII 非路径标点（<>"|?*,）、
 * 全角标点区（\u3000-\u303f 中文标点、\uFF01-\uFF0F、\uFF1A-\uFF1F、
 * \uFF3B-\uFF3F、\uFF5B-\uFF5E 全角标点；全角字母数字 \uFF10-\uFF5A 收进）。
 */
const TOKEN_RE = /[^\s<>\x00-\x1f"|?*,\u3000-\u303f\uff01-\uff0f\uff1a-\uff1f\uff3b-\uff3f\uff5b-\uff5e]+/g;

/** 提取文本中最后一个以 .md 结尾的路径 token（URL 丢弃）。 */
export function extractMdPath(text: string): string | null {
  if (!text) return null;
  let found: string | null = null;
  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (tok.includes("://")) continue; // URL 不算路径
    if (MD_RE.test(tok)) found = tok; // 最后一个覆盖前面
  }
  return found;
}

/**
 * 解析为绝对路径：~ 开头展开；绝对路径保留；
 * win32 上 git-bash 风格 /c/Users/... 转盘符；其余（相对路径）返回 null。
 */
export function resolvePath(p: string): string | null {
  if (!p || !p.trim()) return null;
  p = p.trim().replace(/^["']|["']$/g, "");
  if (p.startsWith("~")) {
    if (p === "~") return homedir();
    return join(homedir(), p.slice(1).replace(/^[/\\]/, ""));
  }
  if (process.platform === "win32") {
    const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
    if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
    return isAbsolute(p) ? p : null;
  }
  return isAbsolute(p) ? p : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 相对图片路径 → file:// 绝对 URL；外部 URL 原样。 */
function resolveImgSrc(url: string, baseDir?: string): string {
  if (/^(https?:|data:|file:)/.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (!baseDir) return url;
  const abs = resolve(join(baseDir, url));
  let u = abs.replace(/\\/g, "/");
  if (process.platform === "win32") u = "/" + u;
  return "file://" + encodeURI(u);
}

/** 行内解析：先整体转义，再做图片/链接/代码/粗体/斜体替换。 */
function inline(s: string, baseDir?: string): string {
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => {
    return `<img src="${resolveImgSrc(url, baseDir)}" alt="${escapeHtml(alt)}">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const href = /^(https?:|file:|mailto:)/.test(url) ? url : escapeHtml(url);
    return `<a href="${href}">${text}</a>`;
  });
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return s;
}

/** 极简 markdown → HTML：fenced 代码块、标题、hr、引用、列表、段落 + 行内。 */
export function renderMarkdown(src: string, opts?: { baseDir?: string }): string {
  const baseDir = opts?.baseDir;
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  let listOrdered = false;
  let quote: string[] = [];

  const flushPara = () => { if (para.length) { out.push(`<p>${para.join(" ")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(listOrdered ? `<ol>${list.join("")}</ol>` : `<ul>${list.join("")}</ul>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.join("")}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (inCode) {
      if (line.trim().startsWith("```")) {
        inCode = false;
        out.push(`<pre><code${codeLang ? ` class="language-${codeLang}"` : ""}>${codeBuf.join("\n")}\n</code></pre>`);
        codeBuf = [];
        codeLang = "";
      } else {
        codeBuf.push(escapeHtml(line));
      }
      continue;
    }
    const fence = line.match(/^```([\w+-]*)/);
    if (fence) { flushAll(); inCode = true; codeLang = fence[1]; continue; }

    const trimmed = line.trim();
    if (!trimmed) { flushAll(); continue; }

    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${inline(h[2], baseDir)}</h${h[1].length}>`); continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); out.push("<hr>"); continue; }

    const q = trimmed.match(/^>\s?(.*)$/);
    if (q) { flushPara(); flushList(); quote.push(`<p>${inline(q[1], baseDir)}</p>`); continue; }

    const ul = trimmed.match(/^[-*+]\s+(.*)$/);
    const ol = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara(); flushQuote();
      const ordered = !!ol;
      const item = inline((ul ?? ol)![1], baseDir);
      if (!list || listOrdered !== ordered) { flushList(); list = []; listOrdered = ordered; }
      list.push(`<li>${item}</li>`);
      continue;
    }
    flushList();

    para.push(inline(trimmed, baseDir));
  }
  if (inCode) {
    out.push(`<pre><code${codeLang ? ` class="language-${codeLang}"` : ""}>${codeBuf.join("\n")}\n</code></pre>`);
  }
  flushAll();

  return out.join("\n");
}

function renderPage(filePath: string, body: string): string {
  const title = escapeHtml(filePath.split(/[\\/]/).pop() ?? filePath);
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{max-width:760px;margin:24px auto;padding:0 16px;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;color:#24292f}
h1,h2,h3{border-bottom:1px solid #eaecef;padding-bottom:.3em}
pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow-x:auto}
code{background:#f6f8fa;padding:.15em .4em;border-radius:4px;font-family:Consolas,Menlo,monospace;font-size:.92em}
pre code{background:none;padding:0}
blockquote{border-left:4px solid #dfe2e5;color:#6a737d;margin:0;padding:0 1em}
img{max-width:100%}
a{color:#0969da}
.filebar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #eaecef;font-size:13px;color:#57606a;margin-bottom:12px}
</style></head><body><div class="filebar">📄 ${title}</div>${body}</body></html>`;
}

/** 起临时 HTTP 服务（127.0.0.1 随机端口），60s 后自动关闭。 */
export function startServer(filePath: string, body: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolveStart, reject) => {
    const server = createServer((req, res) => {
      if (req.url !== "/" && req.url !== "/index.html") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(filePath, body));
    });
    let timer: NodeJS.Timeout | null = null;
    const close = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      try { if (server.listening) server.close(); } catch { /* 幂等 */ }
    };
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { close(); reject(new Error("failed to bind port")); return; }
      timer = setTimeout(close, SERVER_TTL_MS);
      timer.unref?.();
      resolveStart({ url: `http://127.0.0.1:${addr.port}/`, close });
    });
  });
}

/** WSL 检测（走 Windows cmd.exe 时用）。 */
function isWsl(): boolean {
  return process.platform === "linux" && (!!process.env.WSL_DISTRO_NAME || !!process.env.WSL_INTEROP);
}

/** 按平台调用系统命令打开浏览器。 */
export function openBrowser(url: string): Promise<void> {
  return new Promise((res, rej) => {
    const spec =
      process.platform === "win32" || isWsl()
        ? { file: "cmd.exe", args: ["/c", "start", "", url], verbatim: true }
        : process.platform === "darwin"
          ? { file: "open", args: [url], verbatim: false }
          : process.platform === "linux"
            ? { file: "xdg-open", args: [url], verbatim: false }
            : null;
    if (!spec) { rej(new Error(`unsupported platform: ${process.platform}`)); return; }
    const child = spawn(spec.file, spec.args, {
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments: spec.verbatim,
    });
    child.on("error", rej);
    child.on("spawn", () => { child.unref(); res(); });
  });
}

/** 从 session entry 里取文本内容（真实格式：message.content 在 entry.message.content）。 */
export function entryText(entry: unknown): string {
  const e = entry as { message?: { content?: unknown }; content?: unknown };
  const content = e.message?.content ?? e.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in (c as object) ? String((c as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

let activeServer: { close: () => void } | null = null;

export default function mdView(pi: ExtensionAPI): void {
  // 兜底：session 结束/切换时关闭仍在运行的服务
  pi.on("session_shutdown", () => {
    if (activeServer) { activeServer.close(); activeServer = null; }
  });

  pi.registerCommand("view", {
    description:
      "在默认浏览器打开 markdown 文件。/view 自动找最近消息里的 .md 路径；/view <path> 指定绝对路径或 ~ 路径",
    handler: async (args, ctx) => {
      let target: string | null = null;
      if (args && args.trim()) {
        target = args.trim();
      } else {
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const p = extractMdPath(entryText(entries[i]));
          if (p) { target = p; break; }
        }
        if (!target) {
          ctx.ui.notify("未在最近消息中找到 .md 文件路径。可手动指定：/view <绝对路径>", "warning");
          return;
        }
      }

      const filePath = resolvePath(target);
      if (!filePath) {
        ctx.ui.notify(`不支持相对路径：${target}（仅支持绝对路径或 ~ 开头）`, "warning");
        return;
      }
      if (!MD_RE.test(filePath)) {
        ctx.ui.notify(`不是 markdown 文件：${filePath}`, "warning");
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        ctx.ui.notify(`文件不存在：${filePath}`, "error");
        return;
      }

      let src: string;
      try {
        src = readFileSync(filePath, "utf-8");
      } catch (e) {
        ctx.ui.notify(`读取失败：${(e as Error).message}`, "error");
        return;
      }
      const html = renderMarkdown(src, { baseDir: dirname(filePath) });

      try {
        const server = await startServer(filePath, html);
        activeServer = server;
        try {
          await openBrowser(server.url);
        } catch {
          ctx.ui.notify(`浏览器打开失败，请手动访问：${server.url}`, "warning");
        }
        ctx.ui.notify(`已打开 ${filePath} → ${server.url}（60s 后自动关闭）`, "info");
      } catch (e) {
        ctx.ui.notify(`启动预览服务失败：${(e as Error).message}`, "error");
      }
    },
  });
}
