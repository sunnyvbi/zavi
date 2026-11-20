
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

export type ParseInput = { buffer: Buffer; mimetype: string };
export type ParseResult = { text: string; parse_error?: string };

const MAX_TEXT_LEN = 50_000;

export async function parseResume(input: ParseInput): Promise<ParseResult> {
  const { buffer, mimetype } = input;
  try {
    if (mimetype === "application/pdf") {
      const r = await pdfParse(buffer);
      return { text: r.text.slice(0, MAX_TEXT_LEN) };
    }
    if (
      mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const r = await mammoth.extractRawText({ buffer });
      return { text: r.value.slice(0, MAX_TEXT_LEN) };
    }
    if (mimetype === "text/plain") {
      return { text: buffer.toString("utf-8").slice(0, MAX_TEXT_LEN) };
    }
    return { text: "", parse_error: `unsupported mimetype: ${mimetype}` };
  } catch (e) {
    return { text: "", parse_error: (e as Error).message };
  }
}
