/**
 * board-name-sync —— 把 pi session 名自动同步到 agent-board 行名
 *
 * 监听 session_info_changed(pi.setSessionName / /name / RPC 触发),
 * 若当前 session 被 agent-board adopt 过(/bg 或 dispatch),就把
 * board 行的 meta.name 同步成 session 名,写回 meta.json(原子写)。
 *
 * 自包含:不 import board 内部模块,直接读写
 *   ~/.pi/agent/agent-board/views/<viewId>/meta.json
 * 字段格式稳定(id/name/sessionFile/updatedAt),board 渲染时从盘读,
 * 下次刷新(按 r 或自然重渲染)即看到新行名。
 *
 * 单向:session 名 → board 行名。不反向(避免循环)。
 * 只对「被 board adopt 的 session」生效;普通 session 找不到匹配行,
 * 直接 return,零干扰。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BOARD_ROOT = join(homedir(), ".pi", "agent", "agent-board");
const VIEWS_DIR = join(BOARD_ROOT, "views");

/** 规范化路径比较:斜杠方向统一(\\→/)、去尾斜杠、大小写兜底。 */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ra = a.replace(/\\/g, "/").replace(/\/+$/, "");
  const rb = b.replace(/\\/g, "/").replace(/\/+$/, "");
  return ra === rb || ra.toLowerCase() === rb.toLowerCase();
}

interface BoardMeta {
    id: string;
    name?: string;
    sessionFile?: string;
    archived?: boolean;
    updatedAt?: number;
    [key: string]: unknown;
}

/** 按 sessionFile 在 board 所有 view 里找匹配的 meta(返回路径+内容)。 */
function findRowMeta(sessionFile: string): { path: string; meta: BoardMeta } | null {
    if (!sessionFile || !existsSync(VIEWS_DIR)) return null;
    let entries: ReturnType<typeof readdirSync>;
    try {
        entries = readdirSync(VIEWS_DIR, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        const metaPath = join(VIEWS_DIR, e.name, "meta.json");
        if (!existsSync(metaPath)) continue;
        try {
            const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as BoardMeta;
            if (meta.sessionFile && samePath(meta.sessionFile, sessionFile)) {
                return { path: metaPath, meta };
            }
        } catch {
            // 坏 meta 跳过,不阻断其他行
        }
    }
    return null;
}

/** 原子写 JSON:先写 tmp,再 rename(对齐 board 的 writeMeta 写法)。 */
function atomicWriteJson(path: string, obj: BoardMeta): void {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
    renameSync(tmp, path);
}

/** 核心同步逻辑:把当前 session 名写到匹配的 board 行。返回是否同步过。 */
function syncCurrentSession(sessionFile: string, name: string): boolean {
    if (!name || !name.trim()) return false; // 名被清空,不同步(保留 board 行原名)
    const row = findRowMeta(sessionFile);
    if (!row) return false; // 非 board adopt 的 session,跳过
    if (row.meta.name === name) return false; // 已同步,避免无谓写盘
    row.meta.name = name;
    row.meta.updatedAt = Date.now();
    atomicWriteJson(row.path, row.meta);
    return true;
}

export default function boardNameSync(pi: ExtensionAPI): void {
    // 自动:session 名一变就同步 board 行
    pi.on("session_info_changed", async (event, ctx) => {
        const name = event.name;
        if (!name) return; // undefined = 名被清除,跳过
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) return;
        if (syncCurrentSession(sessionFile, name)) {
            ctx.ui.notify(`Board row synced → ${name}`, "info");
        }
    });

    // 手动:回填当前 session 的名字到 board 行(用于扩展加载前已改名、或漏接事件)
    pi.registerCommand("sync-board-name", {
        description: "Sync current session name to its agent-board row (one-shot)",
        handler: async (_args, ctx) => {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) {
                ctx.ui.notify("No current session file to sync.", "warning");
                return;
            }
            const name = ctx.sessionManager.getSessionName();
            if (!name) {
                ctx.ui.notify("Session has no name. Run /name-ai or /name first.", "warning");
                return;
            }
            if (syncCurrentSession(sessionFile, name)) {
                ctx.ui.notify(`Board row synced → ${name}. Press r in /agent-board to refresh.`, "info");
            } else {
                const row = findRowMeta(sessionFile);
                if (!row) ctx.ui.notify("Current session is not adopted by agent-board (no matching row).", "warning");
                else ctx.ui.notify(`Already in sync: ${name}`, "info");
            }
        },
    });
}
