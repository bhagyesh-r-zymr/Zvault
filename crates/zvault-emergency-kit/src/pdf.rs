//! A minimal single-page PDF 1.7 writer: just enough structure for the kit.

use core::fmt::Write as _;
use std::io::Write as _;

use zeroize::Zeroizing;

/// Catalog, pages, page, contents, four fonts and the info dictionary.
pub(crate) const OBJECT_COUNT: usize = 9;

const FONTS: [(&str, &str); 4] = [
    ("F1", "Helvetica"),
    ("F2", "Helvetica-Bold"),
    ("F3", "Courier"),
    ("F4", "Courier-Bold"),
];

/// Wraps a page content stream in a complete PDF document.
pub(crate) fn document(content: &str) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(Vec::with_capacity(content.len() + 2048));
    let mut offsets = [0usize; OBJECT_COUNT];

    // The high-bit comment marks the file as binary for transfer tools.
    out.extend_from_slice(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");

    let obj = |out: &mut Vec<u8>, offsets: &mut [usize], n: usize, body: &str| {
        offsets[n - 1] = out.len();
        let _ = write!(out, "{n} 0 obj\n{body}\nendobj\n");
    };

    obj(
        &mut out,
        &mut offsets,
        1,
        "<< /Type /Catalog /Pages 2 0 R >>",
    );
    obj(
        &mut out,
        &mut offsets,
        2,
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    );
    obj(
        &mut out,
        &mut offsets,
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] \
         /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >> >> \
         /Contents 4 0 R >>",
    );

    // The content stream holds the Secret Key, so it is copied in place
    // rather than formatted into a temporary.
    offsets[3] = out.len();
    let _ = write!(out, "4 0 obj\n<< /Length {} >>\nstream\n", content.len());
    out.extend_from_slice(content.as_bytes());
    out.extend_from_slice(b"\nendstream\nendobj\n");

    for (i, (name, base)) in FONTS.iter().enumerate() {
        obj(
            &mut out,
            &mut offsets,
            5 + i,
            &format!(
                "<< /Type /Font /Subtype /Type1 /Name /{name} /BaseFont /{base} \
                 /Encoding /WinAnsiEncoding >>"
            ),
        );
    }

    // Deliberately no author, subject or dates: nothing personal in metadata.
    obj(
        &mut out,
        &mut offsets,
        9,
        "<< /Title (Zvault Emergency Kit) /Producer (Zvault) >>",
    );

    let xref = out.len();
    let _ = write!(out, "xref\n0 {}\n0000000000 65535 f \n", OBJECT_COUNT + 1);
    for offset in offsets {
        let _ = writeln!(out, "{offset:010} 00000 n ");
    }
    let _ = write!(
        out,
        "trailer\n<< /Size {} /Root 1 0 R /Info 9 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        OBJECT_COUNT + 1
    );
    out
}

/// Appends `s` as the body of a PDF literal string. Bytes outside printable
/// ASCII are written as octal escapes so the stream stays 7-bit clean.
pub(crate) fn escape_into(out: &mut String, s: &[u8]) {
    for &b in s {
        match b {
            b'(' | b')' | b'\\' => {
                out.push('\\');
                out.push(char::from(b));
            }
            0x20..=0x7e => out.push(char::from(b)),
            _ => {
                let _ = write!(out, "\\{b:03o}");
            }
        }
    }
}
