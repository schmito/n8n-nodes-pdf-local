import {
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { executeUnlock, unlockProperties } from './unlock';

/**
 * A single PDF node with an operation dropdown, rather than one node per task.
 *
 * `description.name` is written into every workflow that uses this node, so
 * changing it later orphans them. Keeping the node generic and adding
 * operations to the dropdown means growth is purely additive: a new operation
 * needs an entry below, its properties, and a case in the dispatch.
 */
export class Pdf implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PDF',
		name: 'pdf',
		icon: 'file:pdf.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Work with PDF files on this machine, with no external service',
		defaults: { name: 'PDF' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'pdfPassword',
				required: true,
				displayOptions: {
					show: { operation: ['unlock'], passwordSource: ['credential'] },
				},
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'unlock',
				options: [
					{
						name: 'Unlock',
						value: 'unlock',
						description: 'Remove password protection and permission restrictions',
						action: 'Unlock a PDF',
					},
				],
			},
			...unlockProperties,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;

		switch (operation) {
			case 'unlock':
				return [await executeUnlock.call(this)];
			default:
				throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
		}
	}
}
