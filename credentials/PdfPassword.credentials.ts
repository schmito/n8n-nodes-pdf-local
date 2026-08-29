import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class PdfPassword implements ICredentialType {
	name = 'pdfPassword';

	displayName = 'PDF Password';

	documentationUrl = 'https://github.com/schmito/n8n-nodes-pdf-local';

	properties: INodeProperties[] = [
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'The password that opens the PDF. Stored encrypted by n8n and masked in execution logs.',
		},
	];
}
