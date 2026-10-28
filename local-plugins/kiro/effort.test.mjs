import { test, expect, afterEach } from "bun:test"
import { _internal, KiroAuthPlugin } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const schema = (path, levels) => ({ properties: { [path]: { properties: { effort: { enum: levels, default: "max" } } } } })
const model = (id, path, levels) => ({ id, name: id, effort: _internal.effortSupport(schema(path, levels)) })
const claude = model("claude-opus-test", "output_config", ["low", "high", "xhigh", "max"])
const gpt = model("gpt-test", "reasoning", ["none", "low", "high", "xhigh", "max"])
const req = (more = {}) => ({ model: claude.id, messages: [{ role: "user", content: "hello" }], ...more })
const creds = async () => ({ token: "synthetic-token", tokenType: "BEARER", region: "us-east-1", profile: "" })
const catalog = { get: async () => [claude, gpt] }

test("variants advertise schema levels, not made-up budgets or model-name capabilities", () => {
  for (const m of [claude, gpt]) for (const got of [_internal.configModel(m), _internal.runtimeModel(m)]) {
    expect(Object.keys(got.variants)).toEqual(m.effort.levels)
    expect(got.variants.xhigh).toEqual(m === gpt ? { reasoningEffort: "xhigh" } : { effort: "xhigh" })
    expect(got.variants.max).toEqual(m === gpt ? { reasoningEffort: "max" } : { effort: "max" })
  }
  expect(_internal.configModel({ id: "claude-unknown" }).variants).toBeUndefined()
  expect(_internal.runtimeModel({ id: "auto" }).variants).toEqual({})
  for (const bad of [null, {}, { properties: { reasoning: { properties: { effort: { enum: "high" } } } } }])
    expect(_internal.effortSupport(bad)).toBeNull()
})

test("actual serialized Kiro requests keep native xhigh and max distinct for both schema paths", async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toEndWith("/generateAssistantResponse")
    seen.push(JSON.parse(init.body))
    return new Response("fixture rejection after capture", { status: 503 })
  }
  for (const m of [claude, gpt]) for (const effort of ["xhigh", "max"]) {
    await _internal.generate(creds, {}, req({ model: m.id, output_config: { effort } }), undefined, catalog)
    const sent = seen.at(-1)
    expect(sent.additionalModelRequestFields).toEqual({ [m.effort.path]: { effort } })
    expect(JSON.stringify(sent)).not.toContain("max_thinking_length")
    expect(JSON.stringify(sent)).not.toContain("synthetic-token")
  }
  expect(seen).toHaveLength(4)
})

test("explicit effort wins over suffix; invalid and conflicting requests never generate", async () => {
  expect(_internal.nativeRequest(req({ model: claude.id + ":max", reasoning: { effort: "low" } }), [claude]))
    .toEqual({ model: claude.id, fields: { output_config: { effort: "low" } } })
  expect(_internal.nativeRequest(req({ model: claude.id + ":xhigh" }), [claude]).fields)
    .toEqual({ output_config: { effort: "xhigh" } })
  let calls = 0
  const noCreds = async () => { calls++; return creds() }
  globalThis.fetch = async () => { throw new Error("must not generate") }
  for (const more of [
    { output_config: { effort: "ultra" } }, { output_config: { effort: null } },
    { output_config: { effort: "low" }, reasoning_effort: "max" },
    { output_config: { effort: "high" }, thinking: { type: "disabled" } },
    { model: gpt.id, thinking: { type: "enabled", budget_tokens: 32000 } },
    { model: "auto", output_config: { effort: "high" } },
  ]) expect((await _internal.generate(noCreds, {}, req(more), undefined, catalog)).status).toBe(400)
  expect(calls).toBe(0)
  for (const more of [{ output_config: { effort: "none" } }, { model: "claude-unknown", reasoning_effort: "high" }])
    expect((await _internal.generate(creds, {}, req(more), undefined, catalog)).status).toBe(400)
})

test("native effort, thinking budget, adaptive fallback and display are independent", async () => {
  expect(_internal.thinking(req({ output_config: { effort: "max" } }), claude.id)).toBe(0)
  expect(_internal.thinking(req({ output_config: { effort: "max" }, thinking: { type: "enabled", budget_tokens: 1234 } }), claude.id)).toBe(1234)
  expect(_internal.thinking(req({ thinking: { type: "adaptive" } }), claude.id)).toBe(20000)
  expect(_internal.nativeRequest(req({ model: gpt.id, reasoning_effort: "none", thinking: { type: "disabled" } }), [gpt]).fields)
    .toEqual({ reasoning: { effort: "none" } })
  expect(() => _internal.validateThinking(req({ thinking: { type: "adaptive", budget_tokens: 1234 } }))).toThrow()
  expect(() => _internal.validateThinking(req({ thinking: { type: "enabled", display: "unknown" } }))).toThrow()
  async function* source() { yield { kind: "think", text: "hidden" }; yield { kind: "sig", text: "sig" }; yield { kind: "text", text: "visible" } }
  const shown = []
  for await (const e of _internal.visibleEvents(source(), "omitted")) shown.push(e)
  expect(shown).toEqual([{ kind: "text", text: "visible" }])
})

test("ordinary requests need no model catalog and receive no guessed default effort", async () => {
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const sent = JSON.parse(init.body)
    expect(sent.additionalModelRequestFields).toBeUndefined()
    calls++
    return new Response("", { status: 503 })
  }
  await _internal.generate(creds, {}, req(), undefined, { get: async () => { throw new Error("must not list") } })
  expect(calls).toBe(1)
  const hooks = await KiroAuthPlugin()
  const cfg = {}
  await hooks.config(cfg)
  expect(cfg.provider.kiro.models.auto.variants).toBeUndefined()
})

test("native Claude adaptive effort never invents a 20k budget, while an explicit budget stays independent", async () => {
  const sent = []
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response("", { status: 503 }) }
  for (const effort of ["xhigh", "max"]) {
    await _internal.generate(creds, {}, req({ output_config: { effort }, thinking: { type: "adaptive", display: "summarized" } }), undefined, catalog)
    expect(sent.at(-1).additionalModelRequestFields).toEqual({ output_config: { effort } })
    expect(JSON.stringify(sent.at(-1))).not.toContain("max_thinking_length")
  }
  await _internal.generate(creds, {}, req({ output_config: { effort: "high" }, thinking: { type: "enabled", budget_tokens: 1234 } }), undefined, catalog)
  expect(JSON.stringify(sent.at(-1))).toContain("<max_thinking_length>1234</max_thinking_length>")
})

test("a renewed account must confirm native capabilities before retrying", async () => {
  let generations = 0
  const lookups = []
  globalThis.fetch = async () => { generations++; return new Response("", { status: 403 }) }
  const rotating = async (_auth, stale) => ({ ...(await creds()), token: stale ? "new-account" : "old-account", profile: stale ? "new-profile" : "" })
  const scoped = { get: async (a) => { lookups.push(a.token); return a.token === "old-account" ? [claude] : [model(claude.id, "output_config", ["low"])] } }
  const res = await _internal.generate(rotating, {}, req({ output_config: { effort: "xhigh" } }), undefined, scoped)
  expect(res.status).toBe(502)
  expect(generations).toBe(1)
  expect(lookups).toEqual(["old-account", "new-account"])
})

test("catalog 403 renews once, rechecks the new account, and never loops or generates without support", async () => {
  for (const outcome of ["generate", "catalog403", "generation403"]) {
    const credentials = []
    const lookups = []
    let generations = 0
    const rotating = async (_auth, stale = false) => {
      credentials.push(stale)
      return { ...(await creds()), token: stale ? "new-token" : "old-token" }
    }
    const scoped = { get: async (a) => {
      lookups.push(a.token)
      if (a.token === "old-token" || outcome === "catalog403")
        throw Object.assign(new Error("synthetic directory forbidden"), { status: 403 })
      return [claude]
    } }
    globalThis.fetch = async (_url, init) => {
      generations++
      expect(JSON.parse(init.body).additionalModelRequestFields).toEqual({ output_config: { effort: "high" } })
      return new Response("", { status: outcome === "generation403" ? 403 : 503 })
    }
    const response = await _internal.generate(rotating, {}, req({ output_config: { effort: "high" } }), undefined, scoped)
    expect(response.status).toBe(outcome === "catalog403" ? 502 : outcome === "generation403" ? 403 : 503)
    expect(credentials).toEqual([false, true])
    expect(lookups).toEqual(["old-token", "new-token"])
    expect(generations).toBe(outcome === "catalog403" ? 0 : 1)
  }
})
