# Antseed for Magpie

在 Magpie 中调用 Antseed 网络的模型。插件可以自动安装并启动独立的 Antseed Gateway，也可以连接已经运行的 Gateway 或裸 Buyer。

## 安装

需要 Magpie **0.1.4755 或更新版本**。本地托管方式需要 **Node.js 22/24 LTS 与 npm**；Antseed CLI 在插件自己的目录安装，不需要全局安装 Antseed，也不需要 Antseed 桌面客户端。

在 Magpie 的「插件 → 添加插件」中填写：

```text
github:loufilk/magpie#feat/antseed-provider-plugin-20261124
```

命令行安装：

```sh
magpie plugin add github:loufilk/magpie#feat/antseed-provider-plugin-20261124
magpie plugin login antseed
```

也可以下载源码，把 `plugins/antseed` 文件夹解压到本机后安装该目录：

```sh
magpie plugin add /absolute/path/to/plugins/antseed
```

本插件的 JavaScript 直接运行，不需要编译。安装 Antseed 原生依赖时会执行锁定依赖包的安装脚本，因此此步骤在独立 Node 运行时中完成，避开 Magpie 的 Bun 安装限制。

## 第一次使用

1. 打开「供应商 → Antseed → 登录」。
2. 选择 **初始化本地 Antseed Gateway**，配置名称保留 `default` 即可。首次安装原生依赖需要等待；随后同名配置始终复用同一钱包。
3. 打开自动弹出的 Antseed 官方控制台，完成首次所有者设置。免费模型可直接尝试；付费模型在 **Wallet & Funding** 充值后使用。
4. 刷新 Magpie 模型列表，选择 `antseed/<模型 ID>`。自动入口会在每次请求前选出符合采购规则的供应商；指定供应商入口使用 `<peerId>@<serviceId>`。
5. 打开插件的 **Antseed 采购设置**，设置免费优先、只用免费模型、最高单价、单模型倍率，以及供应商白名单或黑名单。

再次打开钱包和充值页面：在 Antseed 的登录选项选择 **打开钱包 / 充值控制台**，输入原配置名称。首次初始化之前使用此入口会提示先初始化，不会另建钱包。

### 连接已有 Gateway

选择 **连接已有 Antseed Gateway / Buyer**，类型选 Gateway，输入 API base 和该 Gateway 签发的 `antseed_…` API Key。例如：

```text
https://your-gateway.example/v1
```

地址可以包含部署子路径。远程默认使用 HTTPS；局域网明文地址需在插件选项显式设置 `allowInsecureHttp: true`。插件拒绝带用户名、密码、查询参数或片段的 base URL，也不跟随携带凭据的重定向。

已有裸 Buyer 可选 Buyer 类型并填写 `http://127.0.0.1:8377`，无需钱包私钥。此模式没有 Gateway 的 Key 余额和账单接口。

## 已实现的功能

| 功能 | 行为 |
| --- | --- |
| 管理本地 Gateway | 首次安装固定版本及锁定依赖，Node 子进程运行，配置、钱包和数据库独立保存 |
| 钱包与充值 | 使用官方 Console；银行卡、Base USDC 地址与二维码由 Antseed 提供 |
| 动态模型 | 从当前账号的 `/v1/models?type=text` 读取供应商、协议、价格和能力 |
| 三种文本协议 | OpenAI Chat、OpenAI Responses、Anthropic Messages；流、工具调用和签名字段透传 |
| 真实余额 | 从 `/v1/key` 读取可用 USDC、Key 支出和预算；未知余额不显示为零 |
| 免费优先 | 在合格报价中优先选零价供应商；付费模型的试用额度不冒充零单价 |
| 免费限定 | 托管模式同时把官方 Buyer 与 Gateway 的输入、输出、缓存价格上限设为零 |
| 全局采购限价 | 分别限制输入、输出、缓存读取的 USD/百万 tokens；托管模式写入官方执行策略 |
| 单模型采购规则 | 支持绝对单价或相对官方参考价的倍率；托管模式建立无提示词、无参数注入的官方 preset 强制执行 |
| 供应商筛选 | 白名单、黑名单、目录健康状态、故障冷却；每次派发前重新检查 |
| 自动选择 | 先选供应商再提交一次；失败供应商在后续请求中进入冷却，指定线路保留固定供应商 |
| 多钱包 | 多个托管 profile 独立身份、配置和网关；官方 Console 还支持 workspace 钱包与预算 |
| 账单 | Magpie 展示 Key 已记录支出；官方 Console 提供按模型、供应商查看请求与结算状态 |
| Docker | 提供基于官方 Magpie 镜像的 Linux Compose 配置和预装 Node 运行时依赖 |

### 价格规则怎样执行

所有价格单位为 **USD/USDC 每百万 tokens**。单模型规则和全局规则取更严格的值。`maxMultiplier: 0.05` 表示供应商输入、输出和缓存报价分别不高于目录参考零售价的 5%。缺少必要参考价时，该模型不会发起请求。

托管 Gateway 的全局限制写入 Buyer 配置与 Gateway Key policy。单模型限制通过确定性的 `@preset/magpie-…` 路由落实；preset 仍使用同一 API Key 和钱包计费，`systemPrompt` 为 `null`、`params` 为空。已有同名 preset 如果被改成其他价格或提示词，插件会停止请求。

连接外部 Gateway 或裸 Buyer 时，插件在请求前按最新目录筛选并固定供应商。外部服务在实际派发时的价格上限由其管理员在 Antseed Console 的 Routing 页面设置。

自动入口没有固定供应商，因此不会把目录最低价标成真实执行价。指定供应商入口显示其公告报价。实际支出来自 Antseed 的请求账本；账本的待确认状态和链上 channel settlement 是不同记录。

插件自身每次 fetch 只提交一个推理 POST，上游状态与响应流交给 Magpie。Magpie 外层会按自己的账号路由、错误重试和断流续接策略处理，因此一个客户端请求仍可能触发多次插件 fetch。Magpie 0.1.4755 的 `errors=pass` 不适用于 Provider 插件；需要固定一个账号测试时，可使用 Magpie 的 `X-Magpie-Account` pin，但该 pin 不关闭宿主重试。

## 选项示例

页面可以编辑常用选项。高级选项可在该插件的 options 中设置：

```json
{
  "preferFree": true,
  "freeOnly": false,
  "includeAutoRoutes": true,
  "includePinnedRoutes": true,
  "maxInputUsdPerMillion": 0.20,
  "maxOutputUsdPerMillion": 0.60,
  "maxCachedInputUsdPerMillion": 0.02,
  "allowedPeers": [],
  "blockedPeers": [],
  "models": [],
  "rules": {
    "your-model-id": { "maxMultiplier": 0.05 }
  },
  "dispatchCatalogTtlMs": 2000,
  "discoveryTimeoutMs": 15000,
  "cooldownMs": 30000
}
```

`models` 是目录中的精确模型 ID；空列表允许所有文本模型。`allowedPeers` 与 `blockedPeers` 使用 40 位十六进制 peer ID，也接受 `0x` 前缀；黑名单优先。`rules` 可以用目录模型 ID、供应商 service ID 或完整 `<peerId>@<serviceId>`。

托管 profile 可设置 `dataRoot`、`nodePath`、`gatewayPort`、`buyerPort`。首次登录后 profile 和数据位置保存在该账号的认证记录里。默认端口自动选择并持久化；明确指定端口被占用时会报错。

## Docker / Linux 服务器

本目录中提供 `Dockerfile` 和 `compose.yaml`。从 GitHub 仓库下载时，先进入 `plugins/antseed`：

```sh
export MAGPIE_WEB_KEY="your-private-random-string-at-least-16-characters"
docker compose up -d --build
docker compose logs magpie-antseed
```

配置使用 Linux host networking。Magpie Web、Magpie API、Antseed Gateway 分别绑定本机 `3430`、`3425`、`18379`；Buyer 使用本机 `18377`。用 SSH 转发在电脑上打开控制台：

```sh
ssh -L 3430:127.0.0.1:3430 -L 18379:127.0.0.1:18379 user@your-server
```

用日志里的 Magpie 登录链接进入页面，然后初始化 Antseed。官方 Antseed 控制台链接会指向 `localhost:18379`，通过上面的转发访问。API 客户端同样可转发 `3425`，或由你现有的 HTTPS 入口转发 Magpie。

`/config` 的 named volume 保存 Magpie 认证以及 `/config/antseed` 中的钱包和数据库。镜像中仅预装程序与锁定依赖。多 profile 部署时，为不同 profile 指定不同端口；默认 Docker 配置使用一个 profile。

## 数据与运行时

- Linux/macOS 默认根目录：`$XDG_DATA_HOME/magpie-antseed`，未设置时使用 `~/.local/share/magpie-antseed`。
- Windows 默认根目录：`%LOCALAPPDATA%\magpie-antseed`。
- `MAGPIE_ANTSEED_DATA_DIR` 可指定根目录，`MAGPIE_ANTSEED_NODE` 可指定 Node 路径。
- `profiles/<name>/antseed/identity.key`、Gateway 数据库与凭据属于同一个 profile。备份整个 profile；更换电脑时保留整目录。
- POSIX 下 profile 目录为 `0700`、凭据文件为 `0600`。钱包私钥由官方 Antseed 管理，不进入 Magpie 选项、模型请求或插件页面。
- 钱包使用官方默认密钥文件保护方式。充值前，在官方 Console 完成所有者设置并备份 profile。

程序版本：`@antseed/cli@0.1.259`、`@antseed/router-local@0.1.54`、`@antseed/antseed-verifier@0.1.10`；完整依赖树在 `runtime/package-lock.json`。

Antseed 0.1.259 的插件目录默认固定在用户主目录。此插件只对自己的 CLI 安装副本增加 `MAGPIE_ANTSEED_PLUGIN_DIR` 路径入口，修改前检查完整文件 SHA-256。这样路由插件和验证器也使用独立目录。原始源码不匹配就停止启动，不修改其他 Antseed 安装。

如果提示“启动中断，尚未记录子进程 PID”，先在系统进程管理器确认该 profile 的 Antseed Gateway 和 Buyer 均已退出，再删除报错列出的 `runtime.json` 并重新初始化。保留 `credentials.json` 和 `antseed` 钱包目录，原钱包与 API Key 会继续复用。

## 验证

```sh
npm run check
npm test
MAGPIE_HOST_PATH=/path/to/magpie/internal/plugin/host.js \
MAGPIE_BUN=/path/to/bun \
MAGPIE_BINARY_PATH=/path/to/magpie \
npm run test:magpie
```

完整验证记录和已确认的运行条件见 [docs/verification.md](docs/verification.md)。研究依据与初步报告中需修正的部分见 [docs/research.md](docs/research.md)。

## 上游

- [Antseed 官方源码](https://github.com/Antseed/antseed)
- [Antseed Gateway 与 API](https://antseed.com/docs/gateway/api/)
- [Antseed 充值](https://antseed.com/docs/gateway/funding/)
- [Magpie 插件开发文档](https://usemagpie.ai/docs/plugins)
- [Magpie 官方源码](https://github.com/yetone/magpie)
- [已有第三方 Antseed 薄适配原型](https://github.com/yezhe18/magpie-plugin-antseed)
