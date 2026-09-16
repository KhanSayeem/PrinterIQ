import { describe, expect, it, vi } from "vitest";
import { createLeadActions, initialLeadActionState } from "./lead-actions-core";

const tenantId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";

function form(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
}

function createDeps() {
  return {
    insertOperatorConversation: vi.fn().mockResolvedValue({
      id: "conversation-id",
      leadId,
      direction: "note",
      channel: "note",
      body: "Operator note",
      createdAt: new Date("2026-05-27T00:00:00.000Z"),
    }),
    updateLeadStatus: vi.fn().mockResolvedValue({ id: leadId, status: "replied" }),
    assertLeadStatusTransitionAllowed: vi.fn().mockResolvedValue({ id: leadId, status: "contacted" }),
    getLatestInstantlyLeadId: vi.fn().mockResolvedValue({
      instantlyLeadId: "instantly-lead-123",
      instantlyCampaignId: "campaign-456",
    }),
    getLatestInstantlyReplyMetadata: vi.fn().mockResolvedValue({
      instantlyEmailId: "email-uuid-123",
      instantlyAccountId: "sender@printeriq.com",
    }),
    deleteOperatorNote: vi.fn().mockResolvedValue({ id: "note-1" }),
    instantly: {
      pauseLead: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockResolvedValue(undefined),
      getEmailSubject: vi.fn().mockResolvedValue("A new website for Enlightening Education"),
    },
    revalidatePath: vi.fn(),
  };
}

describe("lead actions", () => {
  it("rejects empty note bodies before inserting", async () => {
    const deps = createDeps();
    const actions = createLeadActions(deps);

    const result = await actions.addNote(initialLeadActionState, form({ tenantId, leadId, body: "   " }));

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Enter a note before saving.");
    expect(deps.insertOperatorConversation).not.toHaveBeenCalled();
  });

  it("adds an operator note conversation", async () => {
    const deps = createDeps();
    const actions = createLeadActions(deps);

    const result = await actions.addNote(initialLeadActionState, form({ tenantId, leadId, body: "Operator note" }));

    expect(deps.insertOperatorConversation).toHaveBeenCalledWith({
      tenantId,
      leadId,
      direction: "note",
      channel: "note",
      body: "Operator note",
    });
    expect(deps.revalidatePath).toHaveBeenCalledWith(`/leads/${leadId}`);
    expect(result).toMatchObject({
      ok: true,
      message: "Note saved.",
      conversation: expect.objectContaining({ body: "Operator note" }),
    });
  });

  it("pauses a lead through Instantly and archives the lead badge state", async () => {
    const deps = createDeps();
    const actions = createLeadActions(deps);

    const result = await actions.pauseLead(initialLeadActionState, form({ tenantId, leadId }));

    expect(deps.getLatestInstantlyLeadId).toHaveBeenCalledWith({ tenantId, leadId });
    expect(deps.assertLeadStatusTransitionAllowed).toHaveBeenCalledWith({ tenantId, leadId, status: "archived" });
    expect(deps.instantly.pauseLead).toHaveBeenCalledWith("instantly-lead-123", "campaign-456");
    expect(deps.updateLeadStatus).toHaveBeenCalledWith({ tenantId, leadId, status: "archived" });
    expect(result).toMatchObject({
      ok: true,
      message: "Lead paused.",
      status: "archived",
    });
  });

  it("returns a graceful pause error when the lead has not been sent to Instantly", async () => {
    const deps = createDeps();
    deps.getLatestInstantlyLeadId.mockRejectedValueOnce(new Error("Instantly lead id not found for lead"));
    const actions = createLeadActions(deps);

    const result = await actions.pauseLead(initialLeadActionState, form({ tenantId, leadId }));

    expect(deps.instantly.pauseLead).not.toHaveBeenCalled();
    expect(deps.updateLeadStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message: "This lead has not been sent to Instantly yet and cannot be paused.",
    });
  });

  it("sends an override reply through Instantly and records the outbound conversation", async () => {
    const deps = createDeps();
    deps.insertOperatorConversation.mockResolvedValueOnce({
      id: "conversation-id",
      leadId,
      direction: "outbound",
      channel: "email",
      body: "Happy to send the details.",
      createdAt: new Date("2026-05-27T00:00:00.000Z"),
    });
    const actions = createLeadActions(deps);

    const result = await actions.overrideReply(
      initialLeadActionState,
      form({ tenantId, leadId, body: "Happy to send the details." }),
    );

    expect(deps.getLatestInstantlyReplyMetadata).toHaveBeenCalledWith({ tenantId, leadId });
    expect(deps.assertLeadStatusTransitionAllowed).toHaveBeenCalledWith({ tenantId, leadId, status: "replied" });
    expect(deps.instantly.sendReply).toHaveBeenCalledWith({
      instantlyEmailId: "email-uuid-123",
      instantlyAccountId: "sender@printeriq.com",
      subject: "Re: A new website for Enlightening Education",
      body: "Happy to send the details.",
    });
    expect(deps.insertOperatorConversation).toHaveBeenCalledWith({
      tenantId,
      leadId,
      direction: "outbound",
      channel: "email",
      body: "Happy to send the details.",
    });
    expect(deps.updateLeadStatus).toHaveBeenCalledWith({ tenantId, leadId, status: "replied" });
    expect(result).toMatchObject({
      ok: true,
      message: "Override reply sent.",
      status: "replied",
      conversation: expect.objectContaining({ direction: "outbound" }),
    });
  });

  it("checks reply eligibility before sending through Instantly", async () => {
    const deps = createDeps();
    deps.assertLeadStatusTransitionAllowed.mockRejectedValueOnce(new Error("Lead is not eligible for replied"));
    const actions = createLeadActions(deps);

    await expect(
      actions.overrideReply(initialLeadActionState, form({ tenantId, leadId, body: "Happy to send the details." })),
    ).rejects.toThrow("Lead is not eligible for replied");

    expect(deps.instantly.sendReply).not.toHaveBeenCalled();
    expect(deps.insertOperatorConversation).not.toHaveBeenCalled();
  });

  it("returns a graceful override reply error when no Instantly reply metadata exists", async () => {
    const deps = createDeps();
    deps.getLatestInstantlyReplyMetadata.mockRejectedValueOnce(new Error("Instantly reply metadata not found for lead"));
    const actions = createLeadActions(deps);

    const result = await actions.overrideReply(
      initialLeadActionState,
      form({ tenantId, leadId, body: "Happy to send the details." }),
    );

    expect(result).toEqual({
      ok: false,
      message: "This lead does not have an inbound Instantly reply thread yet.",
    });
    expect(deps.instantly.sendReply).not.toHaveBeenCalled();
    expect(deps.insertOperatorConversation).not.toHaveBeenCalled();
  });

  it("returns a graceful override reply error when Instantly is not configured", async () => {
    const deps = createDeps();
    deps.instantly.sendReply.mockRejectedValueOnce(new Error("Missing env var: INSTANTLY_API_KEY"));
    const actions = createLeadActions(deps);

    const result = await actions.overrideReply(
      initialLeadActionState,
      form({ tenantId, leadId, body: "Happy to send the details." }),
    );

    expect(result).toEqual({
      ok: false,
      message: "Instantly is not configured for dashboard replies.",
    });
    expect(deps.insertOperatorConversation).not.toHaveBeenCalled();
    expect(deps.updateLeadStatus).not.toHaveBeenCalled();
  });

  it("checks pause eligibility before pausing through Instantly", async () => {
    const deps = createDeps();
    deps.assertLeadStatusTransitionAllowed.mockRejectedValueOnce(new Error("Lead is not eligible for archived"));
    const actions = createLeadActions(deps);

    await expect(actions.pauseLead(initialLeadActionState, form({ tenantId, leadId }))).rejects.toThrow(
      "Lead is not eligible for archived",
    );

    expect(deps.instantly.pauseLead).not.toHaveBeenCalled();
    expect(deps.updateLeadStatus).not.toHaveBeenCalled();
  });

  it("deletes an operator note through a tenant-scoped action", async () => {
    const deps = createDeps();
    const actions = createLeadActions(deps);

    const result = await actions.deleteNote(
      initialLeadActionState,
      form({ tenantId, leadId, conversationId: "note-1" }),
    );

    expect(deps.deleteOperatorNote).toHaveBeenCalledWith({
      tenantId,
      leadId,
      conversationId: "note-1",
    });
    expect(result).toEqual({ ok: true, message: "Note deleted.", deletedConversationId: "note-1" });
  });
});

describe("overrideReply subject", () => {
  /**
   * Instantly answers `400 body must have required property 'subject'` when a
   * reply carries no subject, and this action used to hard code null, so every
   * override reply would have failed in production.
   */
  it("prefixes the thread's subject once", async () => {
    const deps = createDeps();
    deps.instantly.getEmailSubject = vi.fn().mockResolvedValue("Re: A new website for Acme");

    await createLeadActions(deps).overrideReply(
      initialLeadActionState,
      form({ tenantId, leadId, body: "Sounds good." }),
    );

    expect(deps.instantly.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Re: A new website for Acme" }),
    );
  });

  it("refuses to send, rather than sending a reply Instantly will reject", async () => {
    const deps = createDeps();
    deps.instantly.getEmailSubject = vi.fn().mockResolvedValue(null);

    const result = await createLeadActions(deps).overrideReply(
      initialLeadActionState,
      form({ tenantId, leadId, body: "Sounds good." }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not read the subject/i);
    expect(deps.instantly.sendReply).not.toHaveBeenCalled();
    expect(deps.insertOperatorConversation).not.toHaveBeenCalled();
  });

  it("does not record an outbound reply that was never sent", async () => {
    const deps = createDeps();
    deps.instantly.getEmailSubject = vi.fn().mockRejectedValue(new Error("Instantly is down"));

    const result = await createLeadActions(deps).overrideReply(
      initialLeadActionState,
      form({ tenantId, leadId, body: "Sounds good." }),
    );

    expect(result.ok).toBe(false);
    expect(deps.insertOperatorConversation).not.toHaveBeenCalled();
    expect(deps.updateLeadStatus).not.toHaveBeenCalled();
  });
});
