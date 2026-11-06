// Parses the plain-text .eml files in data/inbox. Headers, a blank line, then the body.

export interface ParsedEmail {
  emailId: string;
  file: string;
  sentAt: string; // ISO, UTC
  fromName: string;
  fromAddress: string;
  fromDomain: string;
  replyTo: string | null;
  subject: string;
  body: string;
}

export function parseEml(file: string, text: string): ParsedEmail {
  const normalized = text.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const headerText = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? '' : normalized.slice(split + 2).replace(/\n+$/, '');
  const headers = new Map<string, string>();
  for (const line of headerText.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const from = parseAddress(headers.get('from') ?? '');
  const replyTo = headers.get('reply-to');
  const base = file.split('/').pop()!;
  return {
    emailId: base.split('-')[0]!,
    file,
    sentAt: new Date(headers.get('date') ?? '').toISOString(),
    fromName: from.name,
    fromAddress: from.address,
    fromDomain: from.address.split('@')[1] ?? '',
    replyTo: replyTo ? parseAddress(replyTo).address : null,
    subject: headers.get('subject') ?? '',
    body,
  };
}

function parseAddress(value: string): { name: string; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (m) return { name: m[1]!.trim(), address: m[2]!.trim().toLowerCase() };
  return { name: '', address: value.trim().toLowerCase() };
}
