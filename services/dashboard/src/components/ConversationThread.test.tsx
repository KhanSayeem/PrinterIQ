import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./ConversationThread";

describe("ConversationThread", () => {
  it("maps conversation directions to reference styles", () => {
    render(
      <ConversationThread
        now={new Date("2026-05-27T12:00:00.000Z")}
        conversations={[
          { id: "1", direction: "outbound", channel: "email", body: "Sent", createdAt: new Date() },
          { id: "2", direction: "inbound", channel: "email", body: "Reply", createdAt: new Date() },
          { id: "3", direction: "note", channel: "note", body: "Internal", createdAt: new Date() },
        ]}
      />,
    );

    expect(screen.getByText("outbound")).toHaveClass("dir-out");
    expect(screen.getByText("inbound")).toHaveClass("dir-in");
    expect(screen.getByText("note")).toHaveClass("dir-note");
    expect(screen.getAllByText("note")).toHaveLength(1);
  });

  it("shows relative timestamps and confirms before deleting saved notes", () => {
    const onDeleteNote = vi.fn();
    render(
      <ConversationThread
        now={new Date("2026-05-27T12:00:00.000Z")}
        conversations={[
          {
            id: "note-1",
            direction: "note",
            channel: "note",
            body: "Called and left voicemail",
            createdAt: new Date("2026-05-27T10:00:00.000Z"),
          },
        ]}
        onDeleteNote={onDeleteNote}
      />,
    );

    expect(screen.getByText("2 hours ago")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(screen.getByText("Delete this note?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete note" }));
    expect(onDeleteNote).toHaveBeenCalledWith("note-1");
  });
});
