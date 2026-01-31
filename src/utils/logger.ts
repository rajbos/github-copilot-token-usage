import * as vscode from 'vscode';

/**
 * Logger provides timestamped logging to VS Code output channel
 */
export class Logger {
	constructor(private outputChannel: vscode.OutputChannel) {}

	public log(message: string): void {
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ${message}`);
	}

	public warn(message: string): void {
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] WARNING: ${message}`);
	}

	public error(message: string, error?: any): void {
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}`);
		if (error) {
			this.outputChannel.appendLine(`[${timestamp}] ${error}`);
		}
	}
}
