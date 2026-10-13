import PostalMime from "postal-mime";
import { getInboxByAddress, insertMessage } from "./store";

const BODY_CAP = 256 * 1024;

// Extract the Subject from RFC822 headers of a raw mail string.
function extractSubject(raw: string): string | null {
  const crlf = raw.indexOf("\r\n\r\n");
  const sep = crlf === -1 ? raw.indexOf("\n\n") : crlf;
  if (sep === -1) return null;
  const headers = crlf === -1 ? raw.slice(0, sep) : raw.slice(0, crlf);
  // Unfold RFC 5322 folded headers: continuation lines (leading SP/HTAB)
  // are appended to the preceding header line before matching.
  const unfolded: string[] = [];
  for (const line of headers.split(/\r?\n/)) {
    if (line.length > 0 && (line[0] === " " || line[0] === "\t")) {
      if (unfolded.length > 0) unfolded[unfolded.length - 1] += line;
      continue;
    }
    unfolded.push(line);
  }
  for (const line of unfolded) {
    if (/^subject:/i.test(line)) {
      return line.replace(/^subject:/i, "").trim();
    }
  }
  return null;
}

export async function handleEmail(
  message: { from: string; to: string; raw: ReadableStream },
  env: Env,
  now: number,
): Promise<void> {
  try {
    const inbox = await getInboxByAddress(env.DB, (message.to || "").toLowerCase());
    if (!inbox || inbox.expires_at <= now) return; // silent drop: unknown or expired
    let subject: string | null = null;
    let text: string | null = null;
    let html: string | null = null;

    // Buffer the raw stream once so it can be reused for both parsing and fallback.
    const reader = message.raw.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      chunks.push(value!);
    }
    const decoder = new TextDecoder();
    let rawStr = "";
    for (const c of chunks) rawStr += decoder.decode(c, { stream: true });
    rawStr += decoder.decode();

    try {
      const parsed = await PostalMime.parse(rawStr);
      subject = parsed.subject ?? null;
      text = parsed.text ?? null;
      html = parsed.html ?? null;
    } catch {
      // Parser threw: use header-sourced subject + raw body as text.
      subject = subject ?? extractSubject(rawStr);
    }
    // Best-effort: if parsing produced no text, fall back to the raw body
    // (everything after the header/body separator). Never lose the mail.
    if (text === null) {
      const sepCrlf = rawStr.indexOf("\r\n\r\n");
      const sepLf = rawStr.indexOf("\n\n");
      const sep = sepCrlf !== -1 ? sepCrlf : sepLf;
      const bodyStart = sepCrlf !== -1 ? sepCrlf + 4 : sepLf !== -1 ? sepLf + 2 : 0;
      text = sep !== -1 ? rawStr.slice(bodyStart) : rawStr;
      if (!text) text = "";
    }

    let truncated = 0;
    if (text && text.length > BODY_CAP) {
      text = text.slice(0, BODY_CAP);
      truncated = 1;
    }
    if (html && html.length > BODY_CAP) {
      html = html.slice(0, BODY_CAP);
      truncated = 1;
    }
    await insertMessage(env.DB, {
      inbox_id: inbox.id,
      sender: message.from,
      recipient: inbox.address,
      subject: subject ?? "(no subject)",
      text,
      html,
      received_at: now,
      expires_at: inbox.expires_at,
      truncated,
    });
  } catch {
    return; // never bail into Email Routing
  }
}
