package com.github.rajbos.aiengineeringfluency

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/**
 * Registers the AI Engineering Fluency tool window on the right side bar of
 * any JetBrains IDE.
 *
 * Equivalent to:
 *   * VS Code: `vscode.window.registerWebviewViewProvider(...)`
 *   * Visual Studio: `[ProvideToolWindow(typeof(TokenTrackerToolWindow))]`
 *
 * Each open project gets its own [TokenTrackerPanel] instance so the JCEF
 * browser and CLI lifecycle are scoped correctly.
 */
class TokenTrackerToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = TokenTrackerPanel(project)
        val content = ContentFactory.getInstance()
            .createContent(panel.component, /* displayName = */ "", /* isLockable = */ false)
        // Dispose the panel (and its JCEF browser) when the tool window content goes away.
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }

    /**
     * JCEF is required for the embedded webview. On the rare configuration
     * where the bundled JBR doesn't include CEF, hide the tool window rather
     * than failing at create time.
     */
    override fun shouldBeAvailable(project: Project): Boolean =
        com.intellij.ui.jcef.JBCefApp.isSupported()
}
