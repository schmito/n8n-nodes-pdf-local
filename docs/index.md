# n8n-nodes-pdf-local

An [n8n](https://n8n.io) community node that works with PDFs entirely
in-process. No external binary, no API call, no file leaves the host.

One operation today: **unlock** — removes password protection and permission
restrictions, across RC4-40, RC4-128, AES-128 and AES-256.

- **[Design spec and build record](node-spec.md)** — why MuPDF, the measured
  memory model behind the size guard, the save-option trap the test strategy is
  built around, and the five things the build proved the specification wrong
- [Source on GitHub](https://github.com/schmito/n8n-nodes-pdf-local)
- [Package on npm](https://www.npmjs.com/package/n8n-nodes-pdf-local)

## Install

n8n → **Settings → Community nodes → Install** → `n8n-nodes-pdf-local`

## Contributing

Read the [design spec](node-spec.md) before changing the engine or the tests —
particularly §2 on the save option and §7 on why every decryption test asserts
on the output rather than on the call returning.

Licensed AGPL-3.0-or-later, inherited from MuPDF.
