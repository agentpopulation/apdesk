// PDF text reader over unpdf (Mozilla pdf.js, pure JavaScript).
// SPDX-License-Identifier: Apache-2.0
/**
 * Text of a PDF for previews, file_read and Knowledge. pdf.js decodes every font through its own
 * ToUnicode map, kerning arrays and stream filters. No OCR: a scanned PDF has no text to find, and
 * the caller says so plainly instead of guessing. Nothing leaves the PC.
 */

function pdfError(code, message) {
  return Object.assign(new Error(message), { code });
}

const clean = (text) => String(text || '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/**
 * Text of a PDF; a file of more than one page marks each page "[page N]" (knowledge.js pageRegions).
 * @throws code 'encrypted' (password-protected), 'malformed' (not a PDF), 'pdfNoText' (no text found)
 */
export async function pdfToText(bytes) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pages;
  try {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    pages = (await extractText(doc, { mergePages: false })).text.map(clean);
  } catch (err) {
    if (err?.name === 'PasswordException') throw pdfError('encrypted', 'The document is password-protected.');
    throw Object.assign(pdfError('malformed', 'This is not a readable PDF.'), { cause: err });
  }
  if (!pages.some((t) => /[\p{L}\p{N}]{3}/u.test(t))) {
    throw pdfError('pdfNoText', 'Could not read the text of this PDF (it may be a scan, or its fonts hide the text). Nothing was sent off this PC.');
  }
  return pages.length > 1 ? pages.map((t, i) => `[page ${i + 1}]\n${t}`).join('\n\n') : pages[0];
}
