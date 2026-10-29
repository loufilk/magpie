package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/tidwall/gjson"
	"github.com/yetone/magpie/internal/provider"
)

const pluginThinkingRefusal = `{"type":"error","error":{"type":"invalid_request_error","message":"thinking.type must be \"enabled\""}}`

// The upstream translation path and native Messages gather see the same
// fake plugin's refusal. A whole 200 stays on its existing path; only an
// SSE refusal before content gets the upstream thinking-needed recovery.
func TestPluginMessagesThinkingNeeded(t *testing.T) {
	for _, mode := range []string{"http400", "whole200", "sse200", "sse200-plain", "sse200-lead"} {
		for _, path := range []string{"translated-reference", "native-gather"} {
			t.Run(mode+"/"+path, func(t *testing.T) {
				var mu sync.Mutex
				var sent [][]byte
				pid := besideFake(t, "thinking-review", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					b, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
						return
					}
					mu.Lock()
					sent = append(sent, bytes.Clone(b))
					mu.Unlock()
					if r.URL.Path != "/v1/messages" {
						t.Errorf("vendor path = %s", r.URL.Path)
					}
					if gjson.GetBytes(b, "thinking.type").String() != "enabled" {
						w.Header().Set("X-Request-Id", "refused-request")
						if strings.HasPrefix(mode, "sse200") {
							w.Header().Set("Content-Type", "text/event-stream")
							if mode == "sse200-plain" {
								w.Header().Set("Content-Type", "text/plain")
							}
							if mode == "sse200-lead" {
								io.WriteString(w, messageEmptyLead+"event: ping\ndata: {\"type\":\"ping\"}\n\n")
							}
							io.WriteString(w, "event: error\ndata: "+pluginThinkingRefusal+"\n\n")
						} else {
							w.Header().Set("Content-Type", "application/json")
							if mode == "http400" {
								w.WriteHeader(http.StatusBadRequest)
							}
							io.WriteString(w, pluginThinkingRefusal)
						}
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					w.Header().Set("X-Request-Id", "success-request")
					io.WriteString(w, messagesGatherStream(anthropicWholeEvents([]byte(`{"id":"msg_review","type":"message","role":"assistant","model":"fake-claude","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`))))
				}))
				p, err := provider.Find(pid)
				if err != nil {
					t.Fatal(err)
				}
				srv := New()
				body := []byte(`{"model":"` + pid + `/fake-claude","stream":false,"max_tokens":8,"temperature":0,"messages":[{"role":"user","content":"synthetic review fixture"}],"output_config":{"format":{"type":"json_schema","schema":{"type":"object"}}},"opaque_native":{"number":9007199254740993}}`)
				for turn, wantCalls := range []int{2, 1} {
					mu.Lock()
					sent = nil
					mu.Unlock()
					req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader(body))
					req.Header.Set("Content-Type", "application/json")
					rec := httptest.NewRecorder()
					if path == "translated-reference" {
						srv.translate(rec, req, *p, provider.Anthropic, provider.Anthropic, "fake-claude", body, &Usage{})
					} else {
						srv.Handler().ServeHTTP(rec, req)
					}
					mu.Lock()
					got := append([][]byte(nil), sent...)
					mu.Unlock()
					for i, b := range got {
						t.Logf("turn=%d vendor-call=%d body=%s", turn+1, i+1, b)
					}
					if mode == "whole200" {
						wantStatus := http.StatusBadGateway
						if path == "native-gather" {
							wantStatus = http.StatusBadRequest
						}
						if rec.Code != wantStatus || len(got) != 1 || !srv.fits(p.ID, thinkingNeeded("fake-claude"), provider.Anthropic) {
							t.Fatalf("whole 200 changed: status=%d calls=%d; want %d/1 with nothing learned", rec.Code, len(got), wantStatus)
						}
						continue
					}
					if rec.Code != http.StatusOK || len(got) != wantCalls {
						t.Fatalf("turn=%d: status=%d calls=%d; want success in %d calls; reply=%s", turn+1, rec.Code, len(got), wantCalls, rec.Body)
					}
					last := got[len(got)-1]
					if gjson.GetBytes(last, "thinking.type").String() != "enabled" || gjson.GetBytes(last, "thinking.budget_tokens").Int() != 1024 || gjson.GetBytes(last, "max_tokens").Int() <= 1024 {
						t.Fatalf("thinking-needed repair missing: %s", last)
					}
					if path == "native-gather" && (gjson.GetBytes(last, "opaque_native.number").Raw != "9007199254740993" || gjson.GetBytes(last, "output_config.format.type").String() != "json_schema") {
						t.Fatalf("native fields lost: %s", last)
					}
					if path == "native-gather" {
						if rec.Header().Get("Content-Type") != "application/json" ||
							gjson.GetBytes(rec.Body.Bytes(), "type").String() != "message" ||
							gjson.GetBytes(rec.Body.Bytes(), "content.0.text").String() != "ok" {
							t.Fatalf("retried native reply is not one JSON message: %q %s", rec.Header().Get("Content-Type"), rec.Body)
						}
						record := lastRecord(t)
						if record.ErrType != "" || record.RequestID != "success-request" {
							t.Fatalf("refusal overwrote successful usage: %+v", record)
						}
					}
				}
			})
		}
	}
}

const messageEmptyLead = "event: message_start\ndata: " + `{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}` + "\n\n"

const thinkingOnlyLead = messageEmptyLead +
	"event: content_block_start\ndata: " + `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}` + "\n\n" +
	"event: content_block_delta\ndata: " + `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}` + "\n\n" +
	"event: content_block_stop\ndata: " + `{"type":"content_block_stop","index":0}` + "\n\n"

// Recovery is narrow: it cannot turn native output, another error or a
// transport diagnostic into a reason to spend another model request.
// Call passthrough directly to keep the gateway's established retries of
// generic 502 failures apart from this specific thinking-needed recovery.
func TestPluginMessagesThinkingNeededBoundaries(t *testing.T) {
	refusal := "event: error\ndata: " + pluginThinkingRefusal + "\n\n"
	for _, tc := range []struct {
		name, thinking, prefix, reply string
		cancel, cut, learned, stream  bool
		calls                         int
	}{
		{name: "enabled", thinking: `{"type":"enabled","budget_tokens":2048}`, calls: 1},
		{name: "adaptive", thinking: `{"type":"adaptive","display":"omitted"}`, calls: 1},
		{name: "native stream", stream: true, calls: 1},
		{name: "thinking block", prefix: thinkingOnlyLead, calls: 1},
		{name: "text", prefix: `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"already said"}}` + "\n\n", calls: 1},
		{name: "tool", prefix: `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"f","input":{}}}` + "\n\n", calls: 1},
		{name: "opaque", prefix: `data: {"type":"content_block_start","index":0,"content_block":{"type":"future_block","opaque":"already said"}}` + "\n\n", calls: 1},
		{name: "opaque event", prefix: `data: {"type":"future_output","opaque":"already said"}` + "\n\n", calls: 1},
		{name: "text delta", prefix: `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"already said"}}` + "\n\n", calls: 1},
		{name: "tool delta", prefix: `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}` + "\n\n", calls: 1},
		{name: "other error", reply: `data: {"type":"error","error":{"type":"invalid_request_error","message":"unsupported output_config"}}` + "\n\n", calls: 1},
		{name: "first error wins", prefix: `data: {"type":"error","error":{"type":"invalid_request_error","message":"unsupported output_config"}}` + "\n\n", calls: 1},
		{name: "policy error", reply: `data: {"type":"error","error":{"code":"bio_policy","message":"thinking.type must be \"enabled\""}}` + "\n\n", calls: 1},
		{name: "malformed", reply: "event: error\ndata: { thinking.type must be enabled\n\n", calls: 1},
		{name: "cancelled", cancel: true, calls: 1},
		{name: "transport cut", cut: true, calls: 1},
		{name: "refused twice", calls: 2, learned: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var sent [][]byte
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			pid := besideFake(t, "thinking-boundary", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				mu.Lock()
				sent = append(sent, bytes.Clone(b))
				mu.Unlock()
				out := tc.reply
				if out == "" {
					out = tc.prefix + refusal
				}
				w.Header().Set("Content-Type", "text/event-stream")
				if tc.cut {
					w.Header().Set("Content-Length", fmt.Sprint(len(out)+100))
				}
				io.WriteString(w, out)
				w.(http.Flusher).Flush()
				if tc.cancel {
					cancel()
				}
			}))
			body := []byte(`{"model":"` + pid + `/fake-claude","stream":false,"max_tokens":8,"messages":[{"role":"user","content":"synthetic boundary fixture"}],"output_config":{"effort":"xhigh","format":{"type":"json_schema","schema":{"type":"object"}}},"cache_control":null}`)
			if tc.thinking != "" {
				body = withFields(body, map[string]any{"thinking": json.RawMessage(tc.thinking)})
			}
			if tc.stream {
				body = withFields(body, map[string]any{"stream": true})
			}
			req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader(body)).WithContext(ctx)
			rec := httptest.NewRecorder()
			srv := New()
			p, err := provider.Find(pid)
			if err != nil {
				t.Fatal(err)
			}
			srv.passthrough(rec, req, *p, provider.Anthropic, "fake-claude", body, &Usage{})
			mu.Lock()
			got := append([][]byte(nil), sent...)
			mu.Unlock()
			if len(got) != tc.calls {
				t.Fatalf("calls=%d, want %d; status=%d reply=%s", len(got), tc.calls, rec.Code, rec.Body)
			}
			if learned := !srv.fits(pid, thinkingNeeded("fake-claude"), provider.Anthropic); learned != tc.learned {
				t.Errorf("learned=%t, want %t; status=%d reply=%s", learned, tc.learned, rec.Code, rec.Body)
			}
			for _, b := range got {
				if gjson.GetBytes(b, "output_config.effort").String() != "xhigh" || gjson.GetBytes(b, "output_config.format.type").String() != "json_schema" || gjson.GetBytes(b, "cache_control").Raw != "null" {
					t.Errorf("native controls changed: %s", b)
				}
			}
		})
	}
}
