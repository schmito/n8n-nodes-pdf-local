import type { DocumentPermission, PDFDocument } from 'mupdf' with { 'resolution-mode': 'import' };

/**
 * mupdf is a pure ESM package; n8n loads community nodes as CommonJS. A static
 * import would compile to require() and fail at runtime, so the module is
 * pulled in with a dynamic import and memoised. The type-only import above is
 * erased at compile time and is safe.
 *
 * Loading lazily also means the 14 MB WASM binary is never read until the node
 * actually runs, rather than at n8n startup.
 */
type MuPdf = typeof import('mupdf', { with: { 'resolution-mode': 'import' } });
let modulePromise: Promise<MuPdf> | undefined;

function loadMuPdf(): Promise<MuPdf> {
	modulePromise ??= import('mupdf');
	return modulePromise;
}

/**
 * The save options string is the single most important constant in this
 * package. MuPDF's default save PRESERVES existing encryption: it throws no
 * error, writes a plausibly-sized file, and reports success while the output is
 * still locked. Only `encrypt=none` produces a genuinely decrypted PDF.
 *
 * It is defined once, here, and asserted on by test/engine.test.ts against the
 * decrypted *output* rather than against the call returning. Do not inline it.
 */
const SAVE_DECRYPTED = 'encrypt=none';

/**
 * Permissions checked to decide whether a document carries owner-password
 * restrictions. A PDF locked with only an owner password reports
 * needsPassword() === false, so permissions are the only signal that it is
 * encrypted at all.
 *
 * 'copy' and 'accessibility' are deliberately excluded: qpdf and Acrobat both
 * leave them granted in otherwise heavily restricted documents, so including
 * them would not change the outcome while making the check harder to reason
 * about.
 */
const PERMISSIONS: DocumentPermission[] = [
	'print',
	'edit',
	'annotate',
	'form',
	'assemble',
	'print-hq',
];

export type ErrorCode =
	| 'TOO_LARGE'
	| 'NOT_A_PDF'
	| 'PASSWORD_REQUIRED'
	| 'PASSWORD_REJECTED'
	| 'NOT_ENCRYPTED';

export class UnlockError extends Error {
	constructor(
		message: string,
		readonly code: ErrorCode,
	) {
		super(message);
		this.name = 'UnlockError';
	}
}

export type AuthenticatedAs = 'none' | 'user' | 'owner';

export interface UnlockOptions {
	password?: string;
	/** Hard ceiling checked BEFORE the buffer is handed to MuPDF. See below. */
	maxBytes: number;
	/** Throw NOT_ENCRYPTED instead of passing an unencrypted PDF through. */
	errorIfNotEncrypted?: boolean;
}

export interface UnlockResult {
	data: Uint8Array;
	wasEncrypted: boolean;
	wasRestricted: boolean;
	authenticatedAs: AuthenticatedAs;
}

/**
 * MuPDF's authenticatePassword() returns a bitfield, not a boolean:
 *   0 = rejected, 1 = no password was needed, 2 = user password, 4 = owner.
 */
function describeAuth(auth: number): AuthenticatedAs {
	if (auth & 4) return 'owner';
	if (auth & 2) return 'user';
	return 'none';
}

const mb = (n: number) => (n / 1048576).toFixed(1);

/**
 * Remove password protection and permission restrictions from a PDF.
 *
 * Deliberately free of any n8n dependency so it can be tested without
 * constructing an execution context, and so an engine swap stays contained to
 * this file.
 */
export async function unlockPdf(
	input: Uint8Array,
	options: UnlockOptions,
): Promise<UnlockResult> {
	// Checked first and separately, before the module is even loaded. MuPDF holds
	// roughly 5x the file size in WASM memory, and exhausting it is not a
	// catchable exception -- the OS kills the whole process (SIGKILL, empty
	// stderr), taking every concurrent n8n execution with it. A try/catch cannot
	// defend against that, so the only defence is never loading a buffer that
	// could get us there.
	if (input.byteLength > options.maxBytes) {
		throw new UnlockError(
			`PDF is ${mb(input.byteLength)} MB, above the ${mb(options.maxBytes)} MB limit for this node`,
			'TOO_LARGE',
		);
	}

	const mupdf = await loadMuPdf();

	let doc: PDFDocument;
	try {
		const opened = mupdf.Document.openDocument(input, 'application/pdf');
		// MuPDF happily opens images and XPS as Documents. Only a PDFDocument can
		// be re-serialised, so anything else is 'not a PDF' as far as we care.
		if (!(opened instanceof mupdf.PDFDocument)) {
			throw new Error('not a PDF document');
		}
		doc = opened;
	} catch (error) {
		throw new UnlockError(
			`PDF could not be parsed: ${(error as Error).message}`,
			'NOT_A_PDF',
		);
	}

	let authenticatedAs: AuthenticatedAs = 'none';
	const needsPassword = doc.needsPassword();

	if (needsPassword) {
		if (!options.password) {
			throw new UnlockError('This PDF requires a password', 'PASSWORD_REQUIRED');
		}
		const auth = doc.authenticatePassword(options.password);
		if (auth === 0) {
			throw new UnlockError('Password was rejected by the document', 'PASSWORD_REJECTED');
		}
		authenticatedAs = describeAuth(auth);
	}

	// A PDF carrying only an owner password opens without one, so needsPassword()
	// is false even though it is encrypted. Denied permissions are the giveaway.
	const wasRestricted = PERMISSIONS.some((p) => !doc.hasPermission(p));
	const wasEncrypted = needsPassword || wasRestricted;

	if (!wasEncrypted && options.errorIfNotEncrypted) {
		throw new UnlockError('PDF is not encrypted', 'NOT_ENCRYPTED');
	}

	return {
		data: doc.saveToBuffer(SAVE_DECRYPTED).asUint8Array(),
		wasEncrypted,
		wasRestricted,
		authenticatedAs,
	};
}
