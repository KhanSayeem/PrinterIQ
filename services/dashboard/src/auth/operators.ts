export function isAuthorizedOperator(user: { email?: string | null }) {
  const allowedEmails = process.env.DASHBOARD_OPERATOR_EMAILS?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return Boolean(allowedEmails?.length && user.email && allowedEmails.includes(user.email.toLowerCase()));
}
