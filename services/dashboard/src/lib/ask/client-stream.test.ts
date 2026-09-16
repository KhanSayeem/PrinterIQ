import { describe, expect, it } from "vitest";

import { createAskEventParser } from "./client-stream";

describe("createAskEventParser", () => {
  it("reads whole events out of one chunk", () => {
    const parser = createAskEventParser();
    const events = parser.push('{"type":"text","text":"hi"}\n{"type":"done","inputTokens":1,"outputTokens":2}\n');

    expect(events).toEqual([
      { type: "text", text: "hi" },
      { type: "done", inputTokens: 1, outputTokens: 2 },
    ]);
  });

  it("holds a line that is split across chunks", () => {
    const parser = createAskEventParser();

    expect(parser.push('{"type":"text","te')).toEqual([]);
    expect(parser.push('xt":"split"}\n')).toEqual([{ type: "text", text: "split" }]);
  });

  it("returns a last line that never got its newline", () => {
    const parser = createAskEventParser();

    expect(parser.push('{"type":"text","text":"tail"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ type: "text", text: "tail" }]);
  });

  it("skips a broken line instead of losing the events around it", () => {
    const parser = createAskEventParser();
    const events = parser.push('{"type":"text","text":"a"}\nnot json\n{"type":"text","text":"b"}\n');

    expect(events).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  it("skips an event type it does not know", () => {
    const parser = createAskEventParser();
    expect(parser.push('{"type":"run_shell","command":"rm -rf /"}\n')).toEqual([]);
  });

  it("keeps tool events, with their id, so a result can find its call", () => {
    const parser = createAskEventParser();
    const events = parser.push(
      '{"type":"tool_start","id":"t1","name":"sends_today","input":{}}\n{"type":"tool_end","id":"t1","failed":false,"output":"{}"}\n',
    );

    expect(events).toEqual([
      { type: "tool_start", id: "t1", name: "sends_today", input: {} },
      { type: "tool_end", id: "t1", failed: false, output: "{}" },
    ]);
  });

  it("flushes nothing when the buffer is empty", () => {
    const parser = createAskEventParser();
    expect(parser.flush()).toEqual([]);
  });
});
