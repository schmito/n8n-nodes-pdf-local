#!/usr/bin/env bash
# Generate the test fixture matrix reproducibly.
#
# Fixtures are built here rather than committed, so that what each one contains
# is legible in this script instead of opaque in a binary blob. Requires qpdf.
set -euo pipefail

cd "$(dirname "$0")/fixtures"

command -v qpdf >/dev/null || { echo "qpdf is required to build fixtures"; exit 1; }

USER_PW=secret123
OWNER_PW=owner999

# --- a minimal but genuinely valid source PDF -------------------------------
python3 - <<'PY'
objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R "
    "/Resources << /Font << /F1 5 0 R >> >> >>",
    None,  # content stream, filled below
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
content = b"BT /F1 24 Tf 20 100 Td (Hello Spike) Tj ET"

out, offsets = bytearray(b"%PDF-1.7\n"), []
for i, o in enumerate(objs, start=1):
    offsets.append(len(out))
    out += f"{i} 0 obj\n".encode()
    if o is None:
        out += f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream\n"
    else:
        out += o.encode() + b"\n"
    out += b"endobj\n"

xref = len(out)
out += f"xref\n0 {len(objs)+1}\n".encode() + b"0000000000 65535 f \n"
for off in offsets:
    out += f"{off:010d} 00000 n \n".encode()
out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()

open("plain.pdf", "wb").write(bytes(out))
PY

# qpdf wants: --encrypt <options> -- <in> <out>, so the output filename has to be
# pulled off the end rather than passed through with the rest of the arguments.
enc() {
  local out="${!#}"
  local opts=("${@:1:$#-1}")
  qpdf --allow-weak-crypto --encrypt "${opts[@]}" -- plain.pdf "$out"
}

# user password + owner password, across every encryption revision qpdf writes
enc --user-password=$USER_PW --owner-password=$OWNER_PW --bits=40            "enc-rc4-40.pdf"
enc --user-password=$USER_PW --owner-password=$OWNER_PW --bits=128 --use-aes=n "enc-rc4-128.pdf"
enc --user-password=$USER_PW --owner-password=$OWNER_PW --bits=128 --use-aes=y "enc-aes128.pdf"
enc --user-password=$USER_PW --owner-password=$OWNER_PW --bits=256            "enc-aes256.pdf"

# opens without a password but forbids printing and editing
enc --user-password= --owner-password=$OWNER_PW --bits=256 --print=none --modify=none "enc-owner-only.pdf"

# not a PDF at all, and a PDF truncated mid-object
printf 'this is definitely not a pdf' > not-a-pdf.bin
head -c 200 plain.pdf > corrupt.pdf

echo "fixtures built:"
ls -1 *.pdf *.bin
