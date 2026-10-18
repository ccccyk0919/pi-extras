# pi-extras

个人用的 pi 扩展合集：3 个自包含扩展（零运行时依赖，只用 pi 类型 + Node 内置模块），外加一份 `pi-recap` 配置参考。

## 安装

```bash
pi install git:github.com/ccccyk0919/pi-extras
```

安装后重启 pi（或 `/reload`）生效。`pi list` 应能看到 `git:github.com/ccccyk0919/pi-extras`。

> **从手工目录迁移时**：如果 `~/.pi/agent/extensions/` 下还留着同名 `.ts` 文件，先删掉再装，否则同一扩展会被加载两次（重复注册 slash command / 事件监听）。

## 扩展

### `board-name-sync`

把 pi session 名单向同步到 [pi-agent-board](https://github.com/zhuxixi/pi-agent-board) 对应行的 `meta.name`。

- 监听 `session_info_changed`（`/name`、`pi.setSessionName`、RPC 触发）
- 只在当前 session 被 board `adopt` 过（`/bg`、dispatch）时生效；普通 session 找不到匹配行直接返回，零干扰
- 自包含：不 import board 内部模块，直接原子读写 `~/.pi/agent/agent-board/views/<viewId>/meta.json`

依赖：pi-agent-board 已安装（未安装时扩展静默无操作）。

### `md-view`

用本机默认浏览器渲染 markdown。

```
/view            # 打开当前会话最近消息里最新出现的 .md 文件
/view <path>     # 打开指定文件（绝对路径或 ~ 开头；相对路径不支持）
```

- 临时本地 HTTP 服务渲染，60 秒后自动关闭，避免端口泄漏
- 手写极简 markdown 渲染器，HTML 转义防 XSS
- 路径提取兼容中文路径与 git-bash 的 `/c/...` 写法；WSL 走 `cmd.exe` 打开

零依赖。

### `web-search-summary-model`

让 [pi-web-access](https://www.npmjs.com/package/pi-web-access) 的 `web_search` 摘要模型自动跟随当前会话模型。

- 监听 `model_select` 与 `session_start`，把当前 `ctx.model` 写进 `web-search.json` 的 `summaryModel`
- 每次 `web_search` 重新读配置，即时生效
- 只同步 `provider/id`，**不带 thinking 后缀**（摘要默认 30s 超时，高 reasoning 会拖慢甚至超时退化为确定性摘要）
- 只改写 `summaryModel` 一个字段，其余配置原样保留；JSON 损坏时跳过不写

依赖：pi-web-access。配置路径按 `PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi` → `~/.pi` → `~/.pi/agent` 解析。

## 配置：`config/pi-recap.json`

`@tifan/pi-recap` 把配置**硬编码**在 `~/.pi/agent/extensions/pi-recap.json`，包无法声明该文件，必须手动复制：

```bash
# bash / git-bash
cp config/pi-recap.json ~/.pi/agent/extensions/pi-recap.json
```

```powershell
# PowerShell
Copy-Item config\pi-recap.json "$env:USERPROFILE\.pi\agent\extensions\pi-recap.json"
```

内容为 `{"model": "deepseek/deepseek-flash"}`，按自己可用的 provider 改。

## 不在本仓库的内容

| 资源 | 原因 / 去处 |
| --- | --- |
| `spec-reviewer.md` agent | 与 `zima-blue-cli` 包内 `pi/agents/spec-reviewer.md` 内容完全一致，由该包提供，避免重复维护 |
| `pi-statusbar` 扩展 | 独立仓库 <https://github.com/zhuxixi/pi-statusbar>，非本仓库内容 |

## 已知限制

- `board-name-sync` 的 board 路径硬编码为 `homedir()/.pi/agent/agent-board`，不跟随 `PI_CODING_AGENT_DIR`
- `web-search-summary-model` 写的是**全局** `web-search.json`：多个 pi 会话用不同模型时会互相覆盖，以最后触发的事件为准
- 三个扩展均在 Windows 上验证；`md-view` 的浏览器唤起在 Linux 走 `xdg-open`（未实测）

## 更新

```bash
pi update --extensions
```

## License

MIT
