// Builds the final email from the AI content. Change the template here.

import type { EmailContent } from './ai';
import { longDate } from './time';

export interface ComposedEmail {
  subject: string;
  text: string;
  html: string;
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function composeEmail(
  isoDate: string,
  content: EmailContent,
  names: { hrName: string; senderName: string },
): ComposedEmail {
  const day = longDate(isoDate);
  const greeting = names.hrName ? `Hi ${names.hrName},` : 'Hi,';
  const intro = `Here is my daily work update for ${day}:`;

  const text = [
    greeting,
    '',
    intro,
    '',
    ...content.bullets.map((b) => `• ${b}`),
    ...(content.notes ? ['', 'Additional Notes:', content.notes] : []),
    '',
    'Regards,',
    names.senderName,
  ].join('\n');

  const html = [
    `<p>${escape(greeting)}</p>`,
    `<p>${escape(intro)}</p>`,
    `<ul>${content.bullets.map((b) => `<li>${escape(b)}</li>`).join('')}</ul>`,
    content.notes ? `<p><strong>Additional Notes:</strong><br>${escape(content.notes).replace(/\n/g, '<br>')}</p>` : '',
    `<p>Regards,<br>${escape(names.senderName)}</p>`,
  ].join('\n');

  return { subject: `Daily Work Update – ${day}`, text, html };
}
