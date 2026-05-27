import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationThread } from "./ConversationThread";

describe("ConversationThread", () => {
  it("maps conversation directions to reference styles", () => {
    render(
      <ConversationThread
        conversations={[
          { id: "1", direction: "outbound", channel: "email", body: "Sent", createdAt: new Date() },
          { id: "2", direction: "inbound", channel: "email", body: "Reply", createdAt: new Date() },
          { id: "3", direction: "note", channel: "note", body: "Internal", createdAt: new Date() },
        ]}
      />,
    );

    expect(screen.getByText("outbound")).toHaveClass("dir-out");
    expect(screen.getByText("inbound")).toHaveClass("dir-in");
    expect(screen.getAllByText("note")[0]).toHaveClass("dir-note");
  });
});
