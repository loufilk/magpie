package gateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
	"github.com/yetone/magpie/internal/provider"
)

// A synthetic provider id avoids Kiro's separate historical-ledger heuristic:
// here a reported zero must stay distinguishable from an explicit unknown.
func TestPluginNativeCacheKnowledge(t *testing.T) {
	pid := besideFake(t, "cache-knowledge-fixture", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		state := gjson.GetBytes(body, "metadata.cache_fixture").Str
		if state == "" {
			state = gjson.GetBytes(body, "messages.0.content").Str
		}
		unknown := state == "unknown" || state == "counted-with-flag"
		read := 0
		input := 1200
		if state == "counted" || state == "counted-with-flag" {
			read, input = 10000, 17
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if strings.HasSuffix(r.URL.Path, "/messages") {
			u := map[string]any{"input_tokens": input, "output_tokens": 3}
			if state != "unknown" {
				u["cache_read_input_tokens"], u["cache_creation_input_tokens"] = read, 0
			}
			if unknown {
				u["magpie_cache_unknown"] = true
			}
			io.WriteString(w, sse(
				"event: message_start\ndata: "+string(raw(map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_knowledge", "type": "message", "role": "assistant", "model": "fake-claude", "content": []any{}, "usage": map[string]any{"input_tokens": 0, "output_tokens": 0}}})),
				"event: content_block_start\ndata: "+string(raw(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})),
				"event: content_block_delta\ndata: "+string(raw(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "ok"}})),
				"event: content_block_stop\ndata: "+string(raw(map[string]any{"type": "content_block_stop", "index": 0})),
				"event: message_delta\ndata: "+string(raw(map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": u})),
				"event: message_stop\ndata: "+string(raw(map[string]any{"type": "message_stop"}))))
			return
		}
		u := map[string]any{"prompt_tokens": input + read, "completion_tokens": 3, "total_tokens": input + read + 3}
		if state != "unknown" {
			u["prompt_tokens_details"] = map[string]any{"cached_tokens": read}
		}
		if unknown {
			u["magpie_cache_unknown"] = true
		}
		io.WriteString(w, sse(
			"data: "+string(raw(map[string]any{"id": "chat_knowledge", "object": "chat.completion.chunk", "model": "fake-1", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "ok"}, "finish_reason": "stop"}}})),
			"data: "+string(raw(map[string]any{"id": "chat_knowledge", "object": "chat.completion.chunk", "model": "fake-1", "choices": []any{}, "usage": u})),
			"data: [DONE]"))
	}))
	for _, api := range []struct {
		path, model string
		proto       provider.Protocol
	}{{"/v1/messages", "fake-claude", provider.Anthropic}, {"/v1/chat/completions", "fake-1", provider.Chat}} {
		for _, stream := range []bool{false, true} {
			for _, state := range []string{"unknown", "zero", "counted", "counted-with-flag"} {
				t.Run(fmt.Sprintf("%s/%s/stream=%t", api.model, state, stream), func(t *testing.T) {
					b := map[string]any{"model": pid + "/" + api.model, "stream": stream, "max_tokens": 128,
						"messages": []any{map[string]any{"role": "user", "content": state}},
						"metadata": map[string]any{"cache_fixture": state}}
					if api.proto == provider.Anthropic {
						b["output_config"] = map[string]any{"effort": "xhigh"}
					} else {
						b["reasoning_effort"] = "xhigh"
						b["stream_options"] = map[string]any{"include_usage": true}
					}
					input, err := json.Marshal(b)
					if err != nil {
						t.Fatal(err)
					}
					s := New()
					rec := httptest.NewRecorder()
					req := httptest.NewRequest(http.MethodPost, api.path, strings.NewReader(string(input)))
					req.RemoteAddr, req.Host = "127.0.0.1:12345", "127.0.0.1"
					req.Header.Set("Content-Type", "application/json")
					s.Front().ServeHTTP(rec, req)
					if rec.Code != http.StatusOK {
						t.Fatalf("reply %d: %s", rec.Code, rec.Body)
					}
					wantUnknown := state == "unknown"
					wantInput, wantRead := 1200, 0
					if state == "counted" || state == "counted-with-flag" {
						wantInput, wantRead = 17, 10000
					}
					route := lastRoute(s)
					if len(route.Usage) != 1 || route.Usage[0].CacheUnknown != wantUnknown {
						t.Fatalf("route usage = %+v, want unknown=%t", route.Usage, wantUnknown)
					}
					record := lastRecord(t)
					if record.CacheUnknown != wantUnknown || record.Input != wantInput || record.Output != 3 ||
						record.CacheRead != wantRead || record.CacheWrite != 0 {
						t.Errorf("record = %+v, want input=%d/read=%d/unknown=%t", record, wantInput, wantRead, wantUnknown)
					}
					sniff := newSniffer(api.proto, rec.Header().Get("Content-Type"))
					sniff.write(rec.Body.Bytes())
					u := sniff.usage()
					if u.Input != wantInput || u.Output != 3 || u.CacheRead != wantRead || u.CacheWrite != 0 {
						t.Errorf("client usage = %+v", u)
					}
					// Messages gathering and native streams retain the plugin's
					// extension and absent fields. Existing translated Chat
					// rendering follows upstream's ordinary client-usage contract.
					if api.proto == provider.Anthropic || stream {
						if u.cacheNotCounted() != wantUnknown {
							t.Errorf("native reply unknown = %t, want %t: %s", u.cacheNotCounted(), wantUnknown, rec.Body)
						}
						if wantUnknown && (strings.Contains(rec.Body.String(), "cache_read_input_tokens") ||
							strings.Contains(rec.Body.String(), "cache_creation_input_tokens") ||
							strings.Contains(rec.Body.String(), "cached_tokens")) {
							t.Errorf("unknown gained a cache count: %s", rec.Body)
						}
					}
				})
			}
		}
	}
}
