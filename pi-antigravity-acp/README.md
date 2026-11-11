# pi-antigravity-acp

通过官方 Antigravity CLI（`agy acp`）把模型接入 **PI Desktop**。

连接路径：`PI Desktop → 本机 HTTP 桥接 → agy ACP`。工具执行、权限和会话界面由 PI Desktop 管理；桥接保留完整 system/tools 指纹、会话复用、热池和未使用空 DB 回收。

## 安装

当前已验证 **Windows、PI Desktop 0.22.0、agy 1.5.5**。先安装并登录[官方 agy CLI](https://antigravity.google/docs/getting-started?tab=cli)，然后关闭 PI Desktop。

插件要求 **agy >= 1.5.1**。从该版本起，官方 ACP 向所有客户端提供账号可用的全部模型；插件以 `pi-desktop` 声明客户端身份。

```powershell
git clone https://github.com/z21100644/pi-antigravity-acp.git
cd pi-antigravity-acp
powershell -NoProfile -ExecutionPolicy Bypass -File .\pi-antigravity-acp\scripts\install.ps1 -PiDesktopPath 'C:\path\to\PI-Desktop.exe'
```

将路径替换为自己的 `PI-Desktop.exe`；也可以指定它所在的文件夹。安装器使用 PI Desktop 自带的执行核心，不需要 npm 或额外安装 Node.js。

重启 PI Desktop，在模型选择器中选择 **Antigravity ACP**。当前声明 Gemini 4 Carbon、Gemini 4 Argon、Gemini 3.8 Flash 和 Claude Opus 5.5；实际可用性取决于 agy 登录账号。

安装器会备份已有插件，登记模型，并自动生成、保存本机桥接 token。**无需提供 OpenAI API key**。使用原生插件安装器，保留 `manifest.json`；PI Desktop 的 **Import pi extension** 会重建 manifest 并丢失 provider 声明，不适用于此包。

0.3.0 的插件 ID 为 `pi-antigravity-acp`，provider ID 为 `plugin:pi-antigravity-acp:antigravity`。从旧 ID `imported.omp-antigravity-acp` 升级时，安装器迁移私有数据、注销旧插件并将旧文件移入备份。旧对话的 provider 引用不迁移；重启后在新对话中选择新版 Antigravity ACP。

## 配置与排查

- 配置：`~/.pi-desktop/antigravity-acp.json`。
- ACP 数据：`~/.pi-desktop/cache/antigravity-acp/`。
- 插件私有数据：`~/.pi-desktop/plugins/data/pi-antigravity-acp/`。
- 日志：`~/.pi-desktop/logs/antigravity-acp.log`。
- 本机端点：`http://127.0.0.1:32187/v1`，仅监听本机并验证生成的 bearer token。

可选配置示例：

```json
{
  "defaultEffort": "medium",
  "warmup": true,
  "coldSwitchSettleMs": 80,
  "autoPatch": false
}
```

`command` 可指定 agy 的绝对路径，`home` 可指定 ACP 数据目录。`PI_DESKTOP_ANTIGRAVITY_CONFIG` 可覆盖配置文件路径。ACP 在首次模型请求时启动，随插件卸载关闭。

日志中的 `Local HTTP → ACP` 表示请求已进入桥接。若仍出现 OpenAI 的 API key 错误，重新运行安装器并重启 PI Desktop，确认 provider 指向上述本机端点。诊断和缓存文件不应提交到仓库。

Windows 后台启动的 ACP 主进程、额度查询和安装登记均设置 `windowsHide: true`。ACP 保留 stdin/stdout/stderr 管线，由插件管理退出；冷启动、warmup 和重新建立前端进程共用这条启动路径。无需切换安装版或关闭 warmup。更新后已启动的旧进程需由插件重新载入或 PI Desktop 重启替换。

## 会话恢复与用量

- 已完成的主对话保存在 ACP 数据目录的 `session-index.json`，通过临时文件和 rename 更新。PI Desktop 重启或空闲会话被淘汰后，插件会检查 system 和历史内容指纹，使用 `session/load` 恢复原 ACP session，并重新绑定 MCP 端点。历史被改写、压缩或加载失败时，从 PI 的历史重建；每次新 prompt 提交前撤销索引，避免恢复未完成的原生上下文。
- 用量优先读取 `gen_metadata.data` 的生成记录，在轮末用已完成的 model steps 补齐缺口。两表按用量记录及出现次数对账，处理晚到记录和重复读取；旧版数据库保留 steps 路径。数据库样本保留原始 token 总量，无法读取数据库时沿用 ACP 轮末归一化用量。
- 模型与推理等级依次设置，并检查返回值，未生效时重试一次。每次 prompt、热池取用、工具结果续跑与长回复 continuation 都会向 ACP 重新确认 PI 指定的 `thought_level`，不只相信本机缓存。`coldSwitchSettleMs` 接受 `0..2000` 的整数，默认 `80`；仅在新建或恢复的 session 确实切换设置后等待，取消请求会中断等待。

推理等级严格遵循 PI 的 `low / medium / high` 选择。模型不支持所选等级、缺少 selector 或 ACP 没有回传确认值时，请求明确失败，不自动换成较低等级。固定 `medium` 的模型只接受 `medium` 请求。此前把 `off/minimal` 映射为 `low`、把 `xhigh/max` 映射为 `high` 的行为已移除；旧对话若保存了这些值，请在 PI 中改选实际支持的等级。

工具等待期间收到的降档通知会在交还结果前修正；生成期间若 ACP 报告不同模型或推理等级，会中止该轮并撤销恢复索引，避免继续交付未按选择执行的回复。日志中的 `configuration confirmed` 记录请求与确认等级及入口阶段。`zero-thought usage sample` 仅记录账单中的零思考 token，不将其解释为自动降档、热池标记或恢复正常的证据；思考 token 数量也不作为自动重试条件。

原生 agy 在 `session/prompt` 开始时固定 executor 的模型与推理等级；工具等待期间的设置确认只影响后续 prompt。PI 在这期间切换模型或等级时，插件会取消旧 executor，从 PI 历史和已完成的工具结果重建 ACP session，再按新选择继续，不重新执行已完成的工具。日志记录 `restarting executor`。选择未变时继续沿用原 ACP session。

已在 PI Desktop 0.22.0、agy 1.5.5 上验证带历史对话的完整进程重启：续问仍沿用原 ACP session ID，并正确回忆此前保存的验证信息。日志中的 `antigravity-acp: restored session <id>` 仅在恢复后的复用计划成立时记录；最终索引也应保留相同 ID。

原生 agent 为 `pi-desktop-bridge`，MCP server 为 `pi`，工具使用 `mcp_pi_*` 前缀；辅助工具为 `pi_call_tool` 与 `pi_await_result`，历史重放使用 `<pi_history>`。恢复索引记录工具命名空间，避免把旧声明载入新版运行环境。

## 实时额度面板

输入框右侧、原生上下文用量指示器左侧显示迷你进度条与 **5H** 剩余比例。第一层省略小数，例如 `95.8%` 显示为 `95%`；控件沿用原生指示器的字级、字重和行高，并跟随相邻原生按钮的实际高度；尚无上下文指示器时使用 28px。点击打开宽 240px 的额度小窗，仅列出 Gemini 与 Claude/GPT 的五小时、每周剩余额度，保留一位小数；鼠标停留或键盘聚焦各行时显示重置时间，按 Escape 或点击外部关闭。按钮优先显示此对话最近一次 AGY 请求的模型组；尚无请求时显示 Gemini。

- 订阅比例来自官方 `agy -p /usage --output-format json`，不从 token 换算。默认缓存 120 秒（`quotaTtlMs`）；模型请求完成后可提前刷新，所有查询共用 15 秒节流及单个执行中的命令。查询不生成模型回复，也不需要先启动 ACP。
- 小窗只呈现订阅额度；请求用量与 SQLite 对账继续由后台监控记录，估算不写入已报告累计，也不扣减订阅比例。
- 面板展开时每秒读取本机监控快照，折叠时每五秒读取，窗口隐藏后暂停。保持标准 OpenAI SSE 格式；PI 的 renderer 扩展通过 `plugin.call` 读取本机快照。
- 官方额度保存在 ACP 数据目录的 `quota-cache.json`，重启可立即显示。查询失败保留旧比例和原更新时间，小窗显示旧快照状态及错误；快照时间收在按钮的鼠标提示中。标题等辅助请求只反映在官方订阅额度中。

现有安装请关闭 PI Desktop 后重新运行安装器。面板新增 `renderer.extension` 权限，需要明确重新载入插件；仅热更新文件不会授予新权限。该权限用于 PI 原生输入列控制项和浮层，不读取历史对话内容。

## 开发验证

在本目录运行：

```powershell
npm test
```

测试使用 `tests/fake-agy.mjs` 模拟 ACP 协议，覆盖 HTTP 历史转换、重启恢复、用量对账、工具交接、取消、standby 清理，以及额度缓存、节流、过期快照和流中监控。它仅用于测试，不随插件安装。实际对话、截图、日志、数据库和安装备份应保存在仓库之外。

## 来源

ACP 核心沿用 OMP 1.3.0 实现，基于 [lili-luo/dsh-plugin-bundle](https://github.com/lili-luo/dsh-plugin-bundle) 与 [121909 的适配](https://github.com/121909/dsh-plugin-bundle)。保留原项目 [MIT 许可证](LICENSE)。

生成记录解析、持久化会话流程和冷切换等待参考 [dsh-plugin-bundle v0.4.0（`0a90ec3`）](https://github.com/lili-luo/dsh-plugin-bundle/tree/0a90ec37c69430608084e33ebc2f891e328c9e89/dsh-llm-antigravity-acp)，并适配 PI Desktop 的历史指纹、HTTP provider 身份和原有容量管理。

额度面板使用 PI Desktop 官方 [renderer SDK](https://github.com/vastsa/PI-Desktop/blob/main/packages/plugin-sdk/src/renderer.ts) 的 `composerControl`、`openLayer` 和 `plugin.call`，按[插件开发说明](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md)重新载入新增权限。
