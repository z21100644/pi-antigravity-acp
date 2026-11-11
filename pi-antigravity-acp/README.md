# pi-antigravity-acp

通过官方 Antigravity CLI（`agy acp`）把模型接入 **PI Desktop**。

连接路径：`PI Desktop → 本机 HTTP 桥接 → agy ACP`。工具执行、权限和会话界面由 PI Desktop 管理；桥接保留完整 system/tools 指纹、会话复用、热池和未使用空 DB 回收。

## 安装

当前已验证 **Windows、PI Desktop 0.22.0、agy 1.5.5**。先安装并登录[官方 agy CLI](https://antigravity.google/docs/getting-started?tab=cli)，然后关闭 PI Desktop。

```powershell
git clone https://github.com/z21100644/pi-antigravity-acp.git
cd pi-antigravity-acp
powershell -NoProfile -ExecutionPolicy Bypass -File .\pi-antigravity-acp\scripts\install.ps1 -PiDesktopPath 'C:\path\to\PI-Desktop.exe'
```

将路径替换为自己的 `PI-Desktop.exe`；也可以指定它所在的文件夹。安装器使用 PI Desktop 自带的执行核心，不需要 npm 或额外安装 Node.js。

重启 PI Desktop，在模型选择器中选择 **Antigravity ACP**。当前声明 Gemini 4 Carbon、Gemini 4 Argon、Gemini 3.8 Flash 和 Claude Opus 5.5；实际可用性取决于 agy 登录账号。

安装器会备份已有插件，登记模型，并自动生成、保存本机桥接 token。**无需提供 OpenAI API key**。使用原生插件安装器，保留 `manifest.json`；PI Desktop 的 **Import pi extension** 会重建 manifest 并丢失 provider 声明，不适用于此包。

## 配置与排查

- 配置：`~/.pi-desktop/antigravity-acp.json`。
- ACP 数据：`~/.pi-desktop/cache/antigravity-acp/`。
- 日志：`~/.pi-desktop/logs/antigravity-acp.log`。
- 本机端点：`http://127.0.0.1:32187/v1`，仅监听本机并验证生成的 bearer token。

可选配置示例：

```json
{
  "defaultEffort": "medium",
  "warmup": true,
  "autoPatch": false
}
```

`command` 可指定 agy 的绝对路径，`home` 可指定 ACP 数据目录。`PI_DESKTOP_ANTIGRAVITY_CONFIG` 可覆盖配置文件路径。ACP 在首次模型请求时启动，随插件卸载关闭。

日志中的 `Local HTTP → ACP` 表示请求已进入桥接。若仍出现 OpenAI 的 API key 错误，重新运行安装器并重启 PI Desktop，确认 provider 指向上述本机端点。诊断和缓存文件不应提交到仓库。

## 来源

ACP 核心沿用 OMP 1.3.0 实现，基于 [lili-luo/dsh-plugin-bundle](https://github.com/lili-luo/dsh-plugin-bundle) 与 [121909 的适配](https://github.com/121909/dsh-plugin-bundle)。保留原项目 [MIT 许可证](LICENSE)。
