# Antseed 公网网络验收补充记录（2026-11-25）

基线：插件 0.1.0，CLI 0.1.259，Router Local 0.1.54；沿用 [昨日验证记录](verification.md)。本次仅新增诊断脚本及此记录，未修改生产代码、锁文件、钱包、部署、限价或信任配置。

## 已执行

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

脚本输出 JSONL。exit 0 表示在最后一次采样观察到 DHT 节点及供应商均大于零；2 表示发现验收未通过；1 表示脚本异常。exit 0 仅对应网络发现，不代表推理可用。catalog 输出复用 lib/catalog.mjs 的价格和同 peer/service 多 provider 筛选逻辑；缺少参考价不列入 below005；0.05 本身不列入严格低于 0.05 的名单。free 列出公告零价线路，包括可能要求质押的候选，stakersOnly 字段单独标记。没有真实目录时不会生成虚构线路。当前环境未执行真实目录分类验收。

## 分阶段判断

| 观察 | 下一步 |
| --- | --- |
| UDP loopback 失败 | 检查 sandbox/socket/容器权限 |
| DNS 失败 | 在同一命名空间检查 resolv.conf、系统解析器、网络策略 |
| DNS 正常，KRPC 超时 | 检查出站 UDP 6881、状态防火墙/NAT 回包；超时不能单独证明端口封禁 |
| 官方 bootstrap 不响应 | 检查备用 router 的 KRPC；固定版本源码已有 fallback，不重复实现 |
| KRPC 回包但 Buyer dhtNodes=0 | 检查实际 network.noOfficialBootstrap、bootstrapNodes、bindHost、dhtPort、Buyer 日志及运行版本 |
| dhtNodes>0、peers=0 | 检查 Antseed topic 查找和供应商 TCP /metadata、签名/版本、metadataFetchTimeoutMs；不能把 get_peers 的路由节点当卖家 |
| peers>0、模型为空 | 检查模型元数据、协议、健康状态、策略过滤与 Base RPC；信任 60/0 对比只在隔离配置进行 |
| 免费报价存在、推理失败 | 区分 staking-only、限额、429、连接/模型错误；不能把 paid/free allowance 当零单价 |

注意：脚本本身的 raw KRPC probe 独立于 Buyer config。KRPC reply 是网络可达证据，不等于完成 DHT 多跳遍历或签名验证。Docker bridge 不是必然不可用；先比较 host 和实际容器网络，再检查 DNS、UDP NAT、TCP metadata/signaling 和 WebRTC/ICE。不要盲目对公网开放本地 Gateway、Buyer、Magpie 管理端口。

## 隔离 Buyer 的免费验收流程（待联网环境执行）

不要用已充值的生产钱包进行此测试。使用当前插件安装的固定版 CLI 创建一次性的独立 HOME、data-dir、config 和不同的 loopback 端口。禁止继承 ANTSEED_IDENTITY_HEX、ANTSEED_CONFIG、NODE_OPTIONS 等外部配置；autoSweep=false；不禁用正常结算协议，不执行 deposit/sweep/stake/topup。以下为运行手册，当前环境无 CLI，未实机执行。

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

## 官方资料与公共候选

- [固定版本 Bootstrap 源码](https://github.com/Antseed/antseed/blob/739cd7f3f2c43fb2419bdb1e0e3d9175b45cb5d6/packages/node/src/discovery/bootstrap.ts)
- [Discovery](https://antseed.com/docs/discovery/)、[Buyer configuration](https://antseed.com/docs/buyer-config/)、[Routing and catalog](https://antseed.com/docs/api/routing/)、[Local buyer diagnostics](https://antseed.com/docs/api/)
- [Antscan 公共缓存 API](https://antscan.co/api/marketplace?limit=5000) 与 [AntSeedStats 免费目录](https://antseedstats.com/network?free=1) 只作为外部线索，不替代本机发现。
- 当日搜索索引显示外部 DHT 爬虫有 88 个 peers、2766 个服务报价、189 个免费报价；这些数字随时间变化。Open Forge（DeepSeek V4.1 Flash）、Super Seeder（GPT OSS 120B）、Inspectant（DeepSeek V4.1 Flash Free）是候选，尚无本机直连测试。

验收状态：诊断工具已交付，本地测试通过；公网 DHT、真实免费模型、Docker 实机、真实报价分类未通过/未执行，当前不能宣布插件真实网络验收完成。
