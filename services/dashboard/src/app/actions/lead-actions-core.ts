import type {
  getLatestInstantlyLeadId,
  getLatestInstantlyReplyMetadata,
  updateLeadStatus,
  assertLeadStatusTransitionAllowed,
  DeleteOperatorNoteInput,
  OperatorConversationInput,
} from "@/db/queries";

type ConversationResult = {
  id: string;
  leadId: string;
  direction: string;
  channel: string;
  body: string;
  createdAt: Date | string;
};

export type LeadActionState = {
  ok: boolean;
  message: string;
  status?: string;
  conversation?: ConversationResult;
  deletedConversationId?: string;
};

export type LeadActionDeps = {
  insertOperatorConversation: (input: OperatorConversationInput) => Promise<ConversationResult>;
  updateLeadStatus: typeof updateLeadStatus;
  assertLeadStatusTransitionAllowed: typeof assertLeadStatusTransitionAllowed;
  getLatestInstantlyLeadId: typeof getLatestInstantlyLeadId;
  getLatestInstantlyReplyMetadata: typeof getLatestInstantlyReplyMetadata;
  deleteOperatorNote: (input: DeleteOperatorNoteInput) => Promise<{ id: string }>;
  instantly: {
    pauseLead(instantlyLeadId: string, instantlyCampaignId: string): Promise<void>;
    sendReply(input: {
      instantlyEmailId: string;
      instantlyAccountId: string;
      subject?: string | null;
      body: string;
    }): Promise<void>;
  };
  revalidatePath: (path: string) => void;
};

export const initialLeadActionState: LeadActionState = {
  ok: false,
  message: "",
};

function readRequired(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readIdentity(formData: FormData) {
  const tenantId = readRequired(formData, "tenantId");
  const leadId = readRequired(formData, "leadId");
  if (!tenantId || !leadId) {
    throw new Error("Missing lead identity");
  }
  return { tenantId, leadId };
}

function readConversationIdentity(formData: FormData) {
  const identity = readIdentity(formData);
  const conversationId = readRequired(formData, "conversationId");
  if (!conversationId) {
    throw new Error("Missing conversation identity");
  }
  return { ...identity, conversationId };
}

function isErrorMessage(error: unknown, message: string) {
  return error instanceof Error && error.message === message;
}

export function createLeadActions(deps: LeadActionDeps) {
  return {
    async addNote(_previousState: LeadActionState, formData: FormData): Promise<LeadActionState> {
      const identity = readIdentity(formData);
      const body = readRequired(formData, "body");

      if (!body) {
        return { ok: false, message: "Enter a note before saving." };
      }

      const conversation = await deps.insertOperatorConversation({
        ...identity,
        direction: "note",
        channel: "note",
        body,
      });
      deps.revalidatePath(`/leads/${identity.leadId}`);

      return { ok: true, message: "Note saved.", conversation };
    },

    async overrideReply(_previousState: LeadActionState, formData: FormData): Promise<LeadActionState> {
      const identity = readIdentity(formData);
      const body = readRequired(formData, "body");

      if (!body) {
        return { ok: false, message: "Enter a reply before sending." };
      }

      await deps.assertLeadStatusTransitionAllowed({ ...identity, status: "replied" });

      let metadata: Awaited<ReturnType<typeof deps.getLatestInstantlyReplyMetadata>>;
      try {
        metadata = await deps.getLatestInstantlyReplyMetadata(identity);
      } catch (error) {
        if (isErrorMessage(error, "Instantly reply metadata not found for lead")) {
          return { ok: false, message: "This lead does not have an inbound Instantly reply thread yet." };
        }
        throw error;
      }

      try {
        await deps.instantly.sendReply({
          ...metadata,
          subject: null,
          body,
        });
      } catch (error) {
        if (isErrorMessage(error, "Missing env var: INSTANTLY_API_KEY")) {
          return { ok: false, message: "Instantly is not configured for dashboard replies." };
        }
        throw error;
      }
      const conversation = await deps.insertOperatorConversation({
        ...identity,
        direction: "outbound",
        channel: "email",
        body,
      });
      await deps.updateLeadStatus({ ...identity, status: "replied" });
      deps.revalidatePath(`/leads/${identity.leadId}`);

      return { ok: true, message: "Override reply sent.", status: "replied", conversation };
    },

    async pauseLead(_previousState: LeadActionState, formData: FormData): Promise<LeadActionState> {
      const identity = readIdentity(formData);
      try {
        const { instantlyLeadId, instantlyCampaignId } = await deps.getLatestInstantlyLeadId(identity);

        await deps.assertLeadStatusTransitionAllowed({ ...identity, status: "archived" });
        await deps.instantly.pauseLead(instantlyLeadId, instantlyCampaignId);
        await deps.updateLeadStatus({ ...identity, status: "archived" });
        deps.revalidatePath(`/leads/${identity.leadId}`);

        return { ok: true, message: "Lead paused.", status: "archived" };
      } catch (error) {
        if (error instanceof Error && error.message === "Instantly lead id not found for lead") {
          return {
            ok: false,
            message: "This lead has not been sent to Instantly yet and cannot be paused.",
          };
        }
        throw error;
      }
    },

    async deleteNote(_previousState: LeadActionState, formData: FormData): Promise<LeadActionState> {
      const identity = readConversationIdentity(formData);
      const deleted = await deps.deleteOperatorNote(identity);
      deps.revalidatePath(`/leads/${identity.leadId}`);

      return { ok: true, message: "Note deleted.", deletedConversationId: deleted.id };
    },
  };
}
