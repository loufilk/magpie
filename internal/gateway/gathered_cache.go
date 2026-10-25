package gateway

import (
	"bytes"
	"encoding/json"
)

// gatheredMessageCache keeps the translator's default cache boundaries when
// native Messages is gathered instead. A caller's cache choices always win,
// including null or unrecognized values; the plugin owns their validation.
// At most two marks are added: system (or tools), then the final message.
func gatheredMessageCache(body []byte) []byte {
	var q obj
	var messages, tools []obj
	if json.Unmarshal(body, &q) != nil || q == nil {
		return body
	}
	if _, set := q["cache_control"]; set {
		return body
	}
	system, ok := gatheredCacheBlocks(q["system"])
	if !ok || json.Unmarshal(q["messages"], &messages) != nil || len(messages) == 0 {
		return body
	}
	if b := q["tools"]; len(b) > 0 && json.Unmarshal(b, &tools) != nil {
		return body
	}
	if gatheredCacheChoices(system) || gatheredCacheChoices(tools) || gatheredCacheChoices(messages) {
		return body
	}
	contents := make([][]obj, len(messages))
	for i, message := range messages {
		if message == nil {
			return body
		}
		content, present := message["content"]
		if !present || bytes.Equal(bytes.TrimSpace(content), []byte("null")) {
			return body
		}
		contents[i], ok = gatheredCacheBlocks(content)
		if !ok || gatheredCacheChoices(contents[i]) {
			return body
		}
	}
	for _, tool := range tools {
		if tool == nil {
			return body
		}
	}
	changed := false
	for i := len(system) - 1; i >= 0; i-- {
		if str(system[i], "type") == "text" && str(system[i], "text") != "" {
			system[i]["cache_control"] = raw(ephemeral)
			q["system"] = raw(system)
			changed = true
			break
		}
	}
	if !changed {
		for i := len(tools) - 1; i >= 0; i-- {
			tool := tools[i]
			kind := str(tool, "type")
			if str(tool, "name") != "" && (kind == "" || kind == "custom" || len(tool["input_schema"]) > 0) {
				tool["cache_control"] = raw(ephemeral)
				q["tools"] = raw(tools)
				changed = true
				break
			}
		}
	}
	last := contents[len(contents)-1]
	for i := len(last) - 1; i >= 0; i-- {
		block := last[i]
		switch str(block, "type") {
		case "text":
			if str(block, "text") == "" {
				continue
			}
		case "image", "tool_use", "tool_result":
		default:
			// Thinking cannot be marked. Unknown native blocks keep their
			// bytes and are not assigned semantics by this fallback.
			continue
		}
		block["cache_control"] = raw(ephemeral)
		messages[len(messages)-1]["content"] = raw(last)
		q["messages"] = raw(messages)
		changed = true
		break
	}
	if !changed {
		return body
	}
	out, err := json.Marshal(q)
	if err != nil {
		return body
	}
	return out
}

// gatheredCacheBlocks reads only protocol containers, not tool arguments or
// schemas whose business data may also name cache_control. String content is
// wrapped only if a mark is actually added; empty and null values stay as sent.
func gatheredCacheBlocks(b json.RawMessage) ([]obj, bool) {
	if len(b) == 0 || bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		return nil, true
	}
	var text string
	if json.Unmarshal(b, &text) == nil {
		return []obj{{"type": raw("text"), "text": b}}, true
	}
	var blocks []obj
	if json.Unmarshal(b, &blocks) != nil {
		return nil, false
	}
	for _, block := range blocks {
		if block == nil {
			return nil, false
		}
	}
	return blocks, true
}

// gatheredCacheChoices is conservative around explicit controls and malformed
// nested protocol containers. Only known content containers are inspected;
// schemas, tool inputs and opaque fields are never mistaken for cache marks.
func gatheredCacheChoices(blocks []obj) bool {
	for _, block := range blocks {
		if _, set := block["cache_control"]; set {
			return true
		}
		var nested json.RawMessage
		required := false
		switch str(block, "type") {
		case "tool_result":
			nested = block["content"]
		case "search_result":
			nested, required = block["content"], true
			if b := bytes.TrimSpace(nested); len(b) == 0 || b[0] != '[' {
				return true
			}
		case "document":
			var source obj
			if json.Unmarshal(block["source"], &source) != nil || source == nil {
				return true
			}
			if str(source, "type") != "content" {
				continue
			}
			nested, required = source["content"], true
		default:
			continue
		}
		if (required && len(nested) == 0) || bytes.Equal(bytes.TrimSpace(nested), []byte("null")) {
			return true
		}
		contents, ok := gatheredCacheBlocks(nested)
		if !ok || gatheredCacheChoices(contents) {
			return true
		}
	}
	return false
}
