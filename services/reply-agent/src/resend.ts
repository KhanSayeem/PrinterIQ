import { Resend } from "resend";
import type { CheckoutLead } from "./types.js";

export type WelcomeEmailInput = CheckoutLead;

export type WelcomeEmailSender = {
  sendWelcomeEmail(input: WelcomeEmailInput): Promise<void>;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

export async function sendWelcomeEmail(input: WelcomeEmailInput): Promise<void> {
  const resend = new Resend(requiredEnv("RESEND_API_KEY"));
  const from = process.env.RESEND_FROM_EMAIL ?? "PrinterIQ <onboarding@presciaiq.com>";

  await resend.emails.send({
    from,
    to: input.email,
    subject: "Welcome to PrinterIQ",
    text: `Thanks for getting started with PrinterIQ${input.business_name ? ` for ${input.business_name}` : ""}. Macauley will be in touch with the next steps.`,
  });
}

export const resendClient: WelcomeEmailSender = {
  sendWelcomeEmail,
};
