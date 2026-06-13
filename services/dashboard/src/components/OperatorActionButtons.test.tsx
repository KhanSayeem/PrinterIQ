import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialLeadActionState, type LeadActionState } from "@/app/actions/lead-actions-core";
import { OperatorActionButtons } from "./OperatorActionButtons";

const tenantId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";

function renderActions(
  actions: Partial<Parameters<typeof OperatorActionButtons>[0]["actions"]> = {},
  props: Partial<Parameters<typeof OperatorActionButtons>[0]> = {},
) {
  const defaultActions = {
    addNote: vi.fn(async (): Promise<LeadActionState> => ({
      ok: true,
      message: "Note saved.",
      conversation: {
        id: "note-1",
        leadId,
        direction: "note",
        channel: "note",
        body: "Called and left voicemail",
        createdAt: new Date("2026-05-27T00:00:00.000Z"),
      },
    })),
    overrideReply: vi.fn(async (): Promise<LeadActionState> => ({
      ok: true,
      message: "Override reply sent.",
      status: "replied",
      conversation: {
        id: "reply-1",
        leadId,
        direction: "outbound",
        channel: "email",
        body: "Happy to send the details.",
        createdAt: new Date("2026-05-27T00:00:00.000Z"),
      },
    })),
    pauseLead: vi.fn(async (): Promise<LeadActionState> => ({
      ok: true,
      message: "Lead paused.",
      status: "archived",
    })),
    ...actions,
  };

  render(
    <OperatorActionButtons
      tenantId={tenantId}
      leadId={leadId}
      initialStatus="contacted"
      score={72}
      actions={defaultActions}
      onConversationCreated={vi.fn()}
      {...props}
    />,
  );

  return defaultActions;
}

describe("OperatorActionButtons", () => {
  it("renders enabled D3 action controls", () => {
    renderActions();

    for (const name of ["Add note", "Override reply", "Pause lead"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
  });

  it("groups full lead actions separately from status and score", () => {
    renderActions();

    const controls = screen.getByRole("group", { name: "Lead actions" });
    expect(controls).toContainElement(screen.getByRole("button", { name: "Add note" }));
    expect(controls).toContainElement(screen.getByRole("button", { name: "Override reply" }));
    expect(controls).toContainElement(screen.getByRole("button", { name: "Pause lead" }));
    expect(controls).not.toContainElement(screen.getByText("contacted"));
    expect(controls).not.toContainElement(screen.getByText("score 72 / 100"));
  });

  it("renders compact labelled controls", () => {
    renderActions({}, { compact: true });

    for (const name of ["note", "reply", "pause"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeEnabled();
      expect(button.textContent).toContain(name);
    }
  });

  it("shows validation from the add-note action", async () => {
    const addNote = vi.fn(async (): Promise<LeadActionState> => ({
      ...initialLeadActionState,
      ok: false,
      message: "Enter a note before saving.",
    }));
    renderActions({ addNote });

    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit note" }));

    expect(await screen.findByText("Enter a note before saving.")).toBeInTheDocument();
  });

  it("appends saved note conversations without a page reload", async () => {
    const defaultActions = renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    fireEvent.change(screen.getByLabelText("Add note"), {
      target: { value: "Called and left voicemail" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit note" }));

    expect(await screen.findByText("Note saved.")).toBeInTheDocument();
    expect(defaultActions.addNote).toHaveBeenCalled();
    const submittedForm = defaultActions.addNote.mock.calls[0]![1] as FormData;
    expect(submittedForm.get("tenantId")).toBe(tenantId);
    expect(submittedForm.get("leadId")).toBe(leadId);
    expect(submittedForm.get("body")).toBe("Called and left voicemail");
  });

  it("sends override replies and updates the visible status badge", async () => {
    const actions = renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Override reply" }));
    fireEvent.change(screen.getByLabelText("Override reply"), {
      target: { value: "Happy to send the details." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit reply" }));

    expect(await screen.findByText("Override reply sent.")).toBeInTheDocument();
    expect(screen.getByText("replied")).toHaveClass("s-replied");
    expect(screen.getByText("score 72 / 100")).toBeInTheDocument();
    const submittedForm = actions.overrideReply.mock.calls[0]![1] as FormData;
    expect(submittedForm.get("tenantId")).toBe(tenantId);
    expect(submittedForm.get("leadId")).toBe(leadId);
  });

  it("shows N/A instead of score-- when the score is missing", () => {
    const defaultActions = {
      addNote: vi.fn(),
      overrideReply: vi.fn(),
      pauseLead: vi.fn(),
    };

    render(
      <OperatorActionButtons
        tenantId={tenantId}
        leadId={leadId}
        initialStatus="contacted"
        score={null}
        actions={defaultActions}
        onConversationCreated={vi.fn()}
      />,
    );

    expect(screen.getByText("score N/A / 100")).toBeInTheDocument();
  });

  it("confirms before pausing and updates the visible status badge", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const actions = renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Pause lead" }));

    await waitFor(() => expect(actions.pauseLead).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledWith("Are you sure? This will stop all automated sends for this lead.");
    const submittedForm = actions.pauseLead.mock.calls[0]![1] as FormData;
    expect(submittedForm.get("tenantId")).toBe(tenantId);
    expect(submittedForm.get("leadId")).toBe(leadId);
    expect(await screen.findByText("Lead paused.")).toBeInTheDocument();
    expect(screen.getByText("archived")).toHaveClass("s-archived");
    confirm.mockRestore();
  });
});
