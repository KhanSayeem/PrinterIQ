const displayNameKeys = ["full_name", "name", "display_name"] as const;

export type OperatorIdentity = {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

function metadataDisplayName(user: OperatorIdentity) {
  const metadata = user.user_metadata;
  if (!metadata) return null;

  for (const key of displayNameKeys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function nameFromEmail(email: string) {
  const localPart = email.split("@")[0] ?? "";
  const words = localPart
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  return words.length ? words.join(" ") : email;
}

/**
 * Supabase sessions do not always carry a display name, so fall back to a name
 * derived from the signed-in email instead of showing a fixed operator name.
 */
export function operatorDisplayName(user: OperatorIdentity) {
  const fromMetadata = metadataDisplayName(user);
  if (fromMetadata) return fromMetadata;

  const email = user.email?.trim();
  return email ? nameFromEmail(email) : "Operator";
}

export function operatorInitials(displayName: string) {
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

  return initials || "?";
}
