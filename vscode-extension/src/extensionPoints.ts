/**
 * A button contribution registered via the extension points API.
 */
export interface ExtensionPointButton {
  /** Stable unique identifier for this button. Used to route click events. */
  readonly id: string;
  /** Display label shown in the button. */
  readonly label: string;
}

/**
 * Public API exported by the AI Engineering Fluency extension.
 * Companion extensions can acquire this via `vscode.extensions.getExtension(...).exports`.
 */
export interface AiFluencyExtensionApi {
  /**
   * Register a button to appear in the navigation toolbar of all webview panels.
   * The handler is called when the user clicks the button.
   * Returns a Disposable; call dispose() to remove the button.
   */
  registerButton(button: ExtensionPointButton, handler: () => void | Promise<void>): { dispose(): void };
}
