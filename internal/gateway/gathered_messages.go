package gateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// gatheredThinkingNeeded is the explicit refusal of a Messages stream that
// started no blocks. Native thinking and opaque output are kept conservative:
// a block isn't empty just because the translator doesn't know it.
// The first error decides, as it does in gathered.streamFailure.
func gatheredThinkingNeeded(body []byte) bool {
	seen, needed := false, false
	err := readSSE(bytes.NewReader(body), func(event, data string) error {
		var e struct {
			Type    string `json:"type"`
			Message obj    `json:"message"`
		}
		if json.Unmarshal([]byte(data), &e) != nil {
			return io.EOF
		}
		if e.Type == "" {
			e.Type = event
		}
		switch e.Type {
		case "error":
			ev := "event: " + event + "\ndata: " + strings.ReplaceAll(data, "\n", "\ndata: ")
			kind, _, detail := streamEvent([]byte(ev))
			if kind != eventError {
				return io.EOF // a policy refusal isn't a request to enable thinking
			}
			if !seen {
				needed = thinkingNeededRefusal.Match(wordsOf([]byte(detail)))
				seen = true
			}
		case "ping":
		case "message_start":
			var content []json.RawMessage
			if seen || str(e.Message, "type") != "message" || json.Unmarshal(e.Message["content"], &content) != nil || len(content) != 0 {
				return io.EOF
			}
		default:
			return io.EOF
		}
		return nil
	})
	return err == nil && needed
}

// gatherMessages assembles a native Messages stream without translating its
// request or its reply blocks through the cross-protocol representation.
func gatherMessages(body []byte) ([]byte, error) {
	var message obj
	blocks := map[int]*gatheredMessageBlock{}
	ended, deltaSeen := false, false
	err := readSSE(bytes.NewReader(body), func(event, data string) error {
		var e struct {
			Type         string `json:"type"`
			Index        *int   `json:"index"`
			Message      obj    `json:"message"`
			ContentBlock obj    `json:"content_block"`
			Delta        obj    `json:"delta"`
			Usage        obj    `json:"usage"`
		}
		if err := json.Unmarshal([]byte(data), &e); err != nil {
			return fmt.Errorf("invalid Messages stream event: %w", err)
		}
		if e.Type == "" {
			e.Type = event
		}
		if e.Type == "ping" {
			return nil
		}
		if e.Type == "error" {
			return fmt.Errorf("Messages stream failed: %s", data)
		}
		if ended {
			return fmt.Errorf("Messages stream continued after message_stop")
		}
		switch e.Type {
		case "message_start":
			if message != nil || e.Message == nil || str(e.Message, "type") != "message" {
				return fmt.Errorf("invalid Messages message_start")
			}
			message = e.Message
		case "content_block_start", "content_block_delta", "content_block_stop":
			if message == nil || e.Index == nil || *e.Index < 0 {
				return fmt.Errorf("Messages block has no message or index")
			}
			i := *e.Index
			b := blocks[i]
			if e.Type == "content_block_start" {
				if b != nil || e.ContentBlock == nil {
					return fmt.Errorf("invalid Messages block start at %d", i)
				}
				blocks[i] = &gatheredMessageBlock{body: e.ContentBlock, text: map[string]*strings.Builder{}}
				return nil
			}
			if b == nil || b.closed {
				return fmt.Errorf("Messages delta or stop has no open block at %d", i)
			}
			if e.Type == "content_block_delta" {
				return b.delta(e.Delta)
			}
			if b.input.Len() > 0 {
				input := []byte(b.input.String())
				if !json.Valid(input) {
					return fmt.Errorf("invalid Messages tool input at %d", i)
				}
				b.body["input"] = input
			}
			for k, text := range b.text {
				b.body[k] = raw(text.String())
			}
			b.closed = true
		case "message_delta":
			if message == nil || e.Delta == nil {
				return fmt.Errorf("Messages message_delta has no message or delta")
			}
			for k, v := range e.Delta {
				message[k] = v
			}
			if e.Usage != nil {
				var usage obj
				if b := message["usage"]; b != nil && json.Unmarshal(b, &usage) != nil {
					return fmt.Errorf("invalid Messages usage")
				}
				if usage == nil {
					usage = obj{}
				}
				for k, v := range e.Usage {
					usage[k] = v
				}
				message["usage"] = raw(usage)
			}
			deltaSeen = true
		case "message_stop":
			if message == nil || !deltaSeen || str(message, "stop_reason") == "" {
				return fmt.Errorf("Messages stream stopped before its final delta")
			}
			ended = true
		default:
			return fmt.Errorf("unsupported Messages stream event %q", e.Type)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !ended {
		return nil, fmt.Errorf("Messages reply ended before message_stop")
	}
	content := make([]obj, 0, len(blocks))
	for i := 0; i < len(blocks); i++ {
		b := blocks[i]
		if b == nil || !b.closed {
			return nil, fmt.Errorf("Messages reply has an unfinished block at %d", i)
		}
		content = append(content, b.body)
	}
	message["content"] = raw(content)
	return json.Marshal(message)
}

type gatheredMessageBlock struct {
	body   obj
	text   map[string]*strings.Builder
	input  strings.Builder
	closed bool
}

func (b *gatheredMessageBlock) delta(d obj) error {
	field := ""
	switch str(d, "type") {
	case "text_delta":
		field = "text"
	case "thinking_delta":
		field = "thinking"
	case "signature_delta":
		field = "signature"
	case "input_json_delta":
		var part string
		if err := json.Unmarshal(d["partial_json"], &part); err != nil {
			return fmt.Errorf("invalid Messages tool input delta: %w", err)
		}
		b.input.WriteString(part)
		return nil
	case "citations_delta":
		var citations []json.RawMessage
		if c := b.body["citations"]; c != nil && json.Unmarshal(c, &citations) != nil {
			return fmt.Errorf("invalid Messages citations")
		}
		if d["citation"] == nil {
			return fmt.Errorf("Messages citation delta has no citation")
		}
		b.body["citations"] = raw(append(citations, d["citation"]))
		return nil
	default:
		return fmt.Errorf("unsupported Messages block delta %q", str(d, "type"))
	}
	var part string
	if err := json.Unmarshal(d[field], &part); err != nil {
		return fmt.Errorf("invalid Messages %s delta: %w", field, err)
	}
	if b.text[field] == nil {
		var initial string
		if v := b.body[field]; v != nil && json.Unmarshal(v, &initial) != nil {
			return fmt.Errorf("invalid Messages %s block", field)
		}
		b.text[field] = &strings.Builder{}
		b.text[field].WriteString(initial)
	}
	b.text[field].WriteString(part)
	return nil
}
