# Magpie 官方宿主集成验证

## 复现

需要 Node.js 22/24、可运行的 Bun，以及与待测试 Magpie 版本相同的官方源码。完整 HTTP 集成还需要官方 Linux x64 CLI 二进制和 `bubblewrap`。测试不会下载模型或运行付费推理。

在插件目录运行：

```sh
MAGPIE_HOST_PATH=/absolute/path/to/magpie/internal/plugin/host.js \
MAGPIE_BUN=/absolute/path/to/bun \
MAGPIE_BINARY_PATH=/absolute/path/to/magpie \
npm run test:magpie
```

省略 `MAGPIE_BINARY_PATH` 时，只运行两组官方 Bun 宿主测试。指定 `MAGPIE_PLUGIN_PATH=/absolute/path/to/package` 可以验证仓库根目录的安装入口，默认验证本插件目录。`MAGPIE_INTEGRATION_DEBUG=1` 输出 CLI 启动诊断。

源码和二进制应来自同一官方版本，例如 [Magpie v0.1.4755](https://github.com/yetone/magpie/releases/tag/v0.1.4755)。`test/integration-magpie.mjs` 直接运行该源码中的 `internal/plugin/host.js`；完整测试额外运行发布二进制的 `plugin add`、`plugin options`、`plugin list` 和 `serve --web`，请求经过实际 Go Gateway 与 Bun 插件宿主。

## 2026-11-24 验证记录

| 环境 | 版本 / 标识 |
| --- | --- |
| Magpie 官方 CLI | `0.1.4755`，Linux x64 |
| Magpie 源码 | `0f08ca6cf6563bc468d883fcda85ed75c242ea42`，tag `v0.1.4755` |
| CLI SHA-256 | `8185f1971196fd6bf2618b5c2cb0faa25fcc3ba64906cf6d893717d577e306c6` |
| Bun | `1.4.4` |
| Node.js | `24.22.3` |
| 最终结果 | 仓库根安装入口运行 3 组通过，0 失败，0 跳过；约 4.48 秒 |

| 组别 | 验证内容 | 推理 POST 数 |
| --- | --- | ---: |
| 官方 Bun 宿主与账户 | 原生 API 登录、0600 凭据文件、独立 CLI 安装阶段检测、动态模型、余额、未知余额保留为空、三个协议各自的文本与工具流、两个账户的端点与 Key 隔离 | 7 |
| 错误与取消 | HTTP 402 原样返回、HTTP 重定向拒绝且不转发凭据、客户端取消关闭真实上游连接 | 3 |
| 官方 Go Gateway 与 Web | 本地插件安装、Docker 实际端口设置播种且保留已有采购规则与自定义端口、恢复宿主保存的账户、HTTP 模型发现、三个协议各自的文本与工具流、取消关闭真实上游连接、402 单次派发、采购页面及 JS/CSS/SVG/bridge 文件、真实 options 接口不包含凭据 | 8 |

共 18 次推理 POST，目标均为测试进程创建的本地 HTTP fixture。每个上述测试请求都检查只派发一次。三个文本协议为 Chat Completions、Responses 和 Anthropic Messages；保留并检查各自原生 SSE/tool-call 事件。

请求同时包含冲突的 `service` 字段，官方宿主与完整 Go 链路均验证转发时该字段已删除，无法覆盖插件核验的 `model`。根入口通过 `MAGPIE_PLUGIN_PATH` 指向整个仓库，覆盖 `package.json` 的 `main`、`exports` 与页面路径映射。

## 隔离方式

测试将官方 CLI 复制进独立临时目录，使用 Magpie 官方 `.portable` 模式，使配置、插件账户与缓存归属该目录。所有 Magpie 子进程显式设置官方 `DO_NOT_TRACK=1` 和 `MAGPIE_NO_STATS=1`，关闭遥测。

Magpie 的 `MAGPIE_NO_ACCOUNTS=1` 也会隐藏有凭据的 Provider 插件。因此完整 Gateway 测试用 Linux `bubblewrap` 创建挂载与进程命名空间，遮蔽用户目录、移除其他 Agent 的路径覆盖变量，并限制可发现的工具路径；`HOME` 的值保持不变。临时实例关闭后清理测试文件。

## 本次验证修正的宿主兼容问题

- 采购页面使用 classic defer 脚本。Magpie 的沙盒页面具有 opaque origin，模块脚本需要额外 CORS 许可，而官方页面服务只内联 classic 脚本。当前构建产物可由官方 Web 服务内联，并经过真实文件路由检查。
- 冷安装需使用 Magpie 的 `auth.cli` 安装阶段：官方 `pluginBegin` 给 `authorize` 一分钟预算，独立安装阶段给十分钟。依赖安装应在安装阶段完成，再进入钱包/控制台授权流程。

## 宿主重试行为

插件自己的 `fetch` 对一次调用只发送一次推理 POST。Magpie 外层 Gateway 有独立的错误重试与等待逻辑：在本次官方版本中，503 fixture 触发了超过十秒的等待，随后由测试客户端取消。

Magpie 的 `errors=pass` 目前只支持普通 API Key Provider，不支持 Provider 插件；实际 CLI 对 `magpie provider set antseed errors=pass` 返回拒绝。因此，上表的成功、取消和 402 单次请求结果不能外推为所有故障下的整条链路单次保证。调用方或宿主发起新一轮请求时，插件会按当时的卖家报价与冷却状态重新选择；真实支出应以 Antseed 请求账本为准。此限制来自 [Magpie pass_errors.go](https://github.com/yetone/magpie/blob/v0.1.4755/internal/provider/pass_errors.go) 与 [Gateway retry logic](https://github.com/yetone/magpie/blob/v0.1.4755/internal/gateway/fallback.go)。

以上覆盖官方宿主、HTTP API、页面文件与桥接接口；浏览器视觉与交互测试需单独执行。真实 Antseed P2P 网络、钱包初始化和模型可用性使用另一套运行时检查记录。
