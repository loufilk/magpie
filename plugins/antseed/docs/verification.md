# 验证记录

日期：2026-11-24。插件版本：`opencode-antseed-auth@0.1.0`。

## 结果

**插件逻辑、官方 Magpie 宿主及 HTTP Gateway、官方 Antseed 本地运行时均已通过相应验证。真实 P2P 模型请求未取得回答：本次环境发现 0 个 DHT 节点、0 个供应商。**

| 项目 | 结果 | 证据范围 |
| --- | --- | --- |
| 语法、单一导出、页面 bundle、锁文件检查 | 通过 | `npm run check` |
| 自动测试 | 57 / 57 通过，0 跳过 | `npm test`，约 6.52 秒 |
| 官方 Bun 宿主 + Go Gateway | 3 组通过，18 次本地 fixture 推理 POST | 登录、模型、三协议文本/工具流、账户隔离、错误、取消与 Web 页面 |
| GitHub 仓库根安装入口 | 通过 | root `package.json` 指向 `plugins/antseed`，由真实 Magpie 安装加载 |
| Docker 端口初始化脚本 | 通过真实 CLI 检查 | 首次补默认端口，重复启动保留用户端口、单价与模型规则 |
| 页面交互 | 通过 DOM 检查 | bridge 读写、零上限、倍率、增删规则、语言与主题切换 |
| 全新 Antseed 依赖安装 | 通过 | 固定锁文件 `npm ci`，原生模块实际加载 |
| 官方 Gateway / Buyer 本地启动 | 通过 | 钱包、Key、管理认证、健康接口、模型目录接口、受控关闭 |
| 官方单模型 preset | 通过 | 真实管理 API 创建并重新读取一致的限制策略 |
| 官方 Key 余额与支出解析 | 通过 | 真实 `/v1/key` 数据；未知余额未显示成零 |
| 真实 Antseed 模型回答 | 未取得 | HTTP 502，网络发现为 0 节点 |
| Docker 镜像完整构建 | 未执行 | 当前环境没有 Docker；基础镜像标签/digest 已核实 |
| Chromium 视觉检查 | 未完成 | 环境拒绝 Chromium 所需 socket；提权请求被自动审批拒绝 |

## 环境与固定版本

| 组件 | 版本 / 标识 |
| --- | --- |
| 执行平台 | Linux x64 |
| Node.js | `24.22.3`，ABI `137` |
| Bun | `1.4.4` |
| Magpie | 官方 `v0.1.4755` |
| Magpie 源码 commit | `0f08ca6cf6563bc468d883fcda85ed75c242ea42` |
| Magpie 二进制 SHA-256 | `8185f1971196fd6bf2618b5c2cb0faa25fcc3ba64906cf6d893717d577e306c6` |
| Antseed 研究源码 commit | `739cd7f3f2c43fb2419bdb1e0e3d9175b45cb5d6` |
| Antseed CLI | `0.1.259` |
| Antseed router-local | `0.1.54` |
| Antseed verifier | `0.1.10` |
| Magpie Docker image digest | `sha256:da0c9c12e8d13cf6d629801a3165ebd6d718a1ffe429d56fac080890e8c89e96` |

原生模块验证包含 `better-sqlite3` 和 `node-datachannel`。依赖完整树记录在 `runtime/package-lock.json`，包内必须保留该文件。

## 自动测试覆盖

- 供应商实际字段映射、协议与能力、三类价格、免费识别、参考价倍率、同 peer 多 provider、白黑名单与健康状态。
- URL 作用域、HTTPS 规则、凭据和内部路由 header 清理、禁止重定向、取消传播、账户目录缓存隔离。
- 三协议流式透传、工具调用、原始错误；每次插件 fetch 只有一个推理 POST。
- 托管 preset 创建/核验失败时停止派发，且请求中的 `service` 不能绕过最终 `model` 或 preset。
- 官方安装阶段只安装运行时；外部 Gateway 登录不安装本地组件；首次控制台优先使用 setup link。
- 钱包和 Key 复用、目录权限、受保护控制通道、并发启动、独立取消、异常退出与重复 Buyer 防护。
- 配置更新保留官方控制台设置的 RPC；免费模式三种 token 价格上限均为零。
- 页面空值与零值区分、逐模型规则验证、无效 peer 拒绝、保存未知选项。

## 官方 Magpie 集成

完整方法和可复现命令见 [INTEGRATION.md](INTEGRATION.md)。测试运行真实官方 Bun host 和发布版 Go Gateway，上游模型响应由隔离测试服务器提供。

18 次推理 POST 包括三个协议各自的文本和工具流、第二账号、错误和取消场景。成功请求与明确测试的错误场景检查实际派发次数，另检查冲突 `service` 字段不能改变上游模型。Web 测试读取真实采购页、JS/CSS/SVG、bridge 与 options API。

**插件一次 fetch 与 Magpie 一个客户端请求是两个边界。** 插件自身不重发；Magpie 的错误重试、账号路由和断流续接可再次调用插件。官方 `errors=pass` 不支持 Provider 插件。额外的默认宿主 503 诊断中，请求在 10 秒后仍等待，测试主动取消；不能把插件的错误原样返回描述成整个 Magpie 链路立即返回或绝不重试。

## 官方 Antseed 运行时

在全新私有目录使用固定锁文件安装，成功执行官方 CLI 创建 Key、管理 token 和策略，随后启动 Gateway / Buyer。以下接口已取得有效响应：

- `/healthz`
- `/v1/models`
- `/v1/key`
- `/console/api/status`
- `/console/api/presets` 的创建和查询

单模型规则生成的 preset 已用真实管理接口创建，再读取并比较其模型、工作区、供应商限制、价格限制及空提示词/参数。新版 ready marker 也已用实际 Node 和原生模块验证。

### 真实 P2P 请求

官方 Buyer 状态：

```json
{
  "reachable": true,
  "peers": 0,
  "dhtNodes": 0
}
```

降低测试 profile 的信任门槛后，普通发现等待 25 秒、免费发现等待 30 秒，目录仍为空。输入、输出和缓存上限全部为零的免费测试请求返回：

```text
HTTP 502
No sellers available on the network. Is a seeder running?
```

实际 Key 账本：

```json
{
  "requests": 2,
  "spent_usd": "0.000000",
  "topped_up_usd": "0.000000",
  "input_tokens": 0,
  "cached_input_tokens": 0,
  "output_tokens": 0
}
```

余额字段为 `null`，按未知状态处理。没有充值或付费模型支出；全部测试 Gateway 已停止。

这些结果表明本次环境未完成 DHT 发现，尚不能判断任一真实卖家在正常联网机器上的回答质量。部署后先在官方 Console 检查 Buyer 与供应商状态，再按实际模型列表进行调用。官方 bootstrap 为 `dht1.antseed.com:6881` 和 `dht2.antseed.com:6881`。

## 界面与平台

采购页面的 classic bundle、真实宿主资源加载和 DOM 行为已通过。`test/page-ui.mjs` 保留 Chromium 的桌面/手机、明暗主题、语言与横向溢出检查；当前环境启动 Chromium 时发生 socket 权限错误，自动审批拒绝了提权执行，因此没有生成通过的截图记录。

Docker 配置的镜像标签、实际选项播种、系统 Python 路径与持久化目录已核对。完整镜像构建，以及 Windows/macOS 的原生依赖安装，需要在对应环境执行。

## 复现命令

在源码的 `plugins/antseed` 目录运行：

```sh
npm run build
npm run check
npm test

MAGPIE_HOST_PATH=/path/to/official-magpie/internal/plugin/host.js \
MAGPIE_BUN=/path/to/bun \
MAGPIE_BINARY_PATH=/path/to/official-magpie-binary \
npm run test:magpie
```

可选的 DOM / 浏览器检查需要单独安装对应测试工具：

```sh
JSDOM_MODULE=/absolute/path/to/node_modules/jsdom node test/page-dom.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright node test/page-ui.mjs
```

`MAGPIE_PLUGIN_PATH=/path/to/repository-root` 可验证根安装入口。所有自动推理 fixture 均在本机，不使用真实钱包余额。
