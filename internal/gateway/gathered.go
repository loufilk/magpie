package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/yetone/magpie/internal/provider"
)

// gathers is whether a request to p on proto that asked for one body is
// relayed streamed and given back whole (gathered) rather than translated:
// a plugin's account, which only streams, on Responses (plugins#112:
// translating it dropped the tools the vendor runs itself, Grok's x_search,
// so Grok answered without searching, and the response's tools and usage
// details). A subscription magpie signs in to itself (Codex's ChatGPT
// backend, Qoder) is translated as before: its own code fits its requests,
// and no report asks for more. Messages is gathered from its block events,
// so a non-streaming request keeps the same native controls as a stream.
func gathers(p provider.Provider, proto provider.Protocol, body []byte) bool {
	return (proto == provider.Responses || proto == provider.Anthropic) && p.IsPlugin() && p.Account.Stream && !streamOf(body)
}

// gathered holds a relayed native stream that the client asked for whole.
// Responses ends with a whole response; Messages is assembled from blocks.
type gathered struct {
	proto  provider.Protocol
	h      http.Header
	status int
	buf    bytes.Buffer
}

func (g *gathered) Header() http.Header         { return g.h }
func (g *gathered) WriteHeader(status int)      { g.status = status }
func (g *gathered) Write(b []byte) (int, error) { return g.buf.Write(b) }

// finish writes the native reply to w. Messages is assembled by
// gatherMessages; Responses uses response.completed (or response.incomplete),
// its output filled from the stream's items, or else its text, when empty.
// A complete reply that came whole goes as it came. A vendor's error has
// the status it stands for, as on the ungathered path. A malformed or cut
// reply is a 502 (TestNonStreamEndedShort), never an empty 200.
func (g *gathered) finish(w http.ResponseWriter, p provider.Provider, sse bool, cut string, failed string) (int, string) {
	if !sse {
		if status, msg, ok := errorReply(g.buf.Bytes()); ok {
			// A whole 200's policy error stays on its existing path. A
			// new error status would make holdWriter reclassify its code
			// as a stream's filter refusal, which the whole 200 wasn't.
			if _, policy := policyRefusal(g.buf.Bytes()); !policy {
				return writeVendorError(w, g.proto, status, msg, g.buf.Bytes()), msg
			}
		}
		if g.proto == provider.Anthropic {
			msg := failed
			if msg == "" {
				msg = cut
			}
			var message obj
			var content []json.RawMessage
			if msg == "" && (json.Unmarshal(g.buf.Bytes(), &message) != nil || str(message, "type") != "message" ||
				json.Unmarshal(message["content"], &content) != nil || content == nil || str(message, "stop_reason") == "") {
				msg = p.Name + ": invalid whole Messages reply"
			}
			if msg != "" {
				return writeError(w, provider.Anthropic, 502, msg), msg
			}
		}
		for k, vs := range g.h {
			w.Header()[k] = vs
		}
		if g.proto == provider.Anthropic {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(g.status)
		w.Write(g.buf.Bytes())
		return g.status, failed
	}
	if g.proto == provider.Anthropic {
		body, err := gatherMessages(g.buf.Bytes())
		if err != nil || cut != "" || failed != "" {
			msg := failed
			if msg == "" {
				msg = cut
			}
			if msg == "" {
				msg = p.Name + ": " + err.Error()
			}
			return g.streamFailure(w, p, msg)
		}
		for _, k := range []string{"Request-Id", "X-Request-Id"} {
			if v := g.h.Get(k); v != "" {
				w.Header().Set(k, v)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write(body)
		return http.StatusOK, ""
	}
	var resp json.RawMessage
	items := map[int]json.RawMessage{}
	var text strings.Builder // the reply's text, for a stream with no items
	streamErr := ""
	readSSE(bytes.NewReader(g.buf.Bytes()), func(event, data string) error {
		var e struct {
			Type        string          `json:"type"`
			Response    json.RawMessage `json:"response"`
			Item        json.RawMessage `json:"item"`
			OutputIndex int             `json:"output_index"`
			Delta       string          `json:"delta"`
		}
		if json.Unmarshal([]byte(data), &e) != nil {
			return nil
		}
		if e.Type == "" {
			e.Type = event
		}
		switch e.Type {
		case "response.output_text.delta":
			text.WriteString(e.Delta)
		case "response.output_item.done":
			if len(e.Item) > 0 {
				items[e.OutputIndex] = e.Item
			}
		case "response.completed", "response.incomplete":
			resp = e.Response
		case "response.failed", "error":
			streamErr = provider.APIError([]byte(data), "upstream stream failed")
		}
		return nil
	})
	if len(resp) == 0 || resp[0] != '{' {
		msg := failed
		switch {
		case streamErr != "":
			msg = p.Name + ": " + streamErr
		case cut != "":
			msg = cut
		case msg == "":
			msg = p.Name + ": the reply ended before it was complete"
		}
		return g.streamFailure(w, p, msg)
	}
	if len(items) == 0 && text.Len() > 0 {
		msg, _ := json.Marshal(map[string]any{"type": "message", "id": "msg_" + newID(), "role": "assistant", "status": "completed",
			"content": []any{map[string]any{"type": "output_text", "text": text.String(), "annotations": []any{}}}})
		items[0] = msg
	}
	resp = withStreamedOutput(resp, items)
	for _, k := range []string{"Request-Id", "X-Request-Id"} {
		if v := g.h.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(resp)
	return http.StatusOK, ""
}

// streamFailure classifies only an explicit vendor error, using the same
// event reader as a held native stream. Parser/transport diagnostics are
// never classified by their words; without a vendor error they stay 502.
// Read the error object, not just the sniffer's message: its type may say
// it all. The first error wins, as when holdWriter stops its stream.
func (g *gathered) streamFailure(w http.ResponseWriter, p provider.Provider, msg string) (int, string) {
	status := http.StatusBadGateway
	var said []byte
	readSSE(bytes.NewReader(g.buf.Bytes()), func(event, data string) error {
		ev := "event: " + event + "\ndata: " + strings.ReplaceAll(data, "\n", "\ndata: ")
		kind, code, detail := streamEvent([]byte(ev))
		if kind == eventRefusalError {
			status, msg = code, p.Name+": "+detail
			w.Header().Set(refusedHeader, detail)
			_, _, said = filterRefused(data)
			return io.EOF
		}
		if kind != eventError {
			return nil
		}
		status = code
		said = []byte(data)
		if json.Valid([]byte(detail)) {
			// streamEvent's detail is the vendor's error object (including
			// response.failed's nested one), not its response envelope.
			said = []byte(`{"error":` + detail + `}`)
		}
		msg = p.Name + ": " + provider.APIError(said, "upstream stream failed")
		return io.EOF
	})
	return writeVendorError(w, g.proto, status, msg, said), msg
}

// withStreamedOutput is resp with the stream's items as its output when
// its own output is missing or empty.
func withStreamedOutput(resp json.RawMessage, items map[int]json.RawMessage) json.RawMessage {
	if len(items) == 0 {
		return resp
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(resp, &m) != nil {
		return resp
	}
	var out []json.RawMessage
	if json.Unmarshal(m["output"], &out) == nil && len(out) > 0 {
		return resp
	}
	idx := make([]int, 0, len(items))
	for i := range items {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	out = out[:0]
	for _, i := range idx {
		out = append(out, items[i])
	}
	b, err := json.Marshal(out)
	if err != nil {
		return resp
	}
	m["output"] = b
	if nb, err := json.Marshal(m); err == nil {
		return nb
	}
	return resp
}
