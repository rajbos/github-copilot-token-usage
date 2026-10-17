package com.github.rajbos.aiengineeringfluency

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import javax.swing.JPanel

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
        if (!isJcefSupported()) {
            val unavailablePanel = JPanel(BorderLayout()).apply {
                border = JBUI.Borders.empty(16)
                add(
                    JBLabel(
                        """
                        <html>
                        <h3>Embedded browser unavailable</h3>
                        <p>AI Engineering Fluency requires the JetBrains Runtime with JCEF.</p>
                        <p>Use <b>Help → Find Action → Choose Boot Java Runtime for the IDE</b>,
                        select the default JetBrains Runtime, and restart the IDE.</p>
                        </html>
                        """.trimIndent(),
                    ),
                    BorderLayout.NORTH,
                )
            }
            toolWindow.contentManager.addContent(
                ContentFactory.getInstance()
                    .createContent(unavailablePanel, /* displayName = */ "", /* isLockable = */ false),
            )
            return
        }

        val panel = TokenTrackerPanel(project)
        val content = ContentFactory.getInstance()
            .createContent(panel.component, /* displayName = */ "", /* isLockable = */ false)
        // Dispose the panel (and its JCEF browser) when the tool window content goes away.
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }

    /**
     * Avoid linking JCEF classes until runtime. JCEF is part of the core
     * classloader on older IDEs and an optional bundled plugin on 2026.2+.
     */
    private fun isJcefSupported(): Boolean = runCatching {
        val jcefApp = Class.forName(
            "com.intellij.ui.jcef.JBCefApp",
            /* initialize = */ false,
            TokenTrackerToolWindowFactory::class.java.classLoader,
        )
        jcefApp.getMethod("isSupported").invoke(null) as Boolean
    }.getOrDefault(false)
}
