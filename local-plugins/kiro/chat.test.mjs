import { afterEach, expect, test } from "bun:test"
import { KiroAuthPlugin, _internal } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST"
const auth = (access) => ({ type: "oauth", access, refresh: "synthetic-refresh", expires: Date.now() + 3600000, profileArn: PROFILE, method: "social" })
const schema = (path, levels) => ({ properties: { [path]: { properties: { effort: { enum: levels, default: "max" } } } } })
const gpt = (levels) => ({ modelId: "gpt-test", modelName: "GPT Test", supportedInputTypes: ["TEXT", "IMAGE"],
  tokenLimits: { maxInputTokens: 100000, maxOutputTokens: 10000 }, additionalModelRequestFieldsSchema: schema("reasoning", levels),
  accessToken: "RAW-CATALOG-SECRET", extra: { privateData: "RAW-CATALOG-SECRET" } })

// Synthetic AWS event frames, using the same framing as the existing Kiro tests.
function frame(kind, payload, exception = false) {
  const enc = new TextEncoder()
  const headers = { ":message-type": exception ? "exception" : "event", [exception ? ":exception-type" : ":event-type"]: kind }
  const hs = Object.entries(headers).map(([key, value]) => {
    const k = enc.encode(key), v = enc.encode(value), h = new Uint8Array(k.length + v.length + 4)
    h[0] = k.length; h.set(k, 1); h[k.length + 1] = 7
    new DataView(h.buffer).setUint16(k.length + 2, v.length); h.set(v, k.length + 4)
    return h
  })
  const hlen = hs.reduce((n, h) => n + h.length, 0), b = enc.encode(JSON.stringify(payload))
  const out = new Uint8Array(16 + hlen + b.length), view = new DataView(out.buffer)
  view.setUint32(0, out.length); view.setUint32(4, hlen)
  let offset = 12
  for (const h of hs) { out.set(h, offset); offset += h.length }
  out.set(b, offset)
  return out
}
const response = (...frames) => new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(f); c.close() } }))
const ok = () => response(frame("assistantResponseEvent", { content: "OK" }), frame("metadataEvent", { tokenUsage: { inputTokens: 2, outputTokens: 3 } }))
const call = (fetcher, body) => fetcher("https://runtime.us-east-1.kiro.dev/chat/completions", { method: "POST", body: JSON.stringify(body) })
const request = (more = {}) => ({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], ...more })

test("actual loader discovers schema, declares Chat, and preserves xhigh/max/none on the final wire", async () => {
  const seen = [], lists = []
  let active = auth("synthetic-A"), levelsA = ["none", "low", "high", "xhigh", "max"]
  globalThis.fetch = async (url, init) => {
    const bearer = init.headers.Authorization
    if (String(url).includes("/List-Available-Models")) {
      lists.push(bearer)
      return Response.json({ models: [gpt(bearer.endsWith("synthetic-A") ? levelsA : ["low"])] })
    }
    if (String(url).endsWith("/generateAssistantResponse")) { seen.push(JSON.parse(init.body)); return ok() }
    throw new Error("unexpected mock request " + url)
  }
  const hooks = await KiroAuthPlugin()
  const loader = await hooks.auth.loader(async () => active)
  const models = await hooks.provider.models({ models: {} }, { auth: active })
  expect(models["gpt-test"].api.npm).toBe("@ai-sdk/openai-compatible")
  expect(models["gpt-test"].variants.xhigh).toEqual({ reasoningEffort: "xhigh" })
  expect(JSON.stringify(models)).not.toContain("RAW-CATALOG-SECRET")
  expect(JSON.stringify(models)).not.toContain("synthetic-A")
  for (const effort of ["xhigh", "max", "none"]) {
    const res = await call(loader.fetch, request({ reasoning_effort: effort }))
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe("OK")
    expect(seen.at(-1).additionalModelRequestFields).toEqual({ reasoning: { effort } })
    expect(JSON.stringify(seen.at(-1))).not.toContain("RAW-CATALOG-SECRET")
    expect(JSON.stringify(seen.at(-1))).not.toContain("max_thinking_length")
  }
  expect(lists).toEqual(["Bearer synthetic-A"])
  active = auth("synthetic-B")
  expect((await call(loader.fetch, request({ reasoning_effort: "xhigh" }))).status).toBe(400)
  expect(seen).toHaveLength(3)
  expect(lists.at(-1)).toBe("Bearer synthetic-B")
  active = auth("synthetic-A")
  levelsA = ["low"]
  await hooks.provider.models({ models: {} }, { auth: active }) // explicit refresh replaces A, not B
  expect((await call(loader.fetch, request({ reasoning_effort: "xhigh" }))).status).toBe(400)
  expect(seen).toHaveLength(3)
})

test("Chat tool names, multi-turn results, images, streaming and usage share the existing Kiro path", async () => {
  const name = "mcp_" + "long_tool_name_".repeat(7), alias = _internal.toolName(name)
  const captured = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/List-Available-Models")) return Response.json({ models: [gpt(["xhigh", "max"])] })
    if (!String(url).endsWith("/generateAssistantResponse")) throw new Error("unexpected request")
    captured.push(JSON.parse(init.body))
    if (captured.length === 1) return response(
      frame("reasoningContentEvent", { text: "consider" }),
      frame("toolUseEvent", { toolUseId: "call1", name: alias, input: '{"query":' }),
      frame("toolUseEvent", { toolUseId: "call1", name: alias, input: '"x"}' }),
      frame("metadataEvent", { tokenUsage: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 5, cacheWriteInputTokens: 7 } }))
    return response(frame("assistantResponseEvent", { content: "done" }),
      frame("metadataEvent", { stopReason: "max_tokens", tokenUsage: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 5 } }))
  }
  const hooks = await KiroAuthPlugin(), loader = await hooks.auth.loader(async () => auth("synthetic-C"))
  const first = request({ reasoning_effort: "xhigh", tools: [{ type: "function", function: { name, parameters: { type: "object" } } }] })
  const res = await call(loader.fetch, first), body = await res.json()
  expect(body.choices[0].finish_reason).toBe("tool_calls")
  expect(body.choices[0].message.tool_calls).toEqual([{ id: "call1", type: "function", function: { name, arguments: '{"query":"x"}' } }])
  expect(body.choices[0].message.reasoning_content).toBe("consider")
  expect(body.usage).toEqual({ prompt_tokens: 14, completion_tokens: 3, total_tokens: 17, prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 7 } })
  const second = request({ reasoning_effort: "max", stream: true, stream_options: { include_usage: true },
    messages: [...first.messages, body.choices[0].message, { role: "tool", tool_call_id: "call1",
      content: [{ type: "text", text: "result" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }] })
  const stream = await call(loader.fetch, second), wire = await stream.text()
  expect(wire).toContain('"content":"done"')
  expect(wire).toContain('"finish_reason":"length"')
  expect(wire).toContain('"cached_tokens":5')
  expect(wire).toContain("data: [DONE]")
  const state = captured[1].conversationState, current = state.currentMessage.userInputMessage
  expect(state.history[1].assistantResponseMessage.toolUses[0].name).toBe(alias)
  expect(current.userInputMessageContext.toolResults[0]).toMatchObject({ toolUseId: "call1", content: [{ text: "result" }] })
  expect(current.images).toEqual([{ format: "png", source: { bytes: "aGVsbG8=" } }])
  expect(current.userInputMessageContext.tools[0].toolSpecification.name).toBe(alias)
  expect(captured[1].additionalModelRequestFields).toEqual({ reasoning: { effort: "max" } })
})

test("streamed Chat tools retain indices/arguments and an early exception stays an HTTP error", async () => {
  const names = new Map([["short", "full-name"]])
  const events = () => _internal.events(response(frame("toolUseEvent", { toolUseId: "id", name: "short", input: { x: 1 } })).body, "gpt-test", false)
  const s = await (await _internal.replyChat(events(), "gpt-test", true, names)).text()
  expect(s).toContain('"index":0,"id":"id"')
  expect(s).toContain('"name":"full-name"')
  expect(s).toContain('"arguments":"{\\\"x\\\":1}"')
  expect(s).toContain('"finish_reason":"tool_calls"')
  for (const stream of [false, true]) {
    const it = _internal.events(response(frame("ThrottlingException", { message: "Too many requests" }, true)).body, "gpt-test", false)
    expect((await _internal.replyChat(it, "gpt-test", stream, names)).status).toBe(429)
  }
})

test("Chat rejects lossy content and malformed tool input instead of silently dropping it", () => {
  expect(() => _internal.chatInput(request({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }] }] }))).toThrow()
  expect(() => _internal.chatInput(request({ messages: [{ role: "assistant", content: null, tool_calls: [{ id: "id", type: "function", function: { name: "t", arguments: "bad" } }] }] }))).toThrow()
  expect(() => _internal.chatInput(request({ tool_choice: "required" }))).toThrow()
})

test("zero-argument and absent-input Chat tools produce valid JSON, including successive streamed tools", async () => {
  const events = () => _internal.events(response(
    frame("toolUseEvent", { toolUseId: "a", name: "one", input: {} }),
    frame("toolUseEvent", { toolUseId: "b", name: "two" })).body, "gpt-test", false)
  const body = await (await _internal.replyChat(events(), "gpt-test", false, new Map())).json()
  expect(body.choices[0].message.tool_calls.map((c) => JSON.parse(c.function.arguments))).toEqual([{}, {}])
  const wire = await (await _internal.replyChat(events(), "gpt-test", true, new Map())).text()
  const argumentsByIndex = ["", ""], names = []
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue
    const c = JSON.parse(line.slice(6))
    for (const t of c.choices?.[0]?.delta?.tool_calls ?? []) {
      if (t.function.name) names.push(t.function.name)
      argumentsByIndex[t.index] += t.function.arguments ?? ""
    }
  }
  expect(names).toEqual(["one", "two"])
  expect(argumentsByIndex.map((a) => JSON.parse(a))).toEqual([{}, {}])
})

test("unsupported Chat generation controls fail clearly instead of disappearing", () => {
  for (const more of [{ n: 2 }, { parallel_tool_calls: false }, { stop: ["END"] }, { stop: "END" }])
    expect(() => _internal.chatInput(request(more))).toThrow()
  expect(() => _internal.chatInput(request({ n: 1, parallel_tool_calls: true, stop: [] }))).not.toThrow()
})


for (const stream of [false, true]) test(`actual Chat loader leaves unreported cache unknown, stream=${stream}`, async () => {
  globalThis.fetch = async (url) => {
  if (String(url).includes("/List-Available-Models")) return Response.json({ models: [gpt(["xhigh"])] })
  if (!String(url).endsWith("/generateAssistantResponse")) throw new Error("unexpected mock request")
  return response(
    frame("assistantResponseEvent", { content: "OK" }),
    frame("metadataEvent", { stopReason: "END_TURN" }),
    frame("contextUsageEvent", { contextUsagePercentage: 10 }))
  }
  const hooks = await KiroAuthPlugin(), loader = await hooks.auth.loader(async () => auth("synthetic-unknown"))
  const res = await call(loader.fetch, request({ reasoning_effort: "xhigh", stream, stream_options: { include_usage: true } }))
  expect(res.status).toBe(200)
  let u
  if (!stream) u = (await res.json()).usage
  else for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue
    const event = JSON.parse(line.slice(6))
    if (event.usage) u = event.usage
  }
  expect(u).toEqual({ prompt_tokens: 10000, completion_tokens: 1, total_tokens: 10001, magpie_cache_unknown: true })
  expect(u).not.toHaveProperty("prompt_tokens_details")
})

test("actual Chat loader distinguishes reported zero and positive cache counts from unknown", async () => {
  let cacheRead = 0, cacheWrite = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes("/List-Available-Models")) return Response.json({ models: [gpt(["xhigh"])] })
    if (!String(url).endsWith("/generateAssistantResponse")) throw new Error("unexpected mock request")
    return response(frame("assistantResponseEvent", { content: "OK" }),
      frame("messageMetadataEvent", { tokenUsage: { uncachedInputTokens: 17, outputTokens: 3, cacheReadInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite } }))
  }
  const hooks = await KiroAuthPlugin(), loader = await hooks.auth.loader(async () => auth("synthetic-reported"))
  for (const counts of [[0, 0], [10000, 500]]) {
    ;[cacheRead, cacheWrite] = counts
    for (const stream of [false, true]) {
      const res = await call(loader.fetch, request({ reasoning_effort: "xhigh", stream, stream_options: { include_usage: true } }))
      expect(res.status).toBe(200)
      let u
      if (!stream) u = (await res.json()).usage
      else for (const line of (await res.text()).split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue
        const event = JSON.parse(line.slice(6))
        if (event.usage) u = event.usage
      }
      expect(u).toEqual({ prompt_tokens: 17 + cacheRead + cacheWrite, completion_tokens: 3,
        total_tokens: 20 + cacheRead + cacheWrite, prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite } })
      expect(u).not.toHaveProperty("magpie_cache_unknown")
    }
  }
})
