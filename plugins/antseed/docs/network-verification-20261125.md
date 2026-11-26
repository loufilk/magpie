# Antseed 公网网络验收补充记录

初始记录：2026-11-25；更新：2026-11-26。基线：插件 0.1.0，CLI 0.1.259，Router Local 0.1.54；沿用 [初始验证记录](verification.md)。

## 2026-11-26 Core 验收

来源：用户在本轮反馈的 Core 隔离实例实测结果。验收分支为 `feat/antseed-provider-plugin-20261124`，提交 `fa125ed`，宿主为 Magpie `v0.1.4801`。

| 验收项 | 结果 |
| --- | --- |
| 安装与启动 | GitHub 安装、Docker 构建与启动、采购设置页通过 |
| Magpie 集成 | 原有 57 项自动测试、3 组宿主集成测试通过，覆盖 Chat Completions、Responses、Anthropic Messages 的流式响应与工具调用 |
| 真实网络 | 隔离 Buyer 发现 99 个 DHT 节点、105 个 peer |
| 本地目录 | Buyer 返回 17 个文本模型；隔离 Magpie 读到 24 条 Antseed 路由 |
| 免费推理 | 经隔离 Antseed Gateway 固定请求 Open Forge 的 Llama 3.1 8B，返回 HTTP 200 和 `OK` |
| 免费请求账本 | 1 次请求，支出 0，充值 0 |
| 报价分类 | 采样时有 19 条零报价线路，其中 5 条要求质押；严格低于参考价 0.05 倍的非零价线路为 0 条 |
| 实例清理 | 本轮隔离测试实例已关闭 |

Provider 主链路、真实发现及上述免费模型请求已通过这轮验收。报价分类记录的是采样时的本地公告，免费推理成功记录对应 Open Forge 的 Llama 3.1 8B；付费推理待验。

## 2026-11-26 诊断字段修复

Buyer 的实际状态字段为 `dhtNodeCount` 和 `peerCount`。旧脚本只读取 `dhtNodes` 和 `peers`，因此上述 99/105 响应会输出两个 `null`，将 `discoveryObserved` 判为 `false` 并退出 `2`。

修复后的 [诊断脚本](../bin/antseed-network-diagnose.mjs) 对每项计数优先读取新字段，仅在新字段缺失或为 `null` 时回退到旧字段。JSONL 输出继续保留原键，采样输出与最终退出状态使用同一组归一化计数。

| JSONL 输出键 | 优先读取 | 兼容读取 |
| --- | --- | --- |
| `dhtNodes` | `dhtNodeCount` | `dhtNodes` |
| `peers` | `peerCount` | `peers` |

计数必须为非负安全整数；两项都大于零时 `discoveryObserved=true`、退出 `0`。新字段为 `0` 时保留零值，不采用旧字段中的正数；无效值按未知处理，退出 `2`。新旧字段可以分别兼容。

[回归 fixture](../test/fixtures/core-buyer-status-20261126.json) 保留用户反馈的实测状态响应中的两项计数字段：

```json
{
  "dhtNodeCount": 99,
  "peerCount": 105
}
```

修复后，该用例输出 `dhtNodes=99`、`peers=105`，发现成功且退出 `0`。回归同时检查旧字段兼容、新字段优先、零值及缺失/无效计数。

### 本次修复验证

执行环境：Linux、Node `24.22.3`。[CLI 回归](../test/network-diagnose.test.mjs) 使用模拟的 DNS、UDP、Docker 和 HTTP 响应，检验脚本的 JSONL 输出与进程退出码；Core 实网结果采用上节记录。`--self-test` 单独运行真实本机 UDP loopback。

| 验证 | 结果 |
| --- | --- |
| 将旧 `fa125ed` 脚本用于新增 8 项回归 | 3 项通过、5 项失败；Core 99/105 用例及 stdin 用例均复现错误退出 `2` |
| 修复后定向回归 | 8 / 8 通过，包含文件执行及 Docker 手册使用的 stdin 执行方式 |
| `npm test` | 65 / 65 通过，0 跳过，约 6.99 秒；原有 57 项加新增 8 项 |
| `npm run check` | 26 个 JavaScript 文件、单一 Provider 导出与锁文件检查通过 |
| `--self-test` | 4 / 4 通过，包含真实本机 UDP loopback |
| `--help` | 正常打印帮助并退出 |

在 `plugins/antseed` 目录复现修复验证：

```sh
node --test test/network-diagnose.test.mjs
npm test
npm run check
node bin/antseed-network-diagnose.mjs --self-test
node bin/antseed-network-diagnose.mjs --help
```

## 2026-11-25 环境检查记录

当日新增诊断脚本及此记录，未修改 Provider、锁文件、钱包、部署、限价或信任配置。以下为 11 月 25 日执行环境的结果：

- GitHub 分支回读：确认现有 Compose 为 Linux host networking，HTTP listener 仍绑定 loopback。
- Linux x64 / Node 22.16.0：脚本语法检查和四项自检通过（BEP5 bencode、非法尾部、get_peers 编码、UDP/KRPC loopback）。
- 本地 UDP socket 可用；真实 loopback KRPC 收到回包，约 2 ms。
- 两个官方 bootstrap、三个备用 router 及 antscan.co 均 DNS EAI_AGAIN；未到达公网 UDP 探测阶段。
- 当前环境没有 Docker、Antseed CLI、运行中的 Buyer；本地 8377 返回 ECONNREFUSED。远程执行通道离线。
- 脚本退出码 2，discoveryObserved=false。真实模型请求 0 次，充值/支付请求 0 次。未证明昨日故障的根因与本次 DNS 障碍相同。
- GitHub 脚本 blob 8ddf50ea824dc66591ca9af3f6ad96f0f434eabe 与本地实测文件一致。

## 一键诊断（运行在实际 Buyer 的网络命名空间）

进入仓库的 plugins/antseed 目录，使用现有已启动的托管 profile：

~~~bash
set -o pipefail
node bin/antseed-network-diagnose.mjs --self-test
node bin/antseed-network-diagnose.mjs --profile default --seconds 330 \
  | tee antseed-network-diagnostic.jsonl
~~~

也可以用 --data-root、--config、--buyer-port 显式指定非默认目录或裸 Buyer。默认从 runtime.json/settings.json 推断 Buyer 端口。建议持续观察一个完整刷新周期。诊断脚本只 GET 本机 status/peers/models 和公共缓存接口，使用 UDP KRPC ping/get_peers 检测 bootstrap；不启动 Buyer、不读出私钥/API key、不更改配置、不派发推理。

在已运行的现有 Docker 容器内执行新脚本（不需要重建/重启，保留现有 catalog 模块）：

~~~bash
# 在 plugins/antseed 目录执行：
docker inspect --format '{{.HostConfig.NetworkMode}}' magpie-antseed
docker exec -i -w /opt/magpie-antseed/bin magpie-antseed \
  node --input-type=module - --profile default --seconds 330 \
  < bin/antseed-network-diagnose.mjs
~~~

脚本输出 JSONL。exit 0 表示最后一次采样的 DHT 节点及 peer 计数均为有效正整数；2 表示发现验收未通过；1 表示脚本异常。真实推理通过单独的固定模型请求验收。catalog 输出复用 lib/catalog.mjs 的价格和同 peer/service 多 provider 筛选逻辑；缺少参考价不列入 below005；0.05 本身不列入严格低于 0.05 的名单。free 列出公告零价线路，包括要求质押的候选，stakersOnly 字段单独标记。没有真实目录时不会生成虚构线路。

## 分阶段判断

| 观察 | 下一步 |
| --- | --- |
| UDP loopback 失败 | 检查 sandbox/socket/容器权限 |
| DNS 失败 | 在同一命名空间检查 resolv.conf、系统解析器、网络策略 |
| DNS 正常，KRPC 超时 | 检查出站 UDP 6881、状态防火墙/NAT 回包；超时不能单独证明端口封禁 |
| 官方 bootstrap 不响应 | 检查备用 router 的 KRPC；固定版本源码已有 fallback，不重复实现 |
| KRPC 回包但诊断输出 dhtNodes=0 | 检查实际 network.noOfficialBootstrap、bootstrapNodes、bindHost、dhtPort、Buyer 日志及运行版本 |
| 诊断输出 dhtNodes>0、peers=0 | 检查 Antseed topic 查找和供应商 TCP /metadata、签名/版本、metadataFetchTimeoutMs；不能把 get_peers 的路由节点当卖家 |
| 诊断输出 peers>0、模型为空 | 检查模型元数据、协议、健康状态、策略过滤与 Base RPC；信任 60/0 对比只在隔离配置进行 |
| 免费报价存在、推理失败 | 区分 staking-only、限额、429、连接/模型错误；不能把 paid/free allowance 当零单价 |

注意：脚本本身的 raw KRPC probe 独立于 Buyer config。KRPC reply 是网络可达证据，不等于完成 DHT 多跳遍历或签名验证。Docker bridge 不是必然不可用；先比较 host 和实际容器网络，再检查 DNS、UDP NAT、TCP metadata/signaling 和 WebRTC/ICE。不要盲目对公网开放本地 Gateway、Buyer、Magpie 管理端口。

## 隔离 Buyer 的免费验收流程

使用当前插件安装的固定版 CLI 创建一次性的独立 HOME、data-dir、config 和不同的 loopback 端口，以新身份进行免费验收。禁止继承 ANTSEED_IDENTITY_HEX、ANTSEED_CONFIG、NODE_OPTIONS 等外部配置；autoSweep=false；不禁用正常结算协议，不执行 deposit/sweep/stake/topup。以下手册写于 11 月 25 日；11 月 26 日 Core 的结果见上表。

~~~bash
umask 077
RUNTIME_DIR="$MAGPIE_ANTSEED_RUNTIME_DIR"
# 如未设置，指定实际私有 runtime-0.1.259 的绝对路径。
test -n "$RUNTIME_DIR" || { echo "请先指定 RUNTIME_DIR"; exit 1; }
CLI="$RUNTIME_DIR/node_modules/@antseed/cli/dist/cli/index.js"
test -f "$CLI" || exit 1
D="$(mktemp -d)"
mkdir -m 700 "$D/home" "$D/state"
cat > "$D/config.json" <<'JSON'
{
  "buyer": {
    "proxyPort": 28377,
    "autoSweep": false,
    "minPeerReputation": 0,
    "metadataFetchTimeoutMs": 5000,
    "maxPricing": {"defaults": {"inputUsdPerMillion":0,"outputUsdPerMillion":0,"cachedInputUsdPerMillion":0}},
    "routingPreferences": {"preferFreePeers":true,"maxInputUsdPerMillion":0,"minTrustScore":60}
  },
  "network": {"bootstrapNodes":[],"noOfficialBootstrap":false}
}
JSON
printf 'Diagnostic directory: %s\n' "$D"
env -i HOME="$D/home" PATH="$PATH" DO_NOT_TRACK=1 \
  ANTSEED_TELEMETRY=0 ANTSEED_SKIP_PLUGIN_UPDATE_CHECK=1 \
  MAGPIE_ANTSEED_PLUGIN_DIR="$RUNTIME_DIR" \
  ANTSEED_CONFIG="$D/config.json" ANTSEED_DATA_DIR="$D/state" \
  node "$CLI" --data-dir "$D/state" --config "$D/config.json" \
  buyer start --port 28377
~~~

另一个终端使用同一个 D 路径：

~~~bash
set -o pipefail
node bin/antseed-network-diagnose.mjs --config "$D/config.json" \
  --buyer-port 28377 --seconds 330 | tee "$D/diagnostic.jsonl"
curl --noproxy '*' -fsS 'http://127.0.0.1:28377/v1/models?type=text' > "$D/models.json"
~~~

若发现成功但默认信任门槛使路由空，再停止隔离 Buyer，修改该临时 config 的 minTrustScore 为 0，重启同一钱包，只对比发现和目录。不要降低生产门槛。测试完毕后停止隔离 Buyer；不删除用户真实数据。

**只有同时满足以下条件才执行一次真实免费文本请求：**

- 确认隔离进程确实使用新身份、无存款、无外部身份、autoSweep=false，运行配置三类硬上限均为数值 0。
- 当前本地目录存在明确零价且健康的 text/chat 候选；同 peer@service 的全部 provider 报价均满足限制；排除 stakersOnly、单位计费、决策/router 服务及价格未知者。不能从公共缓存直接选择并调用。
- 记录测试前账本；固定完整 peerId@serviceId（不是自动模型名），用非流式、max_tokens=16、固定无敏感信息提示词发一次 POST，关闭 HTTP 客户端重试。核对返回的 peer id、实际协议、价格/成本 header 和测试后账本；失败不自动换号或换付费线路。
- 任何前置条件不满足或无法读取账本时，保持零 POST，验收不通过。

低于 0.05 的非零价线路只读取报价。倍率采用 max(输入价/参考输入价, 输出价/参考输出价, 缓存价/参考缓存价)，与现有插件的逐项采购上限一致；缺少参考价不猜测。

## 官方资料与 2026-11-25 公共候选

- [固定版本 Bootstrap 源码](https://github.com/Antseed/antseed/blob/739cd7f3f2c43fb2419bdb1e0e3d9175b45cb5d6/packages/node/src/discovery/bootstrap.ts)
- [Discovery](https://antseed.com/docs/discovery/)、[Buyer configuration](https://antseed.com/docs/buyer-config/)、[Routing and catalog](https://antseed.com/docs/api/routing/)、[Local buyer diagnostics](https://antseed.com/docs/api/)
- [Antscan 公共缓存 API](https://antscan.co/api/marketplace?limit=5000) 与 [AntSeedStats 免费目录](https://antseedstats.com/network?free=1) 只作为外部线索，不替代本机发现。
- 当日搜索索引显示外部 DHT 爬虫有 88 个 peers、2766 个服务报价、189 个免费报价；这些数字随时间变化。Open Forge（DeepSeek V4.1 Flash）、Super Seeder（GPT OSS 120B）、Inspectant（DeepSeek V4.1 Flash Free）是候选，尚无本机直连测试。

11 月 25 日阶段状态：诊断工具已交付，本地测试通过；当日环境未完成公网 DHT、真实免费模型、Docker 实机及真实报价分类验收。11 月 26 日 Core 实测已补充上述结果。
