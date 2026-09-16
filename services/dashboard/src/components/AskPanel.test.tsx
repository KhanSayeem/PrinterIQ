import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AskPanel } from "./AskPanel";

/** One NDJSON stream, the way the route sends it. */
function streamOf(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

function ask(question: string) {
  fireEvent.click(screen.getByRole("button", { name: "Ask about the pipeline" }));
  const input = screen.getByLabelText("Ask a question");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AskPanel", () => {
  it("stays shut until it is opened", () => {
    render(<AskPanel />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ask about the pipeline" }));
    expect(screen.getByRole("dialog", { name: "Ask about the pipeline" })).toBeTruthy();
  });

  it("says on the panel that it can only read", () => {
    render(<AskPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Ask about the pipeline" }));

    expect(screen.getByText(/cannot send or change anything/i)).toBeTruthy();
  });

  it("opens with questions it can answer", () => {
    render(<AskPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Ask about the pipeline" }));

    expect(screen.getByText("Is anything broken right now?")).toBeTruthy();
  });

  it("shows the answer and the read behind it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamOf([
          JSON.stringify({ type: "conversation", conversationId: "c1" }),
          JSON.stringify({ type: "tool_start", id: "t1", name: "sends_today", input: {} }),
          JSON.stringify({ type: "tool_end", id: "t1", failed: false, output: '{"sent":30}' }),
          JSON.stringify({ type: "text", text: "30 emails went out today." }),
          JSON.stringify({ type: "done", inputTokens: 10, outputTokens: 5 }),
        ]),
      ),
    );

    render(<AskPanel />);
    ask("how many today?");

    await waitFor(() => {
      expect(screen.getByText("30 emails went out today.")).toBeTruthy();
    });
    expect(screen.getByText("sends_today")).toBeTruthy();
  });

  it("shows a failed read as not available rather than dropping it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamOf([
          JSON.stringify({ type: "tool_start", id: "t1", name: "sending_accounts", input: {} }),
          JSON.stringify({
            type: "tool_end",
            id: "t1",
            failed: true,
            output: "not available: INSTANTLY_API_KEY is not configured",
          }),
          JSON.stringify({ type: "text", text: "I could not read mailbox health." }),
          JSON.stringify({ type: "done", inputTokens: 10, outputTokens: 5 }),
        ]),
      ),
    );

    render(<AskPanel />);
    ask("are the mailboxes ok?");

    await waitFor(() => {
      expect(screen.getByText(/INSTANTLY_API_KEY is not configured/)).toBeTruthy();
    });
  });

  it("surfaces a request that never got started", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured" }), {
            status: 500,
          }),
        ),
    );

    render(<AskPanel />);
    ask("anything broken?");

    await waitFor(() => {
      expect(screen.getByText(/ANTHROPIC_API_KEY is not configured/)).toBeTruthy();
    });
  });

  it("carries the question, the conversation and the thread to the route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamOf([
        JSON.stringify({ type: "conversation", conversationId: "c1" }),
        JSON.stringify({ type: "text", text: "yes" }),
        JSON.stringify({ type: "done", inputTokens: 1, outputTokens: 1 }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AskPanel />);
    ask("first question");

    await waitFor(() => {
      expect(screen.getByText("yes")).toBeTruthy();
    });

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(firstBody.question).toBe("first question");
    expect(firstBody.conversationId).toBeNull();
    expect(firstBody.history).toEqual([]);

    const input = screen.getByLabelText("Ask a question");
    fireEvent.change(input, { target: { value: "and now?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.conversationId).toBe("c1");
    expect(secondBody.history).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "yes" },
    ]);
  });
});
