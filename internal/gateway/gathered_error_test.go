package gateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

// The words alone do not identify these failures. Their type/code must
// survive gathering, as when the same reply goes straight to holdWriter.
var gatheredErrorCases = []struct {
	name, body string
	status     int
}{
	{"rate type", `{"type":"error","error":{"type":"rate_limit_error","message":"Please try again shortly."}}`, 429},
	{"rate code", `{"error":{"code":"rate_limit_exceeded","message":"Please try again shortly."}}`, 429},
	{"invalid type", `{"type":"error","error":{"type":"invalid_request_error","message":"The requested option is not supported.","code":"unsupported_option","param":"output_config"}}`, 400},
	{"overloaded type", `{"type":"error","error":{"type":"overloaded_error","message":"Please try again shortly."}}`, 529},
	{"vendor failure", `{"type":"error","error":{"type":"api_error","message":"The vendor could not finish."}}`, 502},
}

func gatheredErrorBody(proto provider.Protocol, whole bool, body string) string {
	if whole {
		return body
	}
	if proto == provider.Responses {
		var v struct{ Error json.RawMessage }
		json.Unmarshal([]byte(body), &v)
		return sse(`event: response.failed` + "\n" + `data: {"type":"response.failed","response":{"id":"r_failed","status":"failed","output":[],"error":` + string(v.Error) + `}}`)
	}
	return sse("event: error\ndata: " + body)
}

func TestGatheredCarriedErrorParity(t *testing.T) {
	for _, proto := range []provider.Protocol{provider.Anthropic, provider.Responses} {
		for _, whole := range []bool{true, false} {
			for _, tc := range gatheredErrorCases {
				t.Run(fmt.Sprintf("%s/whole=%t/%s", proto, whole, tc.name), func(t *testing.T) {
					body := gatheredErrorBody(proto, whole, tc.body)
					ctype := "text/event-stream"
					if whole {
						ctype = "application/json"
					}
					// The official, ungathered path reads the same vendor bytes.
					plain := newHoldWriter(httptest.NewRecorder(), true)
					plain.Header().Set("Content-Type", ctype)
					plain.WriteHeader(http.StatusOK)
					plain.Write([]byte(body))
					plain.settle()
					if plain.code() != tc.status {
						t.Fatalf("ungathered status = %d, want %d", plain.code(), tc.status)
					}

					sniff := newSniffer(proto, ctype)
					sniff.write([]byte(body))
					if whole {
						sniff.settleWhole()
					} else {
						sniff.drain()
					}
					g := &gathered{proto: proto, h: http.Header{"Content-Type": []string{ctype}}, status: http.StatusOK}
					g.Write([]byte(body))
					held := newHoldWriter(httptest.NewRecorder(), true)
					g.finish(held, provider.Provider{Name: "fixture"}, !whole, "", sniff.failed)
					held.settle()
					if held.code() != plain.code() {
						t.Errorf("gathered status = %d, ungathered = %d: %s", held.code(), plain.code(), held.errBody())
					}
					if got, want := failure(held.code(), held.errBody()), failure(plain.code(), plain.errBody()); got != want {
						t.Errorf("gathered failure = %s, ungathered = %s", got, want)
					}
					if proto == provider.Responses && tc.status == 400 {
						var v struct{ Error struct{ Code, Param string } }
						if err := json.Unmarshal(held.errBody(), &v); err != nil || v.Error.Code != "unsupported_option" || v.Error.Param != "output_config" {
							t.Errorf("vendor code/param lost: %s", held.errBody())
						}
					}
				})
			}
		}
	}
}

// A successful native refusal is still a reply. Words and error-shaped
// opaque data inside it are not an error event, and usage stays native.
func TestGatheredNativeRefusalStaysWhole(t *testing.T) {
	for _, proto := range []provider.Protocol{provider.Anthropic, provider.Responses} {
		for _, whole := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/whole=%t", proto, whole), func(t *testing.T) {
				opaque := `{"error":{"type":"rate_limit_error","message":"invalid rate limit"},"large":9007199254740993}`
				body := `{"id":"msg_refused","type":"message","role":"assistant","content":[],"stop_reason":"refusal","usage":{"input_tokens":7,"output_tokens":0,"magpie_cache_unknown":true},"opaque":` + opaque + `}`
				if proto == provider.Responses {
					body = `{"id":"r_refused","object":"response","status":"incomplete","output":[],"incomplete_details":{"reason":"content_filter"},"usage":{"input_tokens":7,"output_tokens":0,"magpie_cache_unknown":true},"opaque":` + opaque + `}`
				}
				if !whole {
					if proto == provider.Anthropic {
						body = messagesGatherStream(anthropicWholeEvents([]byte(body)))
					} else {
						body = sse(`data: {"type":"response.incomplete","response":` + body + `}`)
					}
				}
				g := &gathered{proto: proto, h: http.Header{}, status: http.StatusOK}
				g.Write([]byte(body))
				w := httptest.NewRecorder()
				status, msg := g.finish(w, provider.Provider{Name: "fixture"}, !whole, "", "")
				var reply obj
				if status != 200 || msg != "" || json.Unmarshal(w.Body.Bytes(), &reply) != nil {
					t.Fatalf("native refusal became an error: %d %q %s", status, msg, w.Body)
				}
				if string(reply["opaque"]) != opaque || !strings.Contains(string(reply["usage"]), `"magpie_cache_unknown":true`) {
					t.Fatalf("native fields changed: %s", w.Body)
				}
			})
		}
	}
}

// An explicit policy error is different from the complete refusal above:
// the hold must recognize it as the vendor's filter, resting no account.
func TestGatheredPolicyErrorKeepsRefusal(t *testing.T) {
	for _, proto := range []provider.Protocol{provider.Anthropic, provider.Responses} {
		t.Run(string(proto), func(t *testing.T) {
			body := gatheredErrorBody(proto, false, `{"type":"error","error":{"code":"bio_policy","message":"The requested content cannot be served."}}`)
			plain := newHoldWriter(httptest.NewRecorder(), true)
			plain.Header().Set("Content-Type", "text/event-stream")
			plain.WriteHeader(200)
			plain.Write([]byte(body))
			plain.settle()
			if !plain.refused || plain.code() != refusedStatus {
				t.Fatalf("ungathered policy error = %d refused=%t", plain.code(), plain.refused)
			}
			sniff := newSniffer(proto, "text/event-stream")
			sniff.write([]byte(body))
			sniff.drain()
			g := &gathered{proto: proto, h: http.Header{}, status: http.StatusOK}
			g.Write([]byte(body))
			held := newHoldWriter(httptest.NewRecorder(), true)
			g.finish(held, provider.Provider{Name: "fixture"}, true, "", sniff.failed)
			held.settle()
			if held.code() != plain.code() || held.refused != plain.refused {
				t.Fatalf("gathered policy error = %d refused=%t, want %d refused=%t: %s", held.code(), held.refused, plain.code(), plain.refused, held.errBody())
			}
		})
	}
}

// A policy error carried in a whole 200 is an existing exception: the
// native hold classifies errorReply, but does not apply policyRefusal to
// it. Gathering must not newly treat it as a stream's filter refusal.
func TestGatheredWholePolicyErrorKeepsExistingPath(t *testing.T) {
	const body = `{"type":"error","error":{"code":"bio_policy","message":"The requested content cannot be served."}}`
	for _, proto := range []provider.Protocol{provider.Anthropic, provider.Responses} {
		t.Run(string(proto), func(t *testing.T) {
			plain := newHoldWriter(httptest.NewRecorder(), true)
			plain.Header().Set("Content-Type", "application/json")
			plain.WriteHeader(200)
			plain.Write([]byte(body))
			plain.settle()
			if plain.code() != 502 || plain.refused {
				t.Fatalf("whole native policy behavior changed: status=%d refused=%t", plain.code(), plain.refused)
			}
			sniff := newSniffer(proto, "application/json")
			sniff.write([]byte(body))
			sniff.settleWhole()
			g := &gathered{proto: proto, h: http.Header{"Content-Type": []string{"application/json"}}, status: http.StatusOK}
			g.Write([]byte(body))
			held := newHoldWriter(httptest.NewRecorder(), true)
			g.finish(held, provider.Provider{Name: "fixture"}, false, "", sniff.failed)
			held.settle()
			if held.code() != plain.code() || held.refused != plain.refused {
				t.Fatalf("gathered whole policy error = %d refused=%t, native = %d refused=%t", held.code(), held.refused, plain.code(), plain.refused)
			}
		})
	}
}

func TestGatheredKeepsFirstCarriedError(t *testing.T) {
	for _, proto := range []provider.Protocol{provider.Anthropic, provider.Responses} {
		t.Run(string(proto), func(t *testing.T) {
			body := gatheredErrorBody(proto, false, gatheredErrorCases[0].body) + gatheredErrorBody(proto, false, gatheredErrorCases[2].body)
			plain := newHoldWriter(httptest.NewRecorder(), true)
			plain.Header().Set("Content-Type", "text/event-stream")
			plain.WriteHeader(200)
			plain.Write([]byte(body))
			plain.settle()
			sniff := newSniffer(proto, "text/event-stream")
			sniff.write([]byte(body))
			sniff.drain()
			g := &gathered{proto: proto, h: http.Header{}, status: http.StatusOK}
			g.Write([]byte(body))
			held := newHoldWriter(httptest.NewRecorder(), true)
			g.finish(held, provider.Provider{Name: "fixture"}, true, "", sniff.failed)
			held.settle()
			if plain.code() != 429 || held.code() != plain.code() {
				t.Fatalf("first error lost: gathered=%d ungathered=%d, want 429", held.code(), plain.code())
			}
		})
	}
}

// Parser and transport messages can contain error keywords without being
// a vendor's error. In particular, invalid JSON must not turn into a 400.
func TestGatheredMessagesTransportErrorsStay502(t *testing.T) {
	whole := `{"id":"msg_1","type":"message","role":"assistant","content":[],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`
	stream := messagesGatherStream(anthropicWholeEvents([]byte(whole)))
	for _, tc := range []struct {
		name, body, cut, failed string
		sse                     bool
	}{
		{"whole invalid JSON", `{"type":"message","content":`, "", "", false},
		{"whole cut keywords", whole, "invalid rate limit while reading socket", "", false},
		{"whole unconfirmed failure", whole, "", "invalid rate limit while reading socket", false},
		{"stream invalid JSON", "data: {\n\n", "", "", true},
		{"stream cut keywords", stream, "invalid rate limit while reading socket", "", true},
		{"stream unconfirmed failure", stream, "", "invalid rate limit while reading socket", true},
		{"stream missing stop", strings.ReplaceAll(stream, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", ""), "", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := &gathered{proto: provider.Anthropic, h: http.Header{}, status: http.StatusOK}
			g.Write([]byte(tc.body))
			w := httptest.NewRecorder()
			status, _ := g.finish(w, provider.Provider{Name: "fixture"}, tc.sse, tc.cut, tc.failed)
			if status != http.StatusBadGateway || w.Code != status {
				t.Fatalf("status = %d/%d, want 502: %s", status, w.Code, w.Body)
			}
		})
	}
}

// Exercise the real plugin host and gateway's native, stream-only route.
// Each rate failure is followed by an answer; a bad request is asked once.
func TestPluginGatheredCarriedErrors(t *testing.T) {
	var mu sync.Mutex
	var body, ctype, path string
	var calls int
	pid := besideFake(t, "kiro", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		mu.Lock()
		defer mu.Unlock()
		calls++
		if r.URL.Path != path || req["stream"] != true {
			t.Errorf("plugin got %s stream=%v, want %s stream=true", r.URL.Path, req["stream"], path)
		}
		if calls == 1 {
			w.Header().Set("Content-Type", ctype)
			io.WriteString(w, body)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if path == "/v1/messages" {
			done := []byte(`{"id":"msg_ok","type":"message","role":"assistant","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
			io.WriteString(w, messagesGatherStream(anthropicWholeEvents(done)))
		} else {
			io.WriteString(w, sse(`data: {"type":"response.completed","response":{"id":"r_ok","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}`))
		}
	}))
	for _, proto := range []provider.Protocol{provider.Anthropic, provider.Responses} {
		for _, whole := range []bool{true, false} {
			for _, index := range []int{0, 2} {
				tc := gatheredErrorCases[index]
				t.Run(fmt.Sprintf("%s/whole=%t/%s", proto, whole, tc.name), func(t *testing.T) {
					clineRestsCleared(t)
					mu.Lock()
					calls, body, ctype = 0, gatheredErrorBody(proto, whole, tc.body), "text/event-stream"
					if whole {
						ctype = "application/json"
					}
					path = "/v1/messages"
					ask := `{"model":"` + pid + `/fake-claude","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`
					if proto == provider.Responses {
						path = "/v1/responses"
						ask = `{"model":"` + pid + `/fake-resp","input":"hi"}`
					}
					mu.Unlock()
					s := New()
					code, reply := sendTo(s, path, ask)
					mu.Lock()
					n := calls
					mu.Unlock()
					try := firstTry(t, s)
					if try.Status != tc.status {
						t.Errorf("first try status = %d, want %d", try.Status, tc.status)
					}
					if tc.status == 429 {
						if code != 200 || !strings.Contains(reply, "hello") || n != 2 || try.Fail != failRate {
							t.Errorf("rate failure: reply=%d %s calls=%d failure=%s", code, reply, n, try.Fail)
						}
					} else if code != 400 || n != 1 || !strings.Contains(reply, "The requested option is not supported.") {
						t.Errorf("request refusal: reply=%d %s calls=%d", code, reply, n)
					}
				})
			}
		}
	}
}
