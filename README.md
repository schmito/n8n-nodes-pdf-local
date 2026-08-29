# n8n-nodes-pdf-local

Remove password protection and permission restrictions from PDFs inside n8n.

Everything happens in-process via [MuPDF](https://mupdf.com)'s WebAssembly
build. There is no external binary to install, no API to call, and no file
leaves the host.

## Install

n8n → **Settings → Community nodes → Install** → `n8n-nodes-pdf-local`

Requires n8n with community packages enabled (the default) and Node 20.15+.

## What it does

| Input | Result |
| --- | --- |
| PDF with a user password | Decrypted, given the correct password |
| PDF with only an owner password | Restrictions lifted, no password needed |
| Unencrypted PDF | Passed through unchanged (or errors, if configured) |

Supports every encryption scheme PDF defines: RC4 40-bit, RC4 128-bit, AES-128
and AES-256.

## Parameters

| Name | Default | Notes |
| --- | --- | --- |
| Input Binary Field | `data` | Field holding the PDF |
| Password Source | `credential` | `credential` or `expression` |
| Password | — | Only when source is `expression` |
| Output Binary Field | `data` | May overwrite the input |

**Options**

| Name | Default | Notes |
| --- | --- | --- |
| If Not Encrypted | Pass Through | Or `Error` |
| Max Input Size (MB) | `50` | See below — this one matters |
| Output File Name | inherit | Defaults to the input file name |

Prefer the **credential** password source. n8n encrypts credentials at rest and
masks them in execution logs; a node parameter sits in plain text in the
workflow JSON and in every stored execution.

## Output

The unlocked PDF lands in the output binary field. The JSON gains:

```json
{
  "unlocked": true,
  "wasEncrypted": true,
  "wasRestricted": false,
  "authenticatedAs": "user"
}
```

`authenticatedAs` is `user`, `owner`, or `none`, so a workflow can branch on
which password actually matched.

## Max Input Size

MuPDF holds roughly **five times the file size** in memory:

```
peak RSS  ≈  70 MB baseline  +  5 × file size
```

Exceeding available memory does not raise a catchable error. The OS kills the
process — SIGKILL, empty stderr — which in n8n means the whole n8n process dies
and takes every concurrent execution with it. No `try`/`catch` can defend
against that, so this node refuses oversized input *before* loading it.

Anchor the limit to your documents, not to your RAM. Invoices and payslips run
100 KB to a few MB, so a 25 MB limit rejects nothing real while putting OOM out
of reach. If you want the memory-derived ceiling instead:

```
maxInputMB = (availableMB − 500) ÷ (5 × concurrent executions)
```

Concurrency matters more than it looks: the guard bounds one document, never
the sum of several in flight at once.

## Development

```bash
npm install
npm run fixtures   # builds the test matrix, needs qpdf
npm test
npm run build
```

The decryption logic lives in `nodes/UnlockPdf/engine.ts` with no n8n
dependency, so it is testable without an execution context.

### One thing to know before changing the engine

MuPDF's default save **preserves existing encryption**. It throws nothing,
writes a plausibly-sized file, and reports success while the output is still
locked. Only `saveToBuffer('encrypt=none')` produces a decrypted PDF.

Every decryption test therefore asserts on the *output* being unencrypted,
never on the call returning without throwing. Keep it that way.

## Licence

AGPL-3.0-or-later. MuPDF is AGPL, and linking it sets the licence of this
package.
