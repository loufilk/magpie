import { afterEach, expect, test } from "bun:test"
import { KiroAuthPlugin } from "./index.mjs"

// Number zero is not a missing count. The generated AWS Q CLI decoder preserves
// uncachedInputTokens:0; it does not document our legacy inputTokens alias.
// https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-streaming-client/src/protocol_serde/shape_token_usage.rs
// These are synthetic protocol frames, not captured Kiro usage or billing claims.
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const auth = () => ({ type: "oauth", access: "synthetic-input-counts", refresh: "synthetic-refresh",
  expires: Date.now() + 3600000, profileArn: "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST", method: "social" })
const models = ["claude-input-test", "gpt-input-test"].map((modelId) => ({
  modelId, modelName: modelId, supportedInputTypes: ["TEXT"],
  tokenLimits: { maxInputTokens: 100000, maxOutputTokens: 10000 },
  additionalModelRequestFieldsSchema: { properties: {
    [modelId.startsWith("gpt") ? "reasoning" : "output_config"]: { properties: { effort: { enum: ["high"], default: "high" } } },
  } },
}))

function frame(kind, payload) {
  const enc = new TextEncoder()
  const hs = Object.entries({ ":message-type": "event", ":event-type": kind }).map(([key, value]) => {
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
const response = (...fs) => new Response(new ReadableStream({ start(c) { for (const f of fs) c.enqueue(f); c.close() } }))

const cases = [
  { name: "reported zero without context", tokens: { uncachedInputTokens: 0 }, pct: 0, input: 0 },
  { name: "reported zero beats context estimate", tokens: { uncachedInputTokens: 0 }, pct: 10, input: 0 },
  { name: "reported zero beats alias and context", tokens: { uncachedInputTokens: 0, inputTokens: 10500 }, pct: 10, input: 0 },
  { name: "positive count beats alias and context", tokens: { uncachedInputTokens: 17, inputTokens: 10517 }, pct: 10, input: 17 },
  { name: "missing count keeps alias fallback", tokens: { inputTokens: 17 }, pct: 10, input: 17 },
  { name: "null count keeps alias fallback", tokens: { uncachedInputTokens: null, inputTokens: 17 }, pct: 10, input: 17 },
  { name: "missing count keeps context fallback", tokens: {}, pct: 10, input: 10000 },
  { name: "null count keeps context fallback", tokens: { uncachedInputTokens: null }, pct: 10, input: 10000 },
  { name: "missing tokenUsage stays cache unknown", tokens: undefined, pct: 10, input: 10000, unknown: true },
  { name: "null tokenUsage stays cache unknown", tokens: null, pct: 10, input: 10000, unknown: true },
]
for (const c of cases) for (const eventName of ["metadataEvent", "messageMetadataEvent"])
  for (const protocol of ["messages", "chat"]) for (const stream of [false, true])
    test(`actual loader ${c.name}; ${eventName}; ${protocol}; stream=${stream}`, async () => {
      let calls = 0
      globalThis.fetch = async (url, init) => {
        if (String(url).includes("/List-Available-Models")) return Response.json({ models })
        if (!String(url).endsWith("/generateAssistantResponse")) throw new Error("unexpected mock request")
        calls++
        const upstream = JSON.parse(init.body)
        expect(upstream.additionalModelRequestFields).toEqual(protocol === "chat"
          ? { reasoning: { effort: "high" } } : { output_config: { effort: "high" } })
        const tokenUsage = c.tokens == null ? c.tokens : { ...c.tokens, outputTokens: 3, cacheReadInputTokens: 10000, cacheWriteInputTokens: 500 }
        return response(frame("assistantResponseEvent", { content: "OK" }),
          frame(eventName, { stopReason: "END_TURN", tokenUsage }),
          frame("contextUsageEvent", { contextUsagePercentage: c.pct }))
      }
      const hooks = await KiroAuthPlugin(), loader = await hooks.auth.loader(async () => auth())
      const body = { model: protocol === "chat" ? "gpt-input-test" : "claude-input-test",
        messages: [{ role: "user", content: "hello" }], max_tokens: 8, stream,
        ...(protocol === "chat" ? { reasoning_effort: "high", stream_options: { include_usage: true } } : { output_config: { effort: "high" } }) }
      const res = await loader.fetch("https://runtime.us-east-1.kiro.dev/" + (protocol === "chat" ? "chat/completions" : "messages"),
        { method: "POST", body: JSON.stringify(body) })
      expect(res.status).toBe(200)
      let usage
      if (!stream) usage = (await res.json()).usage
      else for (const line of (await res.text()).split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue
        const event = JSON.parse(line.slice(6))
        if (event.usage) usage = event.usage
      }
      const output = c.unknown ? 1 : 3
      if (protocol === "messages") expect(usage).toEqual({ input_tokens: c.input, output_tokens: output,
        ...(c.unknown ? { magpie_cache_unknown: true } : { cache_read_input_tokens: 10000, cache_creation_input_tokens: 500 }) })
      else {
        const prompt = c.input + (c.unknown ? 0 : 10500)
        expect(usage).toEqual({ prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
          ...(c.unknown ? { magpie_cache_unknown: true } : { prompt_tokens_details: { cached_tokens: 10000, cache_write_tokens: 500 } }) })
      }
      expect(calls).toBe(1)
    })
