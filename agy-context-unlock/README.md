# agy-context-unlock（可选独立工具）

保留自原仓库的本地补丁脚本，尝试扩展官方 Antigravity 客户端上下文窗口，并解除单条用户消息的截断限制。支持的平台和二进制布局取决于脚本匹配结果；不保证兼容所有后续官方版本。

**PI Desktop 接入不需要这个脚本。** 它不包含在 PI 插件安装包中；插件的 `autoPatch` 默认是 `false`，未解锁时按 256K 上下文运行。

## 风险

- `--in-place` 会修改官方 `agy` 或桌面端二进制，并可能改变代码签名。
- 官方升级会替换二进制；补丁可能失效或不再兼容。
- PI 移植的对话验证不包含二进制解锁。不要仅修改 `contextWindow` 元数据就认为官方服务端限制已解除。

## 手动检查或应用

先退出正在运行的 `agy`，确认官方安装路径并自行备份。macOS / Linux 示例：

```sh
python3 agy-patch.py --binary ~/.local/bin/agy --dry-run
# 仅在明确接受修改官方二进制的风险后执行：
python3 agy-patch.py --binary ~/.local/bin/agy --in-place
```

Windows PowerShell：

```powershell
python agy-patch.py --binary "$env:LOCALAPPDATA\agy\bin\agy.exe" --dry-run
python agy-patch.py --binary "$env:LOCALAPPDATA\agy\bin\agy.exe" --in-place
```

`--dry-run` 不写文件；`--in-place` 默认生成 `.bak` 备份。`agy-autopatch.py` 是上游保留的 macOS 自动补丁工具，不会由 PI 插件默认安装或启用。查看脚本 `--help` 了解其独立用法。

## 配置插件检查

将脚本放到 `~/.gemini/antigravity/tools/agy-patch.py`，或在 `~/.pi-desktop/antigravity-acp.json` 中配置 `patchScript`。插件启动 ACP 时可以检查状态；允许自动写入需显式设置 `"autoPatch": true`。不配置脚本也可使用基础 ACP 接入。
