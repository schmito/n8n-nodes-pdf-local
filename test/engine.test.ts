import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as mupdf from 'mupdf';

import { unlockPdf, UnlockError } from '../nodes/Pdf/engine';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const MAX = 50 * 1024 * 1024;

/**
 * Independent oracle. Asserting that unlockPdf() returned without throwing
 * proves nothing: MuPDF's default save preserves encryption silently, so a
 * broken implementation still "succeeds". Every decryption test must inspect
 * the OUTPUT instead.
 */
function isLocked(data: Uint8Array): boolean {
	const doc = mupdf.Document.openDocument(data, 'application/pdf');
	if (doc.needsPassword()) return true;
	return ['print', 'edit', 'annotate', 'form', 'assemble', 'print-hq'].some(
		(p) => !doc.hasPermission(p as never),
	);
}

function textOf(data: Uint8Array): string {
	const doc = mupdf.Document.openDocument(data, 'application/pdf');
	return doc.loadPage(0).toStructuredText().asText().trim();
}

describe('decryption across encryption schemes', () => {
	const schemes = [
		['RC4 40-bit', 'enc-rc4-40.pdf'],
		['RC4 128-bit', 'enc-rc4-128.pdf'],
		['AES-128', 'enc-aes128.pdf'],
		['AES-256', 'enc-aes256.pdf'],
	] as const;

	it.each(schemes)('%s produces a genuinely unencrypted PDF', async (_label, file) => {
		const result = await unlockPdf(read(file), { password: 'secret123', maxBytes: MAX });

		expect(result.wasEncrypted).toBe(true);
		expect(result.authenticatedAs).toBe('user');
		expect(isLocked(result.data)).toBe(false);
	});

	it.each(schemes)('%s preserves the page content', async (_label, file) => {
		const result = await unlockPdf(read(file), { password: 'secret123', maxBytes: MAX });
		expect(textOf(result.data)).toBe(textOf(read('plain.pdf')));
	});
});

describe('owner-password-only documents', () => {
	it('is detected as encrypted despite opening without a password', async () => {
		const result = await unlockPdf(read('enc-owner-only.pdf'), { maxBytes: MAX });

		expect(result.wasEncrypted).toBe(true);
		expect(result.wasRestricted).toBe(true);
		expect(result.authenticatedAs).toBe('none');
	});

	it('lifts the restrictions', async () => {
		const before = mupdf.Document.openDocument(read('enc-owner-only.pdf'), 'application/pdf');
		expect(before.hasPermission('print')).toBe(false);

		const result = await unlockPdf(read('enc-owner-only.pdf'), { maxBytes: MAX });
		expect(isLocked(result.data)).toBe(false);
	});
});

describe('unencrypted input', () => {
	it('passes through by default', async () => {
		const result = await unlockPdf(read('plain.pdf'), { maxBytes: MAX });
		expect(result.wasEncrypted).toBe(false);
		expect(isLocked(result.data)).toBe(false);
	});

	it('errors when configured to', async () => {
		await expect(unlockPdf(read('plain.pdf'), { maxBytes: MAX, errorIfNotEncrypted: true }))
			.rejects.toThrowError(expect.objectContaining({ code: 'NOT_ENCRYPTED' }));
	});
});

describe('rejections', () => {
	it('rejects a wrong password', async () => {
		await expect(unlockPdf(read('enc-aes256.pdf'), { password: 'nope', maxBytes: MAX }))
			.rejects.toThrowError(expect.objectContaining({ code: 'PASSWORD_REJECTED' }));
	});

	it('rejects a missing password', async () => {
		await expect(unlockPdf(read('enc-aes256.pdf'), { maxBytes: MAX }))
			.rejects.toThrowError(expect.objectContaining({ code: 'PASSWORD_REQUIRED' }));
	});

	it('rejects a file that is not a PDF', async () => {
		await expect(unlockPdf(read('not-a-pdf.bin'), { maxBytes: MAX }))
			.rejects.toThrowError(expect.objectContaining({ code: 'NOT_A_PDF' }));
	});

	it('rejects a corrupt PDF', async () => {
		await expect(unlockPdf(read('corrupt.pdf'), { maxBytes: MAX }))
			.rejects.toThrowError(expect.objectContaining({ code: 'NOT_A_PDF' }));
	});
});

describe('size guard', () => {
	// This guard is the only thing standing between an oversized PDF and a
	// SIGKILL that takes the whole n8n process down, so it is tested for the
	// thing that actually matters: that MuPDF is never reached at all.
	it('rejects input one byte over the limit', async () => {
		const pdf = read('enc-aes256.pdf');
		await expect(unlockPdf(pdf, { password: 'secret123', maxBytes: pdf.byteLength - 1 }))
			.rejects.toThrowError(expect.objectContaining({ code: 'TOO_LARGE' }));
	});

	it('accepts input exactly at the limit', async () => {
		const pdf = read('enc-aes256.pdf');
		const result = await unlockPdf(pdf, { password: 'secret123', maxBytes: pdf.byteLength });
		expect(isLocked(result.data)).toBe(false);
	});

	it('reports sizes in the message so the limit can be tuned', async () => {
		const pdf = read('enc-aes256.pdf');
		try {
			await unlockPdf(pdf, { password: 'secret123', maxBytes: 1024 });
			expect.unreachable('should have thrown');
		} catch (error) {
			expect((error as UnlockError).message).toMatch(/MB, above the .* MB limit/);
		}
	});
});

describe('idempotency', () => {
	it('unlocking an already-unlocked output is a no-op', async () => {
		const once = await unlockPdf(read('enc-aes256.pdf'), { password: 'secret123', maxBytes: MAX });
		const twice = await unlockPdf(once.data, { maxBytes: MAX });

		expect(twice.wasEncrypted).toBe(false);
		expect(isLocked(twice.data)).toBe(false);
		expect(textOf(twice.data)).toBe(textOf(read('plain.pdf')));
	});
});
