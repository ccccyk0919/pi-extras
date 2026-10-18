/**
 * web-search-summary-model —— 让 web_search 的摘要模型自动跟随当前会话模型
 *
 * 背景：pi-web-access 的 `summaryModel` 只接受字面量 "provider/model-id[:thinking]"，
 * 没有「跟随当前模型」这种动态值；不配置时按内置候选表取第一个可用的
 * （anthropic/haiku → openai-codex → google → openai → deepseek），
 * 跟本会话实际在用的模型无关。
 *
 * 做法：监听 model_select（/model 切换、Ctrl+P 循环、会话恢复）与
 * session_start（启动/新建/恢复/reload），把当前 ctx.model 写进
 * web-search.json 的 summaryModel 字段（路径按 pi-web-access 的解析链求，
 * 见 resolveConfigPath——本机为 ~/.pi/agent/web-search.json）。
 * pi-web-access 每次 web_search 都重新读该文件（loadConfig 无缓存），所以即时生效。
 *
 * 取舍（有意为之）：
 * - 只同步 provider/id，**不带 thinking 后缀**。摘要生成默认 30s 超时
 *   （summaryGenerationDeadlineMs），跟随高 reasoning 等级会拖慢甚至超时退化成
 *   确定性摘要。想要别的行为，在 syncSummaryModel 里给 value 补 ":low" 之类后缀。
 * - 配置文件是全局的：多个 pi 会话用不同模型时互相覆盖，以最后触发的事件为准。
 * - 只会改写 summaryModel 一个字段，其余配置原样保留；配置 JSON 损坏时跳过不写，
 *   避免把用户手写的文件覆盖成空。
 * - 停用：删掉本文件后 /reload。手动想临时换摘要模型，改 web-search.json 即可，
 *   但下次切模型或新会话会被本扩展覆盖回来。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type ActiveModel = { provider?: string; id?: string } | null | undefined;

/**
 * 解析 web-search.json 的路径。复刻 pi-web-access utils.ts 里
 * getWebSearchConfigDir() 的解析链——它并非硬编码 ~/.pi/agent：
 *   PI_CODING_AGENT_DIR → $XDG_CONFIG_HOME/pi → ~/.pi（legacy）→ ~/.pi/agent
 * 本机（两个环境变量都未设）落在最后一条。硬编码会让扩展在设了
 * XDG_CONFIG_HOME / PI_CODING_AGENT_DIR 的机器上写错文件。
 */
function resolveConfigPath(): string {
    const explicitDir = process.env.PI_CODING_AGENT_DIR;
    if (explicitDir) return join(explicitDir, "web-search.json");

    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    if (xdgConfigHome) {
        const xdgDir = join(xdgConfigHome, "pi");
        if (existsSync(join(xdgDir, "web-search.json"))) return join(xdgDir, "web-search.json");
        const legacyDir = join(homedir(), ".pi");
        if (existsSync(join(legacyDir, "web-search.json"))) return join(legacyDir, "web-search.json");
        return join(xdgDir, "web-search.json");
    }
    return join(homedir(), ".pi", "agent", "web-search.json");
}

/** 读配置：文件缺失返回 {}；JSON 损坏返回 null（调用方跳过，不覆盖用户文件）。 */
function readConfig(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return {};
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** 原子写 JSON（先 tmp 再 rename），避免读到写了一半的文件。 */
function atomicWriteJson(path: string, obj: Record<string, unknown>): void {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
    renameSync(tmp, path);
}

/**
 * 把当前模型写进 summaryModel。返回 true = 确实改写了文件。
 * 只动 summaryModel 一个字段，其余配置原样保留。
 */
function syncSummaryModel(model: ActiveModel): boolean {
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id) return false;

    const value = `${provider}/${id}`;
    const path = resolveConfigPath();
    const config = readConfig(path);
    if (!config) {
        console.warn(`[web-search-summary-model] ${path} 不是合法 JSON，跳过同步`);
        return false;
    }
    if (config.summaryModel === value) return false; // 已一致，避免无谓写盘

    config.summaryModel = value;
    try {
        atomicWriteJson(path, config);
    } catch (err) {
        console.warn(
            `[web-search-summary-model] 写入失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
    }
    return true;
}

export default function webSearchSummaryModelFollow(pi: ExtensionAPI): void {
    // 切模型（/model、Ctrl+P 循环、会话恢复）→ 立刻同步并提示
    pi.on("model_select", async (event, ctx) => {
        if (syncSummaryModel(event.model)) {
            ctx.ui.notify(`web_search 摘要模型 → ${event.model.provider}/${event.model.id}`, "info");
        }
    });

    // 启动 / 新建 / 恢复 / reload → 静默同步一次（覆盖上次手动改过的配置）
    pi.on("session_start", async (_event, ctx) => {
        syncSummaryModel(ctx.model);
    });

    // 手动查看与同步
    pi.registerCommand("websearch-summary-model", {
        description: "Show and sync the web_search summary model (auto-follows the current model)",
        handler: async (_args, ctx) => {
            const changed = syncSummaryModel(ctx.model);
            const config = readConfig(resolveConfigPath());
            const configured =
                typeof config?.summaryModel === "string" ? config.summaryModel : "(未设置)";
            const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(未知)";
            ctx.ui.notify(
                changed
                    ? `summaryModel 已同步 → ${configured}`
                    : `summaryModel = ${configured}；当前模型 = ${current}${configured === current ? "（一致）" : ""}`,
                "info",
            );
        },
    });
}
