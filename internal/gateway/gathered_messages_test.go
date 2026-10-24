package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

func messagesGatherStream(events []wholeEvent) string {
	var b strings.Builder
	for _, e := range events {
		data, _ := json.Marshal(e.data)
		b.WriteString("event: " + e.name + "\n")
		b.WriteString("data: " + string(data) + "\n\n")
	}
	return b.String()
}

func TestGatherMessagesKeepsNativeReply(t *testing.T) {
	original := []byte(`{"id":"msg_native","type":"message","role":"assistant","model":"claude-fixture","content":[{"type":"thinking","thinking":"considered","signature":"sealed"},{"type":"text","text":"answer","citations":[{"type":"web_search_result_location","url":"https://example.invalid","title":"fixture","encrypted_index":"opaque"}]},{"type":"tool_use","id":"toolu_1","name":"read","input":{"path":"file"}},{"type":"tool_use","id":"toolu_2","name":"empty","input":{}},{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"fixture"}},{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","url":"https://example.invalid","encrypted_content":"opaque"}]},{"type":"redacted_thinking","data":"sealed"},{"type":"future_block","opaque":{"kept":true}}],"stop_reason":"tool_use","stop_sequence":null,"stop_details":{"category":"fixture"},"usage":{"input_tokens":7,"output_tokens":11,"cache_read_input_tokens":3,"cache_creation_input_tokens":5,"cache_creation":{"ephemeral_1h_input_tokens":5}},"container":{"id":"container_fixture"},"safeguard_results":{"kept":true}}`)
	stream := messagesGatherStream(anthropicWholeEvents(original))
	got, err := gatherMessages([]byte(stream))
	if err != nil {
		t.Fatal(err)
	}
	var want, actual any
	if err := json.Unmarshal(original, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(got, &actual); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, want) {
		t.Fatalf("native message changed:\ngot  %s\nwant %s", got, original)
	}
}

func TestGatherMessagesRejectsIncompleteOrMalformed(t *testing.T) {
	start := `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}` + "\n\n"
	block := `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"f","input":{}}}` + "\n\n"
	blockStop := `data: {"type":"content_block_stop","index":0}` + "\n\n"
	delta := `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}` + "\n\n"
	stop := `data: {"type":"message_stop"}` + "\n\n"
	for name, stream := range map[string]string{
		"empty":               "",
		"empty final delta":   start + `data: {"type":"message_delta","delta":{}}` + "\n\n" + stop,
		"missing stop":        start + delta,
		"missing final delta": start + stop,
		"open block":          start + block + delta + stop,
		"missing block":       start + blockStop + delta + stop,
		"duplicate block":     start + block + block,
		"invalid tool JSON":   start + block + `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}` + "\n\n" + blockStop + delta + stop,
		"invalid event JSON":  start + "data: {\n\n",
		"stream error":        start + `data: {"type":"error","error":{"type":"overloaded_error","message":"fixture failure"}}` + "\n\n",
		"error after stop":    start + delta + stop + `data: {"type":"error","error":{"message":"late failure"}}` + "\n\n",
		"unknown delta":       start + block + `data: {"type":"content_block_delta","index":0,"delta":{"type":"future_delta","value":"cannot silently drop"}}` + "\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			if got, err := gatherMessages([]byte(stream)); err == nil {
				t.Fatalf("incomplete stream became successful message: %s", got)
			}
		})
	}
}

func TestGatherMessagesFinishKeepsTransportFailures(t *testing.T) {
	whole := []byte(`{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}`)
	stream := messagesGatherStream(anthropicWholeEvents(whole))
	for _, tc := range []struct {
		name, cut, failed string
		status            int
	}{
		{"complete", "", "", 200},
		{"cut", "fixture connection lost", "", 502},
		{"failed", "", "fixture stream failed", 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := &gathered{proto: provider.Anthropic, h: http.Header{"X-Request-Id": []string{"native-request"}}, status: 200}
			g.Write([]byte(stream))
			w := httptest.NewRecorder()
			status, _ := g.finish(w, provider.Provider{Name: "fixture"}, true, tc.cut, tc.failed)
			if status != tc.status || w.Code != tc.status {
				t.Fatalf("status = %d/%d, want %d: %s", status, w.Code, tc.status, w.Body)
			}
			if tc.status == 200 && (w.Header().Get("Content-Type") != "application/json" || w.Header().Get("X-Request-Id") != "native-request") {
				t.Fatalf("JSON headers = %v", w.Header())
			}
		})
	}
}

func TestGatherMessagesWholeReply(t *testing.T) {
	whole := `{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`
	for _, tc := range []struct {
		name, body, cut, failed string
		status                  int
	}{
		{"complete", whole, "", "", 200},
		{"truncated", whole[:len(whole)-1], "", "", 502},
		{"connection lost", whole, "fixture connection lost", "", 502},
		{"vendor error", whole, "", "fixture stream failed", 502},
		{"not a message", `{"type":"error","error":{"message":"failure"}}`, "", "", 502},
		{"missing content", `{"type":"message","stop_reason":"end_turn"}`, "", "", 502},
		{"unfinished", `{"type":"message","content":[],"stop_reason":null}`, "", "", 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := &gathered{proto: provider.Anthropic, h: http.Header{"Content-Type": []string{"text/plain"}}, status: 200}
			g.Write([]byte(tc.body))
			w := httptest.NewRecorder()
			status, _ := g.finish(w, provider.Provider{Name: "fixture"}, false, tc.cut, tc.failed)
			if status != tc.status || w.Code != tc.status {
				t.Fatalf("status = %d/%d, want %d: %s", status, w.Code, tc.status, w.Body)
			}
			if tc.status == 200 && (w.Body.String() != whole || w.Header().Get("Content-Type") != "application/json") {
				t.Fatalf("whole message changed: %s", w.Body)
			}
		})
	}
}
