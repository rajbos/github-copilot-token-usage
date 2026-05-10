interface ExtensionPointButtonData {
  id: string;
  label: string;
}

declare global {
  interface Window {
    __EXTENSION_POINT_BUTTONS__?: ExtensionPointButtonData[];
  }
}

/**
 * Appends any extension-point buttons to the `.button-row` element and wires
 * their click handlers to post `extensionPointAction` messages back to the host.
 *
 * Call this after every render that rebuilds the button row.
 */
export function wireExtensionPointButtons(
  vscodeApi: { postMessage: (message: unknown) => void },
): void {
  const buttons = window.__EXTENSION_POINT_BUTTONS__ ?? [];
  if (buttons.length === 0) { return; }

  const buttonRow = document.querySelector('.button-row');
  if (!buttonRow) { return; }

  for (const btn of buttons) {
    const el = document.createElement('vscode-button');
    el.id = `ext-point-${btn.id}`;
    el.textContent = btn.label;
    el.addEventListener('click', () => {
      vscodeApi.postMessage({ command: 'extensionPointAction', buttonId: btn.id });
    });
    buttonRow.append(el);
  }
}
