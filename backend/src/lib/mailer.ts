import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Mailer } from './http';

/** Sends plain-text email through SES v2 in the Lambda's own region. */
export class SesMailer implements Mailer {
  private readonly client = new SESv2Client({});

  async send({ from, to, replyTo, subject, text }: Parameters<Mailer['send']>[0]): Promise<void> {
    await this.client.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      ReplyToAddresses: [replyTo],
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' } },
        },
      },
    }));
  }
}
