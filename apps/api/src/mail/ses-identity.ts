import { GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';

let client: SESv2Client | undefined;

/**
 * True when SES lists the address as a verified identity. Uses the ambient AWS
 * credentials; any failure (no credentials, no permission) counts as "unknown".
 */
export async function isSesVerified(email: string): Promise<boolean> {
  try {
    client ??= new SESv2Client({});
    const id = await client.send(new GetEmailIdentityCommand({ EmailIdentity: email }));
    return id.VerifiedForSendingStatus === true;
  } catch {
    return false;
  }
}
