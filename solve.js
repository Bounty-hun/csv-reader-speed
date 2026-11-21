// Fast drop-in for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// Same answer for every input {text, header}: {columns, rows, errors}.
// Single left-to-right pass. Fields are slices of the input (no per-character
// concatenation); only the rare broken cases take a slow path.
//
// Semantics (csv-reader 1.0.0):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside is one quote; each CRLF or lone CR inside reads as LF.
// - What follows the closing quote, up to the next comma or line break, is
//   appended as it stands (error quote_junk, when the field ends).
// - A quote that never closes is a literal character and the text after it is
//   read again as unquoted (error unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds the
//   records after it (every record when header is false), each padded with ""
//   (short_row, with fields: its field count) or cut (long_row, with extra:
//   the cut fields) to the first record's width.
// - Each error is {code, line, row} in the order met; a record's short_row or
//   long_row when the record ends. line is the 1-based line its record starts
//   on, counting every LF, CRLF and lone CR inside quotes; row is its record's
//   index in rows, null for the header.

/**
 * A quoted chunk [start, end): the text with CRLF and lone CR each read as
 * one LF. Returns [value, newlines]. Fast path when the chunk holds no CR
 * or LF at all. Only used for quoted content, where line breaks are rare.
 */
function qchunk(text, start, end) {
  // Bounded scan: the first line break inside [start, end), or end when
  // there is none. (An unbounded indexOf here would scan to the end of the
  // whole input whenever the chunk holds no CR/LF — quadratic on inputs
  // with many quoted fields, e.g. 40k quoted rows each re-scanning MBs.)
  let k = start;
  while (k < end) {
    const c = text.charCodeAt(k);
    if (c === 13 || c === 10) break;
    k += 1;
  }
  if (k === end) return [text.slice(start, end), 0];
  let v = text.slice(start, k);
  let lines = 0;
  while (k < end) {
    const c = text.charCodeAt(k);
    if (c === 13) {
      v += '\n';
      lines += 1;
      k += text.charCodeAt(k + 1) === 10 ? 2 : 1;
    } else if (c === 10) {
      v += '\n';
      lines += 1;
      k += 1;
    } else {
      let m = k + 1;
      while (m < end) {
        const d = text.charCodeAt(m);
        if (d === 13 || d === 10) break;
        m += 1;
      }
      v += text.slice(k, m);
      k = m;
    }
  }
  return [v, lines];
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // 0 = comma (record goes on), 1 = line break (record ends), 2 = end of text.
  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended = 0;

    do {
      let value;
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) {
        // ---- quoted field ----
        const openPos = pos;
        const openLine = line;
        let start = pos + 1;
        let parts = null;
        let closed = -1;
        let q = start;
        for (;;) {
          q = text.indexOf('"', q);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            // Doubled quote: one literal quote.
            const chunk = qchunk(text, start, q);
            if (parts === null) parts = [];
            parts.push(chunk[0], '"');
            line += chunk[1];
            q += 2;
            start = q;
            continue;
          }
          closed = q;
          break;
        }
        if (closed === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = openPos + 1;
          line = openLine;
          const r = readUnquoted(text, n, pos, ['"'], recordLine, recordRow, errors, openLine);
          value = r[0];
          ended = r[1];
          pos = r[2];
          line = r[3];
        } else {
          const chunk = qchunk(text, start, closed);
          line += chunk[1];
          if (parts === null) {
            value = chunk[0];
          } else {
            parts.push(chunk[0]);
            value = parts.join('');
          }
          const t = closed + 1;
          if (t >= n) {
            ended = 2;
            pos = n;
          } else {
            const tc = text.charCodeAt(t);
            if (tc === 44) {
              ended = 0;
              pos = t + 1;
            } else if (tc === 10) {
              ended = 1;
              pos = t + 1;
              line += 1;
            } else if (tc === 13 && text.charCodeAt(t + 1) === 10) {
              ended = 1;
              pos = t + 2;
              line += 1;
            } else {
              // What follows the closing quote is appended as it stands.
              const r = readUnquoted(text, n, t, [value], recordLine, recordRow, errors, line);
              if (r[4] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              value = r[0];
              ended = r[1];
              pos = r[2];
              line = r[3];
            }
          }
        }
      } else {
        // ---- unquoted field ----
        const r = readUnquoted(text, n, pos, null, recordLine, recordRow, errors, line);
        value = r[0];
        ended = r[1];
        pos = r[2];
        line = r[3];
      }
      fields.push(value);
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

/**
 * Reads unquoted characters from `from` up to the next comma or line break.
 * `parts` is null for a fresh field, or an array of already-read chunks the
 * result starts with (a literal '"' for an unterminated quote, or a quoted
 * field's value for quote junk). A CR not followed by LF is dropped
 * (stray_cr). Returns [value, ended, pos, line, kept] where kept counts the
 * characters this call kept (0 when the field ends at once).
 *
 * Kept out of run() as a helper so the hot path stays a single function
 * body; V8 inlines this small function at the call sites.
 */
function readUnquoted(text, n, from, parts, recordLine, recordRow, errors, line) {
  let p = from;
  let kept = 0;
  let ended;
  for (;;) {
    const iC = text.indexOf(',', p);
    const iN = text.indexOf('\n', p);
    let end = iC;
    let kind = 0;
    if (iN !== -1 && (end === -1 || iN < end)) {
      end = iN;
      kind = 1;
    }
    if (end === -1) {
      // No comma or LF ahead: a CR here can only be a stray one (a CRLF
      // would have shown its LF), but check anyway.
      const r = text.indexOf('\r', p);
      if (r === -1) {
        const tail = text.slice(p);
        kept += tail.length;
        const value = parts === null ? tail : parts.join('') + tail;
        return [value, 2, n, line, kept];
      }
      if (text.charCodeAt(r + 1) === 10) {
        const chunk = text.slice(p, r);
        kept += chunk.length;
        const value = parts === null ? chunk : parts.join('') + chunk;
        return [value, 1, r + 2, line + 1, kept];
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      const chunk = text.slice(p, r);
      kept += chunk.length;
      if (parts === null) parts = [];
      parts.push(chunk);
      p = r + 1;
      continue;
    }
    // A CR can only matter before this field's end: scan just the span.
    // (A native indexOf('\r', p) is wrong here: it scans to the end of the
    // whole input when no CR follows, which is quadratic on CR-free inputs
    // with many fields. The bounded loop is the correct scan.)
    let r = -1;
    for (let k = p; k < end; k += 1) {
      if (text.charCodeAt(k) === 13) { r = k; break; }
    }
    if (r !== -1) {
      if (text.charCodeAt(r + 1) === 10) {
        const chunk = text.slice(p, r);
        kept += chunk.length;
        const value = parts === null ? chunk : parts.join('') + chunk;
        return [value, 1, r + 2, line + 1, kept];
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      const chunk = text.slice(p, r);
      kept += chunk.length;
      if (parts === null) parts = [];
      parts.push(chunk);
      p = r + 1;
      continue;
    }
    const chunk = text.slice(p, end);
    kept += chunk.length;
    const value = parts === null ? chunk : parts.join('') + chunk;
    if (kind === 0) {
      ended = 0;
      p = end + 1;
    } else {
      ended = 1;
      p = end + 1;
      line += 1;
    }
    return [value, ended, p, line, kept];
  }
}
