import {
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
} from 'n8n-workflow';

import { unlockPdf, UnlockError, type ErrorCode } from './engine';

/**
 * Properties for the `unlock` operation. Each is gated on the operation so that
 * adding a second operation to this node shows only its own fields.
 */
export const unlockProperties: INodeProperties[] = [
	{
		displayName: 'Input Binary Field',
		name: 'inputField',
		type: 'string',
		default: 'data',
		required: true,
		hint: 'The name of the input field containing the PDF',
		displayOptions: { show: { operation: ['unlock'] } },
	},
	{
		displayName: 'Password Source',
		name: 'passwordSource',
		type: 'options',
		default: 'credential',
		displayOptions: { show: { operation: ['unlock'] } },
		options: [
			{
				name: 'Credential',
				value: 'credential',
				description: 'Encrypted at rest and masked in execution logs',
			},
			{
				name: 'Expression',
				value: 'parameter',
				description: 'Use when the password differs per item. Stored in plain text.',
			},
		],
	},
	{
		displayName: 'Password',
		name: 'password',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		displayOptions: { show: { operation: ['unlock'], passwordSource: ['parameter'] } },
		description: 'Visible in the workflow JSON and in stored executions. Prefer a credential.',
	},
	{
		displayName: 'Output Binary Field',
		name: 'outputField',
		type: 'string',
		default: 'data',
		required: true,
		hint: 'Where to put the unlocked PDF. May be the same as the input field.',
		displayOptions: { show: { operation: ['unlock'] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { operation: ['unlock'] } },
		options: [
			{
				displayName: 'If Not Encrypted',
				name: 'ifNotEncrypted',
				type: 'options',
				default: 'passThrough',
				options: [
					{ name: 'Pass Through', value: 'passThrough' },
					{ name: 'Error', value: 'error' },
				],
			},
			{
				displayName: 'Max Input Size (MB)',
				name: 'maxInputSizeMb',
				type: 'number',
				default: 50,
				typeOptions: { minValue: 1 },
				description:
					'PDFs above this are rejected before loading. MuPDF uses roughly 5x the file size in memory, and exhausting it kills the n8n process rather than raising a catchable error.',
			},
			{
				displayName: 'Output File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				description: 'Defaults to the input file name',
			},
		],
	},
];

export async function executeUnlock(this: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const out: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		try {
			const inputField = this.getNodeParameter('inputField', i) as string;
			const outputField = this.getNodeParameter('outputField', i) as string;
			const passwordSource = this.getNodeParameter('passwordSource', i) as string;
			const options = this.getNodeParameter('options', i, {}) as {
				ifNotEncrypted?: string;
				maxInputSizeMb?: number;
				fileName?: string;
			};

			let password: string;
			if (passwordSource === 'credential') {
				const credential = await this.getCredentials('pdfPassword', i);
				password = (credential.password as string) ?? '';
			} else {
				password = this.getNodeParameter('password', i, '') as string;
			}

			const binary = this.helpers.assertBinaryData(i, inputField);
			const buffer = await this.helpers.getBinaryDataBuffer(i, inputField);

			const result = await unlockPdf(new Uint8Array(buffer), {
				password,
				maxBytes: (options.maxInputSizeMb ?? 50) * 1024 * 1024,
				errorIfNotEncrypted: options.ifNotEncrypted === 'error',
			});

			const fileName = options.fileName || binary.fileName || 'unlocked.pdf';
			const prepared = await this.helpers.prepareBinaryData(
				Buffer.from(result.data),
				fileName,
				'application/pdf',
			);

			out.push({
				json: {
					...items[i].json,
					unlocked: true,
					wasEncrypted: result.wasEncrypted,
					wasRestricted: result.wasRestricted,
					authenticatedAs: result.authenticatedAs,
				},
				binary: { ...items[i].binary, [outputField]: prepared },
				pairedItem: { item: i },
			});
		} catch (error) {
			if (this.continueOnFail()) {
				out.push({
					json: { ...items[i].json, error: (error as Error).message },
					pairedItem: { item: i },
				});
				continue;
			}

			if (error instanceof UnlockError) {
				throw new NodeOperationError(this.getNode(), error.message, {
					itemIndex: i,
					description: hint(error.code),
				});
			}
			throw error;
		}
	}

	return out;
}

function hint(code: ErrorCode): string {
	switch (code) {
		case 'TOO_LARGE':
			return 'Raise Max Input Size only if the container has memory for roughly 5x the file size.';
		case 'NOT_A_PDF':
			return 'The binary field does not contain a readable PDF.';
		case 'PASSWORD_REQUIRED':
			return 'Attach a PDF Password credential, or switch Password Source to Expression.';
		case 'PASSWORD_REJECTED':
			return 'Check the password. Note that user and owner passwords differ.';
		case 'NOT_ENCRYPTED':
			return 'Set If Not Encrypted to Pass Through to allow unencrypted PDFs.';
	}
}
