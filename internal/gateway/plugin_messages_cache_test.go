package gateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tidwall/gjson"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/usage"
)

// The real gateway and plugin host carry cache defaults to the plugin only
// for newly gathered Messages. Repeated vendor totals must not be billed twice.
func TestPluginMessagesNativeCacheDefaults(t *testing.T) {
	var mu sync.Mutex
	var sent [][]byte
	pid := besideFake(t, "kiro", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || r.URL.Path != "/v1/messages" {
			t.Errorf("fake vendor request %s: %v", r.URL.Path, err)
			http.Error(w, "unexpected fixture request", http.StatusBadRequest)
			return
		}
		mu.Lock()
		sent = append(sent, body)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, sse(
			"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_native_cache\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"fake-claude\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":17,\"output_tokens\":0,\"cache_read_input_tokens\":10000,\"cache_creation_input_tokens\":500,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":500}}}}",
			"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}",
			"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}",
			"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"input_tokens\":17,\"output_tokens\":3,\"cache_read_input_tokens\":10000,\"cache_creation_input_tokens\":500,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":500}}}",
			"event: message_stop\ndata: {\"type\":\"message_stop\"}"))
	}))
	cases := []struct{ name, body, want string }{
		{"plain", "{\"system\":\"stable system\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}]}", "{\"system\":[{\"type\":\"text\",\"text\":\"stable system\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"local cache fixture\",\"cache_control\":{\"type\":\"ephemeral\"}}]}]}"},
		{"arrays", "{\"system\":[{\"type\":\"text\",\"text\":\"first\"},{\"type\":\"text\",\"text\":\"last\",\"opaque\":\"kept\"}],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"question\"},{\"type\":\"thinking\",\"thinking\":\"hidden\",\"signature\":\"sig\"}]}]}", "{\"system\":[{\"type\":\"text\",\"text\":\"first\"},{\"type\":\"text\",\"text\":\"last\",\"opaque\":\"kept\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"question\",\"cache_control\":{\"type\":\"ephemeral\"}},{\"type\":\"thinking\",\"thinking\":\"hidden\",\"signature\":\"sig\"}]}]}"},
		{"system-absent", "{\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}}]}", "{\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"local cache fixture\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\"}}]}"},
		{"system-null", "{\"system\":null,\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}}]}", "{\"system\":null,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"local cache fixture\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\"}}]}"},
		{"system-empty-string", "{\"system\":\"\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}}]}", "{\"system\":\"\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"local cache fixture\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\"}}]}"},
		{"system-empty-array", "{\"system\":[],\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}}]}", "{\"system\":[],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"local cache fixture\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\"}}]}"},
		{"system-empty-text", "{\"system\":[{\"type\":\"text\",\"text\":\"\"}],\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}}]}", "{\"system\":[{\"type\":\"text\",\"text\":\"\"}],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"local cache fixture\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\"}}]}"},
		{"no-tools", "{\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"tools\":[]}", "{\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"local cache fixture\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"tools\":[]}"},
		{"thinking-only-tail", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hidden\",\"signature\":\"sig\"},{\"type\":\"redacted_thinking\",\"data\":\"opaque\"}]}]}", "{\"system\":[{\"type\":\"text\",\"text\":\"stable\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hidden\",\"signature\":\"sig\"},{\"type\":\"redacted_thinking\",\"data\":\"opaque\"}]}]}"},
		{"opaque-tail", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"},{\"type\":\"future_block\",\"opaque\":{\"cache_control\":\"data\"}}]}]}", "{\"system\":[{\"type\":\"text\",\"text\":\"stable\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\",\"cache_control\":{\"type\":\"ephemeral\"}},{\"type\":\"future_block\",\"opaque\":{\"cache_control\":\"data\"}}]}]}"},
		{"schema-key-is-not-mark", "{\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"tools\":[{\"name\":\"read\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"cache_control\":{\"type\":\"string\"}}}}]}", "{\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"local cache fixture\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"tools\":[{\"name\":\"read\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"cache_control\":{\"type\":\"string\"}}},\"cache_control\":{\"type\":\"ephemeral\"}}]}"},
		{"explicit-system-1h", "{\"system\":[{\"type\":\"text\",\"text\":\"stable\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}],\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}]}", "{\"system\":[{\"type\":\"text\",\"text\":\"stable\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}],\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}]}"},
		{"explicit-tool-1h", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"tools\":[{\"name\":\"read\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}]}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"tools\":[{\"name\":\"read\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}]}"},
		{"explicit-message-5m", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"5m\"}}]}]}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"5m\"}}]}]}"},
		{"explicit-root-null", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"cache_control\":null}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"cache_control\":null}"},
		{"explicit-root-empty", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"cache_control\":{}}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"cache_control\":{}}"},
		{"explicit-root-none", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"cache_control\":{\"type\":\"none\"}}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"cache_control\":{\"type\":\"none\"}}"},
		{"explicit-root-unknown-ttl", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"unsupported\"}}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"unsupported\"}}"},
		{"four-marks", "{\"system\":[{\"type\":\"text\",\"text\":\"stable\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\"}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\"}}]}", "{\"system\":[{\"type\":\"text\",\"text\":\"stable\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"tools\":[{\"name\":\"a\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\"}},{\"name\":\"b\",\"input_schema\":{\"type\":\"object\",\"properties\":{}},\"cache_control\":{\"type\":\"ephemeral\"}}]}"},
		{"disabled-none-effort", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"local cache fixture\"}],\"thinking\":{\"type\":\"disabled\"},\"output_config\":{\"effort\":\"none\"}}", "{\"system\":[{\"type\":\"text\",\"text\":\"stable\",\"cache_control\":{\"type\":\"ephemeral\"}}],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"local cache fixture\",\"cache_control\":{\"type\":\"ephemeral\"}}]}],\"thinking\":{\"type\":\"disabled\"},\"output_config\":{\"effort\":\"none\"}}"},
		{"nested-tool-result-1h", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tool1\",\"name\":\"read\",\"input\":{}}]},{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool1\",\"content\":[{\"type\":\"text\",\"text\":\"result\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}]}]}]}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tool1\",\"name\":\"read\",\"input\":{}}]},{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool1\",\"content\":[{\"type\":\"text\",\"text\":\"result\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}]}]}]}"},
		{"nested-tool-result-null", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tool1\",\"name\":\"read\",\"input\":{}}]},{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool1\",\"content\":[{\"type\":\"text\",\"text\":\"result\",\"cache_control\":null}]}]}]}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tool1\",\"name\":\"read\",\"input\":{}}]},{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool1\",\"content\":[{\"type\":\"text\",\"text\":\"result\",\"cache_control\":null}]}]}]}"},
		{"nested-search-result", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"search_result\",\"source\":\"https://fixture.invalid\",\"title\":\"fixture\",\"content\":[{\"type\":\"text\",\"text\":\"result\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}]}]}]}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"search_result\",\"source\":\"https://fixture.invalid\",\"title\":\"fixture\",\"content\":[{\"type\":\"text\",\"text\":\"result\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}]}]}]}"},
		{"nested-document", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"document\",\"source\":{\"type\":\"content\",\"content\":[{\"type\":\"text\",\"text\":\"result\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}]}}]}]}", "{\"system\":\"stable\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"document\",\"source\":{\"type\":\"content\",\"content\":[{\"type\":\"text\",\"text\":\"result\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}}]}}]}]}"},
	}
	for _, stream := range []bool{false, true} {
		for _, tc := range cases {
			t.Run(fmt.Sprintf("%s/stream=%t", tc.name, stream), func(t *testing.T) {
				var body map[string]json.RawMessage
				if err := json.Unmarshal([]byte(tc.body), &body); err != nil {
					t.Fatal(err)
				}
				body["model"], body["stream"], body["max_tokens"] = raw(pid+"/fake-claude"), raw(stream), raw(128)
				if body["output_config"] == nil {
					body["output_config"] = raw(map[string]any{"effort": "xhigh", "format": map[string]any{"type": "json_schema", "schema": map[string]any{"type": "object"}}})
					body["thinking"] = raw(map[string]any{"type": "adaptive", "display": "omitted"})
				}
				body["opaque_native"] = json.RawMessage("{\"number\":9007199254740993,\"cache_control\":\"not a protocol mark\"}")
				input, err := json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
				before := len(usage.Load(time.Time{}))
				mu.Lock()
				sent = nil
				mu.Unlock()
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(string(input)))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("anthropic-version", "2023-06-01")
				New().Handler().ServeHTTP(rec, req)
				if rec.Code != http.StatusOK {
					t.Fatalf("reply %d: %s", rec.Code, rec.Body)
				}
				mu.Lock()
				calls := append([][]byte(nil), sent...)
				mu.Unlock()
				if len(calls) != 1 {
					t.Fatalf("vendor calls = %d, want one", len(calls))
				}
				q := calls[0]
				t.Logf("cache-wire %s", q) // synthetic input for the pinned plugin wire probe
				want := tc.want
				if stream {
					want = tc.body
				}
				var gotBody, wantBody map[string]any
				if json.Unmarshal(q, &gotBody) != nil || json.Unmarshal([]byte(want), &wantBody) != nil {
					t.Fatal("invalid fixture body")
				}
				for _, key := range []string{"system", "messages", "tools", "cache_control"} {
					got, hasGot := gotBody[key]
					expected, hasWant := wantBody[key]
					if hasGot != hasWant || !reflect.DeepEqual(got, expected) {
						t.Errorf("%s = %#v, want %#v (present %t/%t)", key, got, expected, hasGot, hasWant)
					}
				}
				for _, key := range []string{"output_config", "thinking", "max_tokens", "opaque_native"} {
					var expected any
					if json.Unmarshal(body[key], &expected) != nil || !reflect.DeepEqual(gotBody[key], expected) {
						t.Errorf("native %s changed: %s", key, q)
					}
				}
				if !gjson.GetBytes(q, "stream").Bool() || gjson.GetBytes(q, "model").Str != "fake-claude" ||
					gjson.GetBytes(q, "opaque_native.number").Raw != "9007199254740993" {
					t.Errorf("native envelope changed: %s", q)
				}
				sniff := newSniffer(provider.Anthropic, rec.Header().Get("Content-Type"))
				sniff.write(rec.Body.Bytes())
				u := sniff.usage()
				if u.Input != 17 || u.Output != 3 || u.CacheRead != 10000 || u.CacheWrite != 500 || u.CacheWrite1h != 500 {
					t.Errorf("client usage = %+v, want 17/3/read10000/write500/hour500", u)
				}
				records := usage.Load(time.Time{})
				if len(records) != before+1 {
					t.Fatalf("ledger grew by %d, want one", len(records)-before)
				}
				record := lastUsage(t)
				if record.Input != 17 || record.Output != 3 || record.CacheRead != 10000 || record.CacheWrite != 500 || record.CacheWrite1h != 500 {
					t.Errorf("ledger usage = %+v, want one copy of 17/3/read10000/write500/hour500", record)
				}
			})
		}
	}
}
