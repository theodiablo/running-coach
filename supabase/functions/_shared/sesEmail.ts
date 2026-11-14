// Plain-text mail to the maintainer through our SES identity (infra/ses_sending.tf). Deno only.

import { AwsClient } from "npm:aws4fetch@1.0.20";

const MAINTAINER_EMAIL = Deno.env.get("MAINTAINER_EMAIL") ?? "theo.camboulive.dev@gmail.com";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "Running Coach <noreply@camboulive.solutions>";
const SES_REGION = Deno.env.get("SES_REGION") ?? "eu-west-1";
const CONFIG_SET = Deno.env.get("SES_CONFIG_SET") ?? "runapp-notify";

const SES_ACCESS_KEY_ID = Deno.env.get("SES_AWS_ACCESS_KEY_ID");
const SES_SECRET_ACCESS_KEY = Deno.env.get("SES_AWS_SECRET_ACCESS_KEY");
const aws = SES_ACCESS_KEY_ID && SES_SECRET_ACCESS_KEY
  ? new AwsClient({
      accessKeyId: SES_ACCESS_KEY_ID,
      secretAccessKey: SES_SECRET_ACCESS_KEY,
      region: SES_REGION,
      service: "ses",
    })
  : null;

export const canSendEmail = () => aws !== null;

export async function emailMaintainer(subject: string, text: string): Promise<boolean> {
  if (!aws) return false;
  const res = await aws.fetch(`https://email.${SES_REGION}.amazonaws.com/v2/email/outbound-emails`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      FromEmailAddress: FROM_EMAIL,
      Destination: { ToAddresses: [MAINTAINER_EMAIL] },
      ConfigurationSetName: CONFIG_SET,
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Text: { Data: text, Charset: "UTF-8" } },
        },
      },
    }),
  });
  if (!res.ok) console.error("ses failed", res.status, await res.text());
  return res.ok;
}
