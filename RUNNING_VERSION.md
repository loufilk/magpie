# 历史运行版本的源码快照

本文件与 `runtime-snapshot.json` 记录 2026-10-28 归档时核实的运行版本
`v0.1.1364.chuanapi.kiro.4b966158.20261025`，不代表后续分支 HEAD 已部署。
当前源码的上游对齐与新跑验证见 [UPSTREAM_ALIGNMENT.md](UPSTREAM_ALIGNMENT.md)。

| 部分 | 固定版本 | 本分支位置 |
| --- | --- | --- |
| Magpie 主程序 | `4b9661584f9db5e6cae2d55a33bc0c94ae076886` | 归档提交 `b213aecf` 的父提交 |
| Kiro 插件 | `780aa7a717bbab5a2e74a7f12e0cbd8b66d9a13a`，包版本 `0.1.16` | 归档提交 `b213aecf` 下的 `local-plugins/kiro/` |

本次打包只新增 Kiro 插件源码、其原有 MIT 许可证和这份版本说明及
`runtime-snapshot.json`，不修改主程序源码。插件目录包含原始测试文件，
其文件哈希列在清单中；`index.mjs` 的 SHA256 与实际运行文件一致。

## 历史构建与插件注册（仅适用归档提交）

部署时使用 Go 1.27.3、`CGO_ENABLED=0` 和以下主程序构建命令：

```sh
CGO_ENABLED=0 go build -tags nogui -trimpath \
  -ldflags '-s -w -X main.version=v0.1.1364.chuanapi.kiro.4b966158.20261025' \
  -o magpie .
```

该命令仅记录归档源码的构建方法；不要给本轮更新后的源码使用上述旧版本号。
平台与工具链差异可能影响产物哈希，不能据此保证
新构建逐字节复现原二进制。原二进制 SHA256 保存在清单中。

通过 Magpie 的本地插件注册机制选择 `local-plugins/kiro` 的绝对路径。
仅保存这个目录不会自动启用插件。复现历史版本时应使用归档提交 `b213aecf`
的固定源码，避免以当前源码或 npm 最新版替代。当前插件说明见
[Kiro README](local-plugins/kiro/README.md)。

## 验证范围

本次上传核对了当前镜像身份、主程序二进制和插件入口哈希，以及部署时保存的
两份固定提交源码归档。上传没有改变服务或账户配置，也没有调用上游模型。
本次未重新运行 Go/GUI 或 Bun 测试，未重新部署。

部署时的历史验证使用 Bun 1.4.3，通过 224 项主程序定向回归、27 项用量缓存
回归和 153 项 Kiro 插件测试；该结果来自 2026-10-25 的部署记录，不是本次新跑的测试。

本分支只包含源码、合成测试、许可证与版本信息，不包含账号、认证令牌、密钥、
运行配置或业务数据。Magpie 与 magpie-community 的原有作者和许可证保持。
