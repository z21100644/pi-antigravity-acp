# pi-antigravity-acp

通过官方 `agy acp` 把 Antigravity 模型接入 **PI Desktop**。工具执行、权限和会话界面由 PI Desktop 管理。

```text
agy-context-unlock/    可选的官方客户端上下文补丁工具
pi-antigravity-acp/    PI Desktop 插件与安装脚本
patches/               PI 相关兼容补丁说明
.gitattributes
LICENSE
README.md
```

## 安装

已验证 Windows、PI Desktop 0.22.0、agy 1.5.5。先安装并登录官方 agy，关闭 PI Desktop 后运行：

```powershell
git clone https://github.com/z21100644/pi-antigravity-acp.git
cd pi-antigravity-acp
powershell -NoProfile -ExecutionPolicy Bypass -File .\pi-antigravity-acp\scripts\install.ps1 -PiDesktopPath 'C:\path\to\PI-Desktop.exe'
```

重启 PI Desktop，在模型选择器中选择 **Antigravity ACP**。安装器自动配置本机桥接 token，无需 OpenAI API key。

配置和排查见 [插件 README](pi-antigravity-acp/README.md)。[上下文解锁工具](agy-context-unlock/README.md) 独立使用，插件安装不会修改 agy 二进制。

ACP 核心基于 [lili-luo/dsh-plugin-bundle](https://github.com/lili-luo/dsh-plugin-bundle) 与 [121909 的适配](https://github.com/121909/dsh-plugin-bundle)，保留 [MIT 许可证](LICENSE)。
