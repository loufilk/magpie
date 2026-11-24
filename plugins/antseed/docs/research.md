# Antseed × Magpie：接口核实与实现选择

核实日期：2026-11-24。本文依据官方文档、GitHub 源码、npm 锁定依赖和实际运行结果。

## 结论

Magpie 可以通过 Provider 插件调用 Antseed 模型。本插件使用独立 Node 子进程运行官方 Antseed Gateway，Magpie 的 Bun 宿主承担认证、模型映射、采购规则和请求转发。原生 P2P、钱包、微支付与充值流程由官方组件提供。

首次安装需要 Node.js 与 npm。插件自动安装自己的 Antseed 运行时，用户不需要全局 CLI 或桌面客户端。真实模型可用性取决于 Buyer 能发现供应商，并满足供应商的价格、信任与余额条件。

## 查阅范围

| 来源 | 核实内容 |
| --- | --- |
| [Magpie 插件开发文档](https://usemagpie.ai/docs/plugins) | Provider、认证方法、CLI 安装阶段、自定义 fetch、动态模型、usage、页面桥接 |
| [Magpie v0.1.4755 源码](https://github.com/yetone/magpie/tree/0f08ca6cf6563bc468d883fcda85ed75c242ea42) | 实际 Bun host、Go 登录时限、插件账户、页面 sandbox 与资产内联 |
| [Magpie 社区插件](https://github.com/magpie-community/plugins) | 包结构与现有插件实现；没有把 Antseed 当作已经发布的官方社区插件 |
| [Antseed 源码快照](https://github.com/Antseed/antseed/tree/739cd7f3f2c43fb2419bdb1e0e3d9175b45cb5d6) | CLI、Buyer、Gateway、价格结构、Key policy、preset、钱包与进程生命周期 |
| [Gateway API](https://antseed.com/docs/gateway/api/) | 模型、三种文本协议、Key 用量与余额 |
| [Routing 与 presets](https://antseed.com/docs/gateway/routing/) | 各层策略只能收紧，固定供应商同样遵守限价 |
| [Management API](https://antseed.com/docs/gateway/management-api/) | 创建和读取 preset、工作区与管理认证 |
| [Funding](https://antseed.com/docs/gateway/funding/) | 官方银行卡入口、Base USDC、工作区钱包与账单 |
| [官方 pi-antseed](https://github.com/Antseed/pi-antseed) | 连接已经存在的 Gateway / Buyer 的参考适配方式 |
| [第三方 magpie-plugin-antseed](https://github.com/yezhe18/magpie-plugin-antseed) | 已有 HTTP 薄适配原型；不包含本插件的运行时管理、钱包初始化、采购页面和强制限价流程 |

用于实现的固定 npm 版本为 `@antseed/cli@0.1.259`、`@antseed/router-local@0.1.54`、`@antseed/antseed-verifier@0.1.10`。完整依赖解析和完整性值在 `runtime/package-lock.json`。

## 对初步方案的具体修正

### 1. 自动安装需要适配 Magpie 的安装机制

Magpie 的插件安装默认跳过 npm lifecycle scripts；Antseed 有 `better-sqlite3`、`node-datachannel` 等原生依赖。只在插件的 dependencies 里声明 Antseed 包，不能完成可靠的原生安装。

本实现把官方依赖放进单独的 Node 运行时，通过固定锁文件执行 `npm ci`。首次依赖安装接入 Magpie 的 `auth.cli` 安装阶段，因为普通 `authorize` 的一分钟时间预算不足以覆盖冷安装。查看 [pluginsignin.go](https://github.com/yetone/magpie/blob/0f08ca6cf6563bc468d883fcda85ed75c242ea42/internal/provider/pluginsignin.go)。

### 2. 钱包与充值使用自己运行的官方 Console

Gateway Console 是本地或服务器上运行的 Antseed 管理界面。插件生成官方控制台入口，首次初始化优先使用一次性 setup link；钱包私钥留在官方私有数据目录。

银行卡入口由 Crossmint 提供，官方列出 Apple Pay 和 Google Pay，具体可用方式取决于地区和结账页面。Base USDC 的地址与二维码、充值确认和工作区账单也由官方 Console 展示。本插件打开该流程，充值金额和付款由用户确认。

### 3. 目录参考价与实际报价分别使用

`/v1/models` 的 `reference_price` 用于相对采购倍率；供应商价格来自 `peers[]`。它们都不替代请求账本的实际支出。

固定供应商 ID 为 `<peerId>@<serviceId>`。同一 peer 和 service 如果对应多个不可单独寻址的 provider，插件要求所有候选报价都符合限制。自动模型入口没有固定执行价，因此不展示目录最低价作为确定费用。

官方字段实现可见 [network-models.ts](https://github.com/Antseed/antseed/blob/739cd7f3f2c43fb2419bdb1e0e3d9175b45cb5d6/apps/cli/src/proxy/network-models.ts)。

### 4. 免费额度与零单价是两种条件

`freeTier` 可以附在收费模型上。本插件只有在输入、输出、缓存读取价格明确为零，且不存在额外收费组件时，才按零价供应商处理。托管模式的 `freeOnly` 还会把官方 Buyer 和 Key 的三类 token 上限设置为零。

### 5. 单模型上限必须落到执行策略

当前官方 `HierarchicalPricingConfig` 只保留默认价格层，旧的 provider/service 配置层不能作为逐模型限价实现。相关定义和加载逻辑见 [types.ts](https://github.com/Antseed/antseed/blob/739cd7f3f2c43fb2419bdb1e0e3d9175b45cb5d6/apps/cli/src/config/types.ts) 与 [loader.ts](https://github.com/Antseed/antseed/blob/739cd7f3f2c43fb2419bdb1e0e3d9175b45cb5d6/apps/cli/src/config/loader.ts)。

托管模式先在插件端筛选报价，再创建带有供应商和价格限制的官方 preset，以 `@preset/magpie-…` 提交。preset 的 `systemPrompt` 为 `null`、`params` 为空，同一请求仍归属原 API Key 账本。每次使用前核对已有 preset，防止控制台修改后的配置继续执行。

外部 Gateway 和裸 Buyer 只授予普通推理权限时，插件只能实施派发前筛选和固定供应商；执行端上限应由该 Gateway 管理员设置。

### 6. 故障切换按下一次请求执行

插件每个调用只提交一次推理 POST，保持错误和响应流。故障供应商进入冷却，后续自动选商请求可选择其他合格供应商。这避免把已经开始计费或输出的调用自动再发一次。Magpie 自身的账号路由仍由其配置决定。

### 7. 账本支出与链上结算分别显示

Magpie 卡片显示 `/v1/key` 返回的可用余额、预算和 Key 已记账支出；未知余额保留未知状态。请求确认、支付 channel 和链上结算状态在官方 Console 查看。没有把公告价乘 token 估算成“真实已结算 USDC”。

### 8. 页面与 Docker 按实际宿主行为适配

采购页使用 Magpie options bridge，页面不接触 API Key 或钱包私钥。脚本预打包为 classic script，以兼容 opaque-origin sandbox 和官方 Web 资产内联路径。

Docker 采用官方 `ghcr.io/yetone/magpie:0.1.4755`，固定镜像 digest，并在构建时安装原生依赖。官方镜像已包含 Node/npm。不能设置 `MAGPIE_NO_ACCOUNTS=1`，因为该变量也会隐藏需要凭据的 Provider 插件。

## 验证与交付状态

官方 Magpie 的 Bun host 与完整 Go Gateway 已通过本地 fixture 的三协议流式调用测试，官方 Antseed 的本地启动、钱包、Key、余额解析和 preset 执行配置均已验证。

本次执行环境中，真实 Antseed Buyer 的 `peers` 和 `dhtNodes` 均为 0，真实调用返回 HTTP 502，未取得模型回答。完整结果见 [verification.md](verification.md)；宿主验证复现见 [INTEGRATION.md](INTEGRATION.md)。
