# 定制源码对齐记录 · 2026-10-29

## 02:04 UTC 固定上游与本轮结果

本轮从实际远端 `61aaa62913c4b97012bffd0a325734771c4565f4` 继续三方合并，
固定查询时官方 main 为
[`yetone/magpie@f02390544d11b023a4d9e3c70856a40d028031c2`](https://github.com/yetone/magpie/commit/f02390544d11b023a4d9e3c70856a40d028031c2)。
相对上一 pin `ea53eb12` 接入 205 commits、520 files（+34,726 / −2,657），
不继续追逐此后的 tip。唯一文本冲突在 gateway-routing 的 One try 行，
已同时保留官方慢上传重试说明和现有 native Messages / error 契约。
升级目标仍为 `dot/upstream-align-20261028`，Draft PR #1 的 base 仍是
`codex/core-running-20261028`；本文不是部署、发布或运行版本声明。

官方插件固定到
[`magpie-community/plugins@50e99c252401cd835094bf971394644a12100a81`](https://github.com/magpie-community/plugins/commit/50e99c252401cd835094bf971394644a12100a81)。
其相对 `2c308184` 的 27 commits 没有修改 Kiro：全部 17 个官方文件 tree
同为 `b02b4a580904564fbe911702666af1d487c8818f`，最后源码仍是
`ceda58008093755e31381db9fd37f0097f1b2c22` / 0.1.18。
本地定制 Kiro 全部 20 个文件与 `61aaa629` 字节相同，未以 npm 包覆盖。
本轮没有 WorkBuddy JSON 导入、旧账号未交付的缓存模拟或运行配置切换。

### 保留与必要兼容修复

独立审查没有找到可以语义去重的上游 Messages gather、原生 cache boundary
或 Chat unknown-cache 替代。原生 effort / schema / opaque blocks / usage、
调用者显式缓存选择，以及 Kiro catalog-driven effort / GPT Chat / 续期后
重验等既有定制均保留。官方新 body-room admission 位于公共请求体入口，
不会被 gather 绕过；translation marshal 优化不能替代原生字段保留。

上游 `25df3187` 为翻译路径增加了“HTTP 200 SSE 明确要求
`thinking.type` enabled”时的恢复；原生非流式 Messages gather 未经过该
分支。同一 fake plugin 的端到端请求与官方 translate 对照证明：旧合并
树只调用一次并返回 400，官方对照调用两次后成功且下次只需一次。
本轮给 gather 补上最小同义恢复，不改回有损翻译：

- 仅在明确 vendor SSE error、读至正常 EOF、请求未取消、尚无任何内容块
  或未知事件时，使用官方 `withThinkingEnabled` 重试一次并记忆要求。
- native effort、format/schema、opaque 大整数和 cache 选择仍保留；重试
  结果继续以完整 Messages JSON 返回，不退成 SSE。
- 已 enabled/adaptive、已有文字/工具/thinking/opaque 输出、另一个首错误、
  policy refusal、parser/transport 诊断与取消都不新增此重试。
- whole HTTP 200 JSON 保持旧行为；旧 sniffer 不覆盖重试的 usage/error
  metadata，旧 RequestID 在再次发送前清空。

实现及契约见 [`gathered_messages.go`](internal/gateway/gathered_messages.go)、
[`passthrough`](internal/gateway/gateway.go) 和
[provider-plugins](docs/subsystems/provider-plugins.md)。独立 red-on-old 有
4 个明确行为失败；最终修复的 27 子用例（另含 2 个顶层测试）全部通过。

另外，将 Qoder mover 最低版本从官方 host 的 0.2.46 同步到固定 plugins
已发布的 0.2.47，来源为
[`f9689178` / plugins #470](https://github.com/magpie-community/plugins/commit/f96891787552f3c68c850c68057ad21d274626c2)。
该版给每个默认模型明确声明 `attachment` / `modalities.input`，防止
text-only 模型继承另一 vendor 同名模型的图像能力。npm exact version、
tarball integrity、入口与固定源码逐字节一致已核验。用户 pin 和本地路径
保护不变；没有修改外部 plugins 仓库或安装到用户运行环境。

### 本轮新跑验证（02:41 UTC 完成）

全部使用隔离 HOME/USERPROFILE/XDG、合成账号及本地 fake vendors；Kiro
和 Qoder 单测另有未 mock 外网 fail-fast guard。没有真实账号登录、真实
vendor 或付费模型调用。Go 计数包含测试与子测试，不能与叶子数混用。

| 检查 | 通过 | 失败 / 跳过 |
| --- | ---: | --- |
| 最终 Gateway 定向，Go 1.26.8 | 365 | 0 / 0 |
| 最终 Gateway 并发/定制定向 race，Go 1.27.3 | 328 | 0 / 1 |
| Plugin host 定向，Go 1.27.3 | 18 | 0 / 0 |
| Provider 定向，Go 1.27.3（两组不重叠） | 25 | 0 / 0 |
| JSONC edit / Library 实际 hub-toggle fixture | 90 / 3 | 0 / 0 |
| usage ledger/cache knowledge | 13 | 0 / 0 |
| proc / agent source guards | 1 / 1 | 0 / 0 |
| GUI source guards | 1 | **1 / 0** |
| 未改动 vendored Kiro，Bun 1.4.3，16 files / 799 assertions | 165 | 0 / 0 |
| Qoder 0.2.47 官方 capabilities 回归 | 2 | 0 / 0 |

race 的一个 skip 是官方 `TestMarshalBodyAllocatesTwoBodies` 在 race 模式
明确跳过 sync.Pool 分配基准；它在普通 Go 1.26.8 run 已通过。最初较宽
race 因旧的全协议大请求矩阵在 instrumentation 下每项约 76 秒，由 owner
在 02:39 UTC 停止（exit 130），未算作完成或通过；最终 race 不包含这四组
大型请求边界，但保留新 body-room、marshal 行为、并发、stream admission、
原生 gather/cache/error/effort、thinking 恢复及慢上传恢复。大型请求边界
全部包含在已完成的普通 365 项中；没有改测试或调阈值来获得通过。
Qoder 的同一官方 capabilities 用例在 0.2.46 fixture 为 0 pass / 2 fail，
在固定源码为 2 pass（128 assertions），红项是缺少 text-only 声明。

最终 Go 1.26.8 `go vet -tags nogui ./...`、Linux `CGO_ENABLED=0 go build
-tags nogui -trimpath`、全仓 gofmt、108 个变更 JS/CJS/MJS 文件语法检查
通过。测试时的完整 index tree 为
`8e5381319d33abb1f0c4d9803cdb62a079a08d63`；此后仅补齐本文件的运行记录，
没有改变已测试生产代码。相对官方的 38 个定制/附加文件高置信秘密模式
扫描无发现（不是完整无秘密保证）。完整全仓套件、浏览器/桌面 E2E、
跨平台实际运行及真实账户 refresh 没有运行，不能从 syntax/build 推导通过。

### 明确保留的上游红项

`TestCoreScriptBudget`：1,531,531 bytes > 1,530,861，超 670 bytes。
在完全未修改的官方 `f0239054` worktree 新跑同名测试，得到完全相同失败；
本轮没有任何自定义 GUI asset 改动。官方已跟踪
[#4133](https://github.com/yetone/magpie/issues/4133)，02:07 UTC 评论已有
维护者接手。未抬高预算掩盖、未把该项跳过或称作通过，也未夹带 GUI 重构。
因此本轮不是“所有测试全绿”。此前 Unix socket 的 sandbox 阻塞仅为历史
记录，本轮没有再次运行该受限用例或尝试绕过。GitHub CI 以最终发布 head
的实际回读为准；本地 pass 不等于 CI pass。

---

# 以下为 2026-10-28 的历史记录，不是本轮新跑结果

## 07:07 UTC 最终截止 pin

恢复仓库写权限时，再次只读核查官方 main，固定本轮最终目标为
[`yetone/magpie@ea53eb1262ed798f93226c1ab2dc478ae990cead`](https://github.com/yetone/magpie/commit/ea53eb1262ed798f93226c1ab2dc478ae990cead)。
它比下文的 `4c1fb775` 多 10 个提交；本轮不会继续随此后的 tip 无限追赶。

先前已验证的本地候选 `83dea7d1` 已作为远端 checkpoint `92c7d854` 发布，
tree 同为 `9ccbc857f091d101c7600fd567f0befe99bd60ac`，两个父提交同为
`65da9f44` 与 `4c1fb775`；不同 SHA 来自 GitHub 对象 API 的作者/时间及
checkpoint 提交说明，而不是源码差异。
本次继续从真实远端 checkpoint 三方合并，保持升级分支非强制快进。

新增官方内容主要是免脱敏路由的按需处理、Codex page-state 元数据与原生
模型列表、中文脱敏词修正、Windows modal/内部滚动行为，以及 moejs 改为
`github.com/MoeForge/moejs v0.1.0-alpha.11`。许可声明随官方一并保留。
这些提交没有改动 native Messages gather/cache、Chat unknown-cache、前轮
错误收集修正或内置 Kiro。同步修正 routing 文档仍称 Messages 一律翻译的
旧描述，链接到现存定制的 owning contract，而非增加一条实现。

独立 Astra 审查已确认脱敏新路由与定制交界未见阻断：plugin account 不会
被当作本地免脱敏 provider。之后独立 reviewer 受模型容量限制无法完成余下
核查，同模型重试仍失败，未换模型；剩余 Codex/依赖交界由实现 owner 核查
并执行定向测试，不把此段说成完整独立终审。

### 最终 pin 的新增验证

| 检查（Go 含测试与子测试） | 通过 | 失败 / 跳过 |
| --- | ---: | --- |
| Gateway 定向：原生定制、脱敏、page-state、Codex 模型列表 | 259 | 0 / 0 |
| Gateway race 定向 | 227 | 0 / 0 |
| 新 moejs：middleware / agentplug race | 29 / 7 | 0 / 0 |
| GUI Codex 模型列表 / 中文脱敏 | 2 / 2 | 0 / 0 |

最终 nogui vet、Linux `CGO_ENABLED=0` 构建、Go 1.26.8 全仓 gofmt、7 个受影响
JS 文件的语法检查和相对官方 pin 的自定义 diff 空白检查通过。完整增量的
空白检查只指出官方 `THIRD_PARTY_NOTICES:391` 的额外 EOF 空行；许可文件与
官方 blob 完全相同，原样保留，没有为消除此提示改动许可声明。36 个定制/附加
文件高置信秘密模式扫描无发现。GUI 两项为 Go fixture，不是浏览器验证；
JS syntax 也不等于 Windows/modal/滚动的真实视觉或端到端验证。

原生 gather/cache、Chat、Kiro 及历史记录与验证过的 checkpoint 逐字节相同；
Kiro 的 165 项结果仍是下文06:13阶段的新跑结果，未将它重复计为本阶段执行。
此前的 Unix socket 环境阻塞保留，未再尝试绕过或当作通过。没有付费模型
调用、部署或运行配置变化。GitHub CI 须以最终发布 head 的实际检查为准。

## 06:13 UTC 增量对齐

本次从已交付的 `65da9f44a9da771f147771e5bd60c6f2768ffaf8` 继续三方合并，
固定官方宿主在 06:13 UTC 核查时的 main：
[`yetone/magpie@4c1fb7758bc609889cfd4de8ccc41c717d02dac8`](https://github.com/yetone/magpie/commit/4c1fb7758bc609889cfd4de8ccc41c717d02dac8)，
接入上一 pin `a05b3735` 之后的 45 个提交。本记录描述候选源码；是否已进入
升级分支，以 Draft PR 的精确 head 为准，不是部署或运行版本声明。

官方插件仓库核查 pin 为
[`magpie-community/plugins@2c3081845810ff56ba8e27814eb99452f7f0d186`](https://github.com/magpie-community/plugins/commit/2c3081845810ff56ba8e27814eb99452f7f0d186)。
与上一 pin `fd40b20c` 逐文件比较，`packages/kiro/` 的全部 17 个官方文件
blob SHA 均相同，因此内置定制 Kiro 不作覆盖或无意义升级，仍是官方
`ceda5800` / 0.1.18 加既有定制，入口 SHA256 与下文一致。

native Messages 全量收集、显式缓存边界优先、Chat unknown-cache，以及
Kiro native effort / GPT Chat / 续期重验等定制继续保留。上游新的一小时
缓存标记只适用于 Responses 到 Claude 的翻译路径，新的 relay cache key
规则排除了 plugin account；它们不能替代本地原生 Messages 缓存实现。
没有引入历史未交付的模拟缓存，也没有改变运行配置或历史快照文件。

### 错误收集兼容修正

上游 `e68327b2` 让 HTTP 200 携带的 vendor error 按其真实错误类别处理。
直接三方合并后，Messages 聚合仍将这些错误压为 502；Responses SSE 的
同源分支也如此，Responses whole 的 invalid request 还可能以 HTTP 200
回给客户端。真实离线 plugin fixture 和相同字节的原生 `holdWriter` 对照
证明了这些差异。本次仅修复 `gathered.go` 的错误边界，复用上游
`errorReply` / `streamEvent` 分类与 `writeVendorError`，不另建重试或计费逻辑。
错误的 type/code 即使配中性 message 也参与分类；请求错误为 400、限流为
429、过载为 529。仅 parser/transport 诊断及未确认的失败文字仍为 502，
不因含有 “invalid” 或 “rate limit” 就误判。正常原生回复的完整块与 usage
仍按既有规则保留。首个确认错误优先，正常完整 refusal 仍是原生回复，SSE
policy error 保持宿主“不因过滤拒绝而休眠账号”的语义。whole HTTP 200 携带
policy error 的官方历史路径保持不变，不借本轮对齐扩修其未正规化行为。

### 本次新跑验证

使用 Go 1.27.3 / Bun 1.4.3、临时 HOME/XDG、合成账号与本地 fake vendors；
Kiro 单测禁止未 mock 的外网 fetch。没有真实 Kiro 调用或运行配置读取。

| 检查 | 通过 | 失败 / 跳过 |
| --- | ---: | --- |
| 最终 Gateway 定向（含测试与子测试） | 257 | 0 / 0 |
| 最终 Gateway race 定向 | 237 | 0 / 0 |
| Plugin system CA / dist 更新定向 | 12 | 0 / 0 |
| Provider / usage / usageapi / redact 定向 | 6 / 17 / 2 / 1 | 0 / 0 |
| 未改动的内置 Kiro（16 files，799 assertions） | 165 | 0 / 0 |

独立 Astra max worktree 先复现错误分类问题：最初 35 个叶子案例中 19 fail；
最终补丁的 45 个叶子案例全部通过（含父测试 52 pass），含真实 plugin host
的 whole/SSE 与 Messages/Responses 组合，不是只检查源码字样。主树的
257/237 结果已包含最终 policy 排除条件，不能拿之前候选的 race 代替。

第一次较宽的 Gateway 检查另有 **1 项环境阻塞**：
`TestToolCallOfTheMagpieBeforeGoesToIt` 在 `handover_test.go:513` 创建 Unix
socket 时返回 `socket: operation not permitted`。该次为 205 pass / 1 fail；
没有改写测试或绕过 sandbox，最终支持范围的命令不包含这一项，不能将其
算作通过。其他选中的 handover 回归已通过。

最终 `go vet -tags nogui ./...`、Linux `CGO_ENABLED=0 go build -tags nogui
-trimpath` 通过；按仓库/CI Go 1.26.8 运行全仓 gofmt，无输出。35 个相对官方
附加/定制文件的高置信凭据模式扫描无发现（不等于完整秘密检测保证）。内置
Kiro 全部 20 文件及两个历史记录文件与 `65da9f44` 字节完全一致。

本轮没有运行全量无关套件、完整 GUI/跨平台实际运行或真实账号验证。
候选源码的本地通过不等于 GitHub CI 通过；未启用 workflows。

## 01:58 UTC 首次对齐（历史记录）

以下结果属于前次已交付的 `65da9f44`，不能当作本次新跑结果。

这是源码更新，不是部署记录。`codex/core-running-20261028` 的运行快照和
`main` 均未修改；成果保存在 `dot/upstream-align-20261028`，以 Draft PR
提交给运行快照分支。没有部署、合并主分支、发布版本或真实 Kiro 调用。

### 固定来源

| 部分 | 固定提交 |
| --- | --- |
| 本次定制起点 | `loufilk/magpie@b213aecfbf1930bbcb4584ec84cc4bb0cd221b8e` |
| 官方宿主（最终固定 main，01:58 UTC 复核） | [`yetone/magpie@a05b3735381c5411d678c90ca5f7c2147da7667d`](https://github.com/yetone/magpie/commit/a05b3735381c5411d678c90ca5f7c2147da7667d) |
| 原定制 Kiro | `780aa7a717bbab5a2e74a7f12e0cbd8b66d9a13a`，随上述归档保存在 `local-plugins/kiro/` |
| 官方插件仓库（本轮开始时 main） | [`magpie-community/plugins@fd40b20c3bad27144a9041839c6b2e0aa60ec203`](https://github.com/magpie-community/plugins/commit/fd40b20c3bad27144a9041839c6b2e0aa60ec203) |
| 官方最后一次 Kiro 更新 | [`ceda58008093755e31381db9fd37f0097f1b2c22`](https://github.com/magpie-community/plugins/commit/ceda58008093755e31381db9fd37f0097f1b2c22)，0.1.18 |

宿主三方合并的共同祖先为 `894603bcd8c2f7ce0cb2ceafbc41b5827531575a`，
本轮接入其后的 431 个官方提交。首个已验证 checkpoint `ef230d1e` 对齐
`9ba3f049`；收尾复核时再接入 `f39fc3ac` 的成功模型列表探测不进 Requests、
以及 `a05b3735` 的 plugin checkin `until`，并补对应回归。此后固定该 pin，
不把“本轮核查时最新”说成永远追踪最新。

Kiro 的共同祖先为
`ba9801c953948c6ff4d435dbc529f39916f3bdc9`；该祖先的最后一次 Kiro 修改是
`9f6c4e8861260acdfb0b6849b0d05545c535ff53`，用于内容三方对比。

### 保留的定制与去重结论

- **原生 Messages 非流式收集**：官方仍仅收集 Responses，不能替代本地
  `gatherMessages`。保留原生 effort、adaptive thinking、display、schema、
  输出上限和完整回复块，失败或不完整流不能变成成功 JSON。
- **原生请求的默认缓存边界**：官方翻译路径已有默认标记，但会重建请求，
  不能直接替代 `gatheredMessageCache`。调用者任何显式缓存选择优先；最多
  补两个边界，不标记 thinking/未知块，不模拟缓存命中或计费。
- **Chat unknown-cache 接入**：官方 `cUsage` 尚未读取该标记，保留定制解析，
  复用官方 Usage、路由和账本实现，不另建计量通路。
- **Kiro native effort / GPT Chat**：官方尚无 catalog-driven 等价实现。
  保留 schema 精确级别验证、`xhigh`/`max` 区分、无请求时不注入默认值、
  换凭据后重新校验、每次请求最多一次续期、Chat 读写缓存详情及显式输入零。

独立 Astra max 复核没有找到可按语义等价安全删除的上述实现。
官方对旧 `kiro` / `kiro-plugin` 零缓存记录的 unknown 启发式仍然保留，
不把 synthetic-provider 回归说成该历史行为已修复。跨协议客户端的既有
usage 输出契约也没有扩大。没有加入旧讨论中的模拟缓存或无关 kiro-rs 功能。

### Kiro 的两项官方更新

1. `634a8653` / 0.1.17：额度窗口增加 `amount`、`limit`、`unit`，供宿主显示
   剩余额度；原来的百分比和 display 不变。
2. `ceda5800` / 0.1.18：超过 5 MiB Base64 的图片在发送副本内缩小；无法读取、
   缩小或超出处理限制时，用明确说明替代，不悄悄丢弃。限额内图片原样发送，
   调用者请求不被改写。该官方行为的正常、边界和失败情形均有离线回归。

图片适配后的初次发送和续期重试仍携带 `additionalModelRequestFields`，
不绕过定制 schema/协议校验。目录仍为本地固定定制包；`package.json` 的
0.1.18 **不是**“可用官方 npm 包替代”的声明。

当前 `local-plugins/kiro/index.mjs` SHA256：
`890f2473623b187068ddede7226f6352f02b73b4e68f62b017e8fff35833aa86`。
历史 `runtime-snapshot.json` 保持归档值，不能拿它验证新源码。

### 当次新跑验证

Go 1.27.3、Bun 1.4.3；临时 HOME/XDG、固定复用 Go 缓存、合成凭据和本地
fake vendors。没有使用用户本机、真实账号、运行配置或付费模型调用。

- 首轮 `9ba3f049` 的 Gateway 定向回归：187 个测试/子测试通过，0 fail / 0 skip；覆盖原生定制、
  Responses 失败收集和插件大回复/活动及停滞读者等相关流路径。
- 该轮 Plugin / usage / provider 定向回归：19 / 11 / 14 通过，0 fail / 0 skip。
- 最终 `a05b3735` 集成树补跑：Gateway 179、Gateway race 174、provider
  checkin race 28、usage 17 个测试/子测试通过，全部 0 fail / 0 skip；包含
  `TestPluginCheckinAsksAgainAtUntil` 与 `TestAnsweredModelListIsNoRow`。
- Kiro 本包：165 pass / 0 fail / 0 skip，799 assertions，16 files；另有
  官方 shape 检查与全部 17 个 `.mjs` 语法检查。
- `go vet -tags nogui ./...`、Linux `CGO_ENABLED=0 go build -tags nogui -trimpath`
  通过。按仓库/CI 的 Go 1.26.8 运行全仓 gofmt，输出为空；Go 1.27.3 的
  formatter 对一个未修改的上游测试文件给出不同空白排版，未据此改写上游。
- 反向破坏检查：关闭 Messages gather 后 7 个行为子测试失败，包含
  `native effort = <nil>, want "xhigh"`；关闭图片适配、删除额度字段、丢弃
  native fields 分别触发 3 / 2 / 2 个预期行为失败，不是编译失败。
- 最终 34 个自定义/附加文件的高置信凭据模式扫描无发现。源码和测试只含
  合成凭据，原有 MIT 作者与许可证保留。

没有运行全量无关套件、完整 GUI/跨平台实际运行或真实 Kiro 验证；以上
定向结果不宣称全仓所有测试通过。CI 状态以该 Draft PR 精确 head 的检查为准。

主要可重跑入口：`internal/gateway/*messages*test.go`、
`gathered*_test.go`、`plugin_cache_knowledge_test.go`、`cache_unknown_test.go`，
以及临时 HOME 下的 `bun test ./local-plugins/kiro`。宿主测试需 Bun 在 PATH，
否则 plugin fixture 会跳过，不能将 skip 算作通过。
