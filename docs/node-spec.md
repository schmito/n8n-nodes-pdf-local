# PDF Local — design spec and build record

Works with PDFs entirely in-process — no external binary, no API call, no file
leaving the host. One operation today: unlock.

| | |
| --- | --- |
| **Package** | `n8n-nodes-pdf-local` |
| **Engine** | MuPDF 1.28.0 (WASM) |
| **Licence** | AGPL-3.0-or-later |
| **Version** | 0.2.0, published |
| **Tests** | 20/20 passing |

This document is the reasoning behind the code, and the record of what the build
proved wrong. If you are changing the engine or the test strategy, §2 and §6 are
the parts that will save you.

---

## 1. Why this exists

The setup this replaced staged a PDF to disk, shelled out to a `qpdf` binary
hand-copied into a mounted volume, and read the result back. It worked, but
carried three liabilities: the binary was coupled to the host's libc and could
break on any base-image change, the password was interpolated into a shell
command, and the whole arrangement was unportable to any other n8n instance.

This node removed all three. MuPDF's WebAssembly build decrypts in-process, so
there is no binary to maintain, no shell to inject into, and nothing
host-specific. It installs into `~/.n8n/nodes`, which on a typical deployment is
a mounted volume — so it survives n8n upgrades with no rebuild step at all.

The package is deliberately named for the category rather than the task. A
single **PDF** node carries an operation dropdown holding *Unlock* today; merge,
split or watermark would be added as entries beside it. `description.name` is
written into every workflow that uses a node, so a task-specific name would have
forced a rename — and orphaned every existing workflow — the first time a second
operation appeared.

---

## 2. Engine: validated, not assumed

A spike ran MuPDF 1.28.0 under Node 22 against a fixture matrix generated with
qpdf 12.2.0. Every encryption scheme decrypted correctly and content survived
intact.

| Fixture | `needsPassword()` | `authenticatePassword()` | Result |
| --- | --- | --- | --- |
| RC4 40-bit | `true` | `2` (user) | decrypted |
| RC4 128-bit | `true` | `2` | decrypted |
| AES-128 | `true` | `2` | decrypted |
| AES-256 | `true` | `2` | decrypted |
| Owner password only | `false` | n/a | restrictions lifted |
| Wrong password | `true` | `0` | clean rejection |
| Unencrypted input | `false` | n/a | passes through |

### ⚠ The save option is load-bearing

> `saveToBuffer("")` **preserves the existing encryption.** It throws no error,
> writes a plausibly-sized file, and reports success — while the output is still
> locked. Only `saveToBuffer("encrypt=none")` produces a genuinely decrypted PDF.
>
> This is the single most dangerous line in the implementation. It must be
> covered by a test that asserts on the **output** being unencrypted, never
> merely that the call returned without throwing.

Performance was 31–129 ms per document on small fixtures. The `mupdf` package is
14 MB with **zero transitive dependencies**.

### Memory scales linearly — and running out is fatal

A second spike decrypted AES-256 files of 9.4, 47 and 149 MB. All three
succeeded, and peak resident memory tracks input size on a clean line.

| Input | Peak RSS | Above baseline | Wall time |
| --- | --- | --- | --- |
| 9.4 MB | 120 MB | 5.3× | 281 ms |
| 47.1 MB | 296 MB | 4.8× | 1.1 s |
| 148.9 MB | 775 MB | 4.7× | 3.5 s |

```
peak RSS  ≈  70 MB baseline  +  5 × file size

   50 MB  ->  ~320 MB          300 MB  ->  ~1.6 GB
  150 MB  ->  ~775 MB          500 MB  ->  ~2.6 GB
```

### ⚠ Exhausting memory kills the process, not the workflow

> Re-running the 149 MB file under a 600 MB cgroup cap produced **exit code 137
> — SIGKILL — with an empty stderr**. No exception was raised, nothing was
> catchable, and `saveToBuffer` never returned. The same run under a 900 MB cap
> completed normally.
>
> Inside n8n that means the OOM killer takes down *the entire n8n process*:
> every concurrent execution dies with it and the container restarts. A
> `try`/`catch` cannot defend against this, because there is nothing to catch.
>
> **Design consequence:** the node must refuse oversized input *before* loading
> it. A *Max Input Size* option, checked against the binary's byte length up
> front, converts an unrecoverable process kill into an ordinary node error.
> This is a requirement, not a nicety.

---

## 3. Licence consequence

MuPDF is AGPL-3.0-or-later. Linking it makes this package AGPL too. For private
use on your own instance that carries no practical obligation. For publication
it means the node ships as AGPL, which is accepted and intended.

The permissive alternatives were evaluated and rejected: the PDFium WASM
wrappers can open an encrypted document but expose no save path, and the
Apache-2.0 `qpdf-wasm` builds are browser-targeted and unmaintained since April
2024.

---

## 4. Node interface

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| Operation | options | `unlock` | Currently the only operation. New ones are added here. |
| Input Binary Field | string | `data` | Binary property holding the PDF |
| Password Source | options | `credential` | `credential` \| `parameter` |
| Password | string | — | `typeOptions.password: true`; shown only when source is `parameter` |
| Output Binary Field | string | `data` | May overwrite the input field |

**Options (collection)**

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| If Not Encrypted | options | `passThrough` | `passThrough` \| `error` |
| Output File Name | string | inherit | Defaults to the input file name |
| Max Input Size (MB) | number | `50` | **Required guard.** Checked before load; see §2 and below |

### Sizing the guard

Anchor it to the documents, not to the host's memory. The guard exists to catch
a pathological input, so it belongs just above the realistic worst case — which
normally sits far below any memory ceiling. Invoices and payslips run 100 KB to
a few MB; a 25 MB limit would never reject one, while putting OOM out of reach
entirely.

Where a memory-derived ceiling is wanted instead, the spike gives:

```
maxInputMB  =  (availableMB - 500)  /  (5 x concurrent executions)

   available    1 at a time    3 in parallel
      1 GB        ~100 MB         ~35 MB
      2 GB        ~300 MB        ~100 MB
      4 GB        ~720 MB        ~240 MB
```

The 500 MB covers n8n's own working set plus headroom. Note how sharply
concurrency reduces the safe value: a per-item guard bounds one document, never
the sum of several in flight at once.

### Credential type — `pdfPassword`

A single masked `password` field. This is the default source deliberately: n8n
encrypts credentials at rest with `N8N_ENCRYPTION_KEY` and masks them in
execution logs, whereas a node parameter sits in plaintext in the workflow JSON
and in every stored execution. The parameter source exists only for cases where
the password genuinely varies per item and must come from an expression.

---

## 5. Execution

Runs once per input item, preserving `pairedItem` lineage so downstream nodes
can trace provenance. The size guard runs before the WASM module is even
imported, so an oversized input never reaches MuPDF.

```js
// unlock.ts -- the n8n layer
for each item i:
  buffer = await this.helpers.getBinaryDataBuffer(i, inputField)
  result = await unlockPdf(buffer, { password, maxBytes, errorIfNotEncrypted })
  binary = await this.helpers.prepareBinaryData(
             Buffer.from(result.data), fileName, "application/pdf")
  emit { json: {...item.json, unlocked, wasEncrypted, wasRestricted,
                authenticatedAs}, binary: {[outputField]: binary},
         pairedItem: {item: i} }
  on UnlockError -> NodeOperationError(message, {itemIndex: i, description: hint(code)})

// engine.ts -- no n8n types, testable standalone
unlockPdf(input, options):
  if input.byteLength > maxBytes    -> TOO_LARGE      // before anything loads
  mupdf  = await import("mupdf")                      // memoised; ESM from CJS
  opened = mupdf.Document.openDocument(input, "application/pdf")
  if not (opened instanceof mupdf.PDFDocument)  -> NOT_A_PDF

  needsPassword = doc.needsPassword()
  if needsPassword:
      if no password                -> PASSWORD_REQUIRED
      auth = doc.authenticatePassword(password)
      if auth === 0                 -> PASSWORD_REJECTED

  wasRestricted = PERMISSIONS.some(p => !doc.hasPermission(p))
  wasEncrypted  = needsPassword || wasRestricted
  if not wasEncrypted and errorIfNotEncrypted   -> NOT_ENCRYPTED

  return doc.saveToBuffer("encrypt=none").asUint8Array()   // never ""
```

The `authenticatePassword` return value is a bitfield: `0` failed, `1` no
password needed, `2` user password, `4` owner password. It is surfaced as
`authenticatedAs` in the output JSON so workflows can branch on which password
actually matched.

**Detecting encryption when no password is needed.** `hasPermission()` separates
the cases: an unencrypted PDF grants everything, while an owner-locked one
denies print, edit, annotate, form and assemble. So
`wasEncrypted = needsPassword() || anyPermissionDenied()`.

One blind spot remains and is accepted: a PDF encrypted with an *empty* user
password and no restrictions is indistinguishable from an unencrypted one. The
output is correct either way — only the reported `wasEncrypted` and the *If Not
Encrypted* option are affected.

---

## 6. Error handling

Every failure raises `NodeOperationError` with the item index attached. When
`continueOnFail()` is set, the item is emitted with an `error` key and correct
`pairedItem` rather than aborting — a batch of two hundred statements must not
die on one bad file.

| Condition | Detection | Message |
| --- | --- | --- |
| Binary field missing | helper throws | No binary data in field `{field}` |
| Input exceeds Max Input Size | byte length, **before load** | PDF is {n} MB, above the {max} MB limit for this node |
| Not a PDF | `openDocument` throws / wrong type | Input is not a PDF file |
| Corrupt PDF | `openDocument` throws | PDF could not be parsed |
| Password required, none given | `needsPassword()` | This PDF requires a password |
| Wrong password | `auth === 0` | Password was rejected by the document |

> **No runtime check that the output is unencrypted — deliberately.** Re-opening
> the result to verify would roughly double peak memory on every execution, to
> guard against something that cannot vary at runtime: the save option is a
> module constant. The risk is a future code change, and the defence against
> that is a test, not a runtime cost.

---

## 7. Tests

Twenty tests, all passing. Fixtures are generated by `test/make-fixtures.sh`
rather than committed, so what each contains is legible in the script instead of
opaque in a binary.

| Group | Covers | Count |
| --- | --- | --- |
| Encryption schemes | RC4-40, RC4-128, AES-128, AES-256 — output asserted unencrypted, content asserted identical | 8 |
| Owner-password only | Detected as encrypted; restrictions lifted | 2 |
| Unencrypted input | Passes through; errors when configured to | 2 |
| Rejections | Wrong password, missing password, non-PDF, corrupt PDF | 4 |
| Size guard | One byte over rejects, exactly at limit passes, message carries both sizes | 3 |
| Idempotency | Unlocking an already-unlocked output is a no-op | 1 |

Every decryption test asserts on the **output** via an independent oracle that
re-opens the result and checks `needsPassword()` and permissions. Asserting that
`unlockPdf()` returned without throwing would prove nothing, because the broken
version succeeds too.

**Out of scope by decision.** Several large decryptions running *concurrently*
in one process remain unmeasured: the per-item guard bounds one document, never
the sum of several in flight. For a single-operator instance processing invoices
one at a time this cannot arise, and the guard already prevents the failure that
would actually hurt. It would need revisiting before any batch or multi-tenant
use.

---

## 8. Repository layout

```
n8n-nodes-pdf-local/
├── package.json              n8n.nodes + n8n.credentials manifest
├── tsconfig.json
├── LICENSE                   AGPL-3.0, inherited from MuPDF
├── README.md                 npm storefront
├── .github/workflows/
│   └── publish.yml           OIDC trusted publishing on a v* tag
├── credentials/
│   └── PdfPassword.credentials.ts
├── docs/
│   └── node-spec.md          this document
├── nodes/Pdf/
│   ├── Pdf.node.ts           description + operation dispatch
│   ├── unlock.ts             unlock operation: properties + handler
│   ├── engine.ts             mupdf wrapper, no n8n dependency
│   └── pdf.svg
├── scripts/copy-icons.mjs
└── test/
    ├── make-fixtures.sh      qpdf script, reproducible
    ├── fixtures/             generated, gitignored
    └── engine.test.ts
```

Three layers, each with a reason. `engine.ts` holds the MuPDF calls and no n8n
types, so decryption is testable without an execution context and an engine swap
stays contained to one file. `unlock.ts` holds one operation's properties and
handler together, so adding *merge* means adding `merge.ts` and nothing else
moves. `Pdf.node.ts` is only a description and a dispatch `switch`.

**Adding an operation:** add `<name>.ts` beside `unlock.ts` exporting its
properties and handler, add an entry to the Operation dropdown in `Pdf.node.ts`,
and add a case to the dispatch. Nothing else changes.

---

## 9. Install and release

Installed and verified in production. n8n's official image is a Docker Hardened
Image: it strips `apk` but keeps npm — reasonable, since n8n needs npm at runtime
to install community nodes — so the Community Nodes panel works.

Settings → Community nodes → install `n8n-nodes-pdf-local`. It writes to
`~/.n8n/nodes`, inside the mounted data volume, so it survives image upgrades
with no rebuild and no regeneration step. The `N8N_CUSTOM_EXTENSIONS` fallback
is the route for any instance whose image lacks npm.

### Releasing

Publishing runs from GitHub Actions using npm **trusted publishing** (OIDC).
GitHub mints a short-lived, workflow-scoped credential that npm verifies against
a trusted publisher pinned to owner, repository and workflow filename. There is
no `NPM_TOKEN` stored anywhere, nothing to rotate, and no interactive passkey
challenge on release.

```bash
npm version minor && git push --follow-tags
```

The tag triggers the workflow, which installs qpdf, generates the fixture
matrix, runs all twenty tests, builds, and publishes. Two guards sit in front of
the publish step: the tag is checked against `package.json` so a mistagged
release fails instead of shipping, and qpdf is installed because fixtures are
generated rather than committed.

> **If you rename `publish.yml`, publishing breaks.** The trusted publisher
> on npm pins the exact workflow filename. Update the npm setting to match, or
> releases fail with a 404 that looks nothing like an auth error.

Releases carry a **signed provenance attestation** in the Sigstore transparency
log, tying the tarball to the exact commit and workflow run that produced it.
The registry records the publisher as `GitHub Actions
<npm-oidc-no-reply@github.com>` rather than a person.

The package is set to **require 2FA and disallow tokens**
(`npm access set mfa=publish`). Trusted publishing is unaffected — that setting
blocks classic token auth, and OIDC is not a token — confirmed by re-running the
workflow afterwards and getting "cannot publish over the previously published
versions" rather than the 404 that an auth failure produces. A stolen npm token
cannot publish here; only a passkey or a workflow run in this repository can.

---

## 10. What the build changed

Five things the specification or the local setup had wrong, each caught by the
compiler, the test suite or CI rather than in production.

| Assumption | Reality | Resolution |
| --- | --- | --- |
| Linearize is a useful save option | MuPDF 1.28 throws `Linearisation is no longer supported` on every call | Option removed rather than shipped broken; test replaced with an idempotency check |
| `import * as mupdf` works in a node | mupdf is pure ESM; n8n loads community nodes as CommonJS, so a static import compiles to `require()` and dies at runtime | Memoised dynamic `import()`, with `resolution-mode` attributes on the type imports. Verified the emitted `dist/` keeps a real dynamic import. |
| `saveToBuffer` exists on `Document` | It is on `PDFDocument`. MuPDF opens images and XPS as `Document` too. | Narrow with `instanceof PDFDocument` — which doubles as a stronger not-a-PDF check than the parse error alone |
| Green tests locally mean green tests in CI | `package.json` pinned `@types/node@^22` while the lockfile carried 26.4.0. `npm install` tolerates the mismatch; `npm ci` refuses it. | Lockfile reconciled, and CI now replicated locally with `rm -rf node_modules && npm ci` before trusting a green run |
| A fresh clone can generate its own fixtures | Everything in `test/fixtures/` is gitignored and git cannot track an empty directory, so the folder did not exist and the generator's `cd` failed. Local runs passed because the folder was already there. | `make-fixtures.sh` creates the directory rather than assuming it |

Lazy loading arrived as a side effect worth keeping: the 14 MB WASM binary is
not read until the node first runs, rather than at n8n startup.

Verification beyond the unit tests: the compiled CommonJS was loaded exactly as
n8n loads it, used to decrypt an AES-256 fixture, and the output handed to qpdf,
which reports `File is not encrypted`. Published tarball is 21.8 kB across 16
files.

> The two CI failures share a shape worth naming: both were cases where the
> local environment was more forgiving than a clean one. `npm install` forgives
> a stale lockfile; an existing directory forgives a script that never creates
> it. Neither was visible until something built from nothing. **Before trusting
> a green local run, build from nothing.**

---

## 11. Out of scope

- **Adding** encryption or setting permissions — a natural second operation, but
  not this one. Unlock and lock in a single operation would muddy the UI.
- Password recovery, brute-forcing, or any attempt to open a document without
  its password.
- Merging, splitting, watermarking, OCR. MuPDF can do all of it and the node is
  shaped to grow into it — but each is its own operation, its own properties,
  and its own tests.

---

*n8n-nodes-pdf-local 0.2.0 · published via OIDC with provenance · 20/20 tests ·
MuPDF 1.28.0 · qpdf 12.2.0 · 2026-08-29*
