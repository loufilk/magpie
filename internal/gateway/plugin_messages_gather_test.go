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
)

// The real gateway and plugin host, with the fake plugin forwarding only
// to httptest, must not turn a native effort into a budget just because
// the client wants one JSON reply. No Kiro account or vendor is used.
func TestPluginMessagesNativeControls(t *testing.T) {
	var mu sync.Mutex
	var sent []map[string]any
	var paths []string
	pid := besideFake(t, "kiro", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q map[string]any
		if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		sent = append(sent, q)
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		if oc, _ := q["output_config"].(map[string]any); oc["effort"] == "fixture-invalid" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"type":"error","error":{"type":"invalid_request_error","message":"invalid fixture effort value"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Request-Id", "req_native_controls")
		switch r.URL.Path {
		case "/v1/messages":
			io.WriteString(w, sse(
				`event: message_start`+"\n"+`data: {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"fake-claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":0}}}`,
				`event: content_block_start`+"\n"+`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
				`event: content_block_delta`+"\n"+`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`,
				`event: content_block_stop`+"\n"+`data: {"type":"content_block_stop","index":0}`,
				`event: message_delta`+"\n"+`data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}`,
				`event: message_stop`+"\n"+`data: {"type":"message_stop"}`))
		case "/v1/chat/completions":
			io.WriteString(w, sse(
				`data: {"id":"chat_fixture","object":"chat.completion.chunk","model":"fake-1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}`,
				`data: [DONE]`))
		case "/v1/responses":
			io.WriteString(w, sse(
				`event: response.created`+"\n"+`data: {"type":"response.created","response":{"id":"resp_fixture","object":"response","status":"in_progress","output":[]}}`,
				`event: response.completed`+"\n"+`data: {"type":"response.completed","response":{"id":"resp_fixture","object":"response","status":"completed","model":"fake-resp","output":[{"id":"msg_fixture","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}`))
		default:
			t.Errorf("unexpected plugin endpoint %s", r.URL.Path)
		}
	}))

	type testCase struct {
		name, path, model, effort string
		stream, adaptive, schema  bool
		cap                       int
	}
	var cases []testCase
	for _, stream := range []bool{false, true} {
		for _, effort := range []string{"xhigh", "max"} {
			for _, adaptive := range []bool{false, true} {
				cases = append(cases, testCase{
					name: fmt.Sprintf("messages/%s/stream=%t/adaptive=%t", effort, stream, adaptive),
					path: "/v1/messages", model: "fake-claude", effort: effort,
					stream: stream, adaptive: adaptive, cap: 128,
				})
			}
			for _, api := range []struct{ path, model string }{
				{"/v1/chat/completions", "fake-1"},
				{"/v1/responses", "fake-resp"},
			} {
				cases = append(cases, testCase{
					name: fmt.Sprintf("%s/%s/stream=%t", api.model, effort, stream),
					path: api.path, model: api.model, effort: effort, stream: stream,
				})
			}
		}
		for _, extra := range []testCase{
			{name: "unspecified", cap: 128},
			{name: "small-output-cap", effort: "xhigh", adaptive: true, cap: 8},
			{name: "schema", effort: "max", adaptive: true, schema: true, cap: 128},
			{name: "invalid-effort", effort: "fixture-invalid", adaptive: true, cap: 128},
		} {
			extra.name = fmt.Sprintf("messages/%s/stream=%t", extra.name, stream)
			extra.path, extra.model, extra.stream = "/v1/messages", "fake-claude", stream
			cases = append(cases, extra)
		}
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mu.Lock()
			sent, paths = nil, nil
			mu.Unlock()
			body := map[string]any{
				"model":  pid + "/" + tc.model,
				"stream": tc.stream,
			}
			if tc.path == "/v1/responses" {
				body["input"] = "local native effort fixture"
				body["reasoning"] = map[string]any{"effort": tc.effort}
			} else {
				body["messages"] = []any{map[string]any{"role": "user", "content": "local native effort fixture"}}
			}
			var wantFormat map[string]any
			if tc.path == "/v1/messages" {
				body["max_tokens"] = tc.cap
				if tc.adaptive {
					body["thinking"] = map[string]any{"type": "adaptive", "display": "omitted"}
				}
				oc := map[string]any{}
				if tc.effort != "" {
					oc["effort"] = tc.effort
				}
				if tc.schema {
					wantFormat = map[string]any{"type": "json_schema", "schema": map[string]any{
						"type": "object", "properties": map[string]any{"answer": map[string]any{"type": "string"}},
						"required": []any{"answer"}, "additionalProperties": false,
					}}
					oc["format"] = wantFormat
				}
				if len(oc) > 0 {
					body["output_config"] = oc
				}
			} else if tc.path == "/v1/chat/completions" {
				body["reasoning_effort"] = tc.effort
			}
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(string(b)))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("anthropic-version", "2023-06-01")
			New().Handler().ServeHTTP(rec, req)

			mu.Lock()
			got, gotPaths := append([]map[string]any(nil), sent...), append([]string(nil), paths...)
			mu.Unlock()
			if len(got) != 1 || len(gotPaths) != 1 || gotPaths[0] != tc.path {
				t.Fatalf("plugin calls = %v %v, want one on %s; reply %d %s", gotPaths, got, tc.path, rec.Code, rec.Body)
			}
			q := got[0]
			if q["stream"] != true {
				t.Errorf("plugin stream = %v, want true", q["stream"])
			}
			if q["model"] != tc.model {
				t.Errorf("plugin model = %v, want %s", q["model"], tc.model)
			}
			switch tc.path {
			case "/v1/messages":
				oc, _ := q["output_config"].(map[string]any)
				if tc.effort == "" {
					if _, ok := oc["effort"]; ok {
						t.Errorf("unspecified effort became %v", oc["effort"])
					}
				} else if oc["effort"] != tc.effort {
					t.Errorf("native effort = %v, want %q", oc["effort"], tc.effort)
				}
				if tc.schema && !reflect.DeepEqual(oc["format"], wantFormat) {
					t.Errorf("output format = %#v, want %#v", oc["format"], wantFormat)
				}
				thinking, _ := q["thinking"].(map[string]any)
				if tc.adaptive && !reflect.DeepEqual(thinking, map[string]any{"type": "adaptive", "display": "omitted"}) {
					t.Errorf("native thinking = %#v, want adaptive with display omitted", thinking)
				}
				if _, ok := thinking["budget_tokens"]; ok {
					t.Errorf("native controls gained a budget: %#v", thinking)
				}
				if q["max_tokens"] != float64(tc.cap) {
					t.Errorf("max_tokens = %v, want caller's %d", q["max_tokens"], tc.cap)
				}
			case "/v1/chat/completions":
				if q["reasoning_effort"] != tc.effort {
					t.Errorf("Chat effort = %v, want %s", q["reasoning_effort"], tc.effort)
				}
			case "/v1/responses":
				reasoning, _ := q["reasoning"].(map[string]any)
				if reasoning["effort"] != tc.effort {
					t.Errorf("Responses effort = %v, want %s", reasoning["effort"], tc.effort)
				}
			}
			if tc.effort == "fixture-invalid" {
				if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid fixture effort value") {
					t.Fatalf("invalid effort did not reach the validator: %d %s", rec.Code, rec.Body)
				}
				return
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("reply %d %s", rec.Code, rec.Body)
			}
			if tc.stream {
				if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/event-stream") {
					t.Fatalf("stream Content-Type = %q", rec.Header().Get("Content-Type"))
				}
			} else {
				if rec.Header().Get("Content-Type") != "application/json" || !json.Valid(rec.Body.Bytes()) {
					t.Fatalf("nonstream reply = %q %s", rec.Header().Get("Content-Type"), rec.Body)
				}
				if tc.path == "/v1/messages" {
					var reply struct {
						Type    string
						Content []struct{ Type, Text string }
						Usage   struct {
							Input  int `json:"input_tokens"`
							Output int `json:"output_tokens"`
						}
					}
					if err := json.Unmarshal(rec.Body.Bytes(), &reply); err != nil || reply.Type != "message" ||
						len(reply.Content) != 1 || reply.Content[0].Text != "ok" || reply.Usage.Input != 7 || reply.Usage.Output != 2 {
						t.Fatalf("assembled Messages reply: %v %s", err, rec.Body)
					}
				}
			}
		})
	}
}
