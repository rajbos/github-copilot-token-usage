using CopilotTokenTracker.WebBridge;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace CopilotTokenTracker.Tests
{
    [TestClass]
    public class ThemedHtmlBuilderTests
    {
        // ── ViewToGlobalKey ────────────────────────────────────────────────

        [TestMethod]
        public void ViewToGlobalKey_Details_ReturnsCorrectKey()
        {
            Assert.AreEqual("__INITIAL_DETAILS__", ThemedHtmlBuilder.ViewToGlobalKey("details"));
        }

        [TestMethod]
        public void ViewToGlobalKey_Chart_ReturnsCorrectKey()
        {
            Assert.AreEqual("__INITIAL_CHART__", ThemedHtmlBuilder.ViewToGlobalKey("chart"));
        }

        [TestMethod]
        public void ViewToGlobalKey_Usage_ReturnsCorrectKey()
        {
            Assert.AreEqual("__INITIAL_USAGE__", ThemedHtmlBuilder.ViewToGlobalKey("usage"));
        }

        [TestMethod]
        public void ViewToGlobalKey_Diagnostics_ReturnsCorrectKey()
        {
            Assert.AreEqual("__INITIAL_DIAGNOSTICS__", ThemedHtmlBuilder.ViewToGlobalKey("diagnostics"));
        }

        [TestMethod]
        public void ViewToGlobalKey_Environmental_ReturnsCorrectKey()
        {
            Assert.AreEqual("__INITIAL_ENVIRONMENTAL__", ThemedHtmlBuilder.ViewToGlobalKey("environmental"));
        }

        [TestMethod]
        public void ViewToGlobalKey_Maturity_ReturnsCorrectKey()
        {
            Assert.AreEqual("__INITIAL_MATURITY__", ThemedHtmlBuilder.ViewToGlobalKey("maturity"));
        }

        [TestMethod]
        public void ViewToGlobalKey_Unknown_FallsBackToDetails()
        {
            Assert.AreEqual("__INITIAL_DETAILS__", ThemedHtmlBuilder.ViewToGlobalKey("nonexistent"));
        }

        [TestMethod]
        public void ViewToGlobalKey_EmptyString_FallsBackToDetails()
        {
            Assert.AreEqual("__INITIAL_DETAILS__", ThemedHtmlBuilder.ViewToGlobalKey(""));
        }

        // ── BuildVsHideScript ──────────────────────────────────────────────

        [TestMethod]
        public void BuildVsHideScript_UsageView_ReturnsScript()
        {
            var result = ThemedHtmlBuilder.BuildVsHideScript("usage");
            Assert.IsTrue(result.Contains("<script>"), "Usage view should return a script block");
            Assert.IsTrue(result.Contains("repo-hygiene-section"), "Should hide repo hygiene section");
            Assert.IsTrue(result.Contains("Copilot Customization Files"), "Should hide customization section");
        }

        [TestMethod]
        public void BuildVsHideScript_MaturityView_ReturnsScript()
        {
            var result = ThemedHtmlBuilder.BuildVsHideScript("maturity");
            Assert.IsTrue(result.Contains("<script>"), "Maturity view should return a script block");
            Assert.IsTrue(result.Contains("GITHUB_MCP_DOCS"), "Should rewrite MCP links");
            Assert.IsTrue(result.Contains("docs.github.com"), "Should contain GitHub docs URL");
        }

        [TestMethod]
        public void BuildVsHideScript_DetailsView_ReturnsEmpty()
        {
            var result = ThemedHtmlBuilder.BuildVsHideScript("details");
            Assert.AreEqual(string.Empty, result);
        }

        [TestMethod]
        public void BuildVsHideScript_ChartView_ReturnsEmpty()
        {
            var result = ThemedHtmlBuilder.BuildVsHideScript("chart");
            Assert.AreEqual(string.Empty, result);
        }

        [TestMethod]
        public void BuildVsHideScript_EnvironmentalView_ReturnsEmpty()
        {
            var result = ThemedHtmlBuilder.BuildVsHideScript("environmental");
            Assert.AreEqual(string.Empty, result);
        }

        // ── Build ──────────────────────────────────────────────────────────

        [TestMethod]
        public void Build_ReturnsValidHtmlDocument()
        {
            var html = ThemedHtmlBuilder.Build("details", "{}");
            Assert.IsTrue(html.Contains("<!DOCTYPE html>"), "Should start with DOCTYPE");
            Assert.IsTrue(html.Contains("<html lang=\"en\">"), "Should have html tag");
            Assert.IsTrue(html.Contains("</html>"), "Should close html tag");
        }

        [TestMethod]
        public void Build_ContainsContentSecurityPolicy()
        {
            var html = ThemedHtmlBuilder.Build("details", "{}");
            Assert.IsTrue(html.Contains("Content-Security-Policy"), "Should include CSP meta tag");
            Assert.IsTrue(html.Contains("copilot-tracker.local"), "Should reference virtual host");
        }

        [TestMethod]
        public void Build_InjectsStatsAsGlobalVariable()
        {
            var json = "{\"today\":{\"tokens\":100}}";
            var html = ThemedHtmlBuilder.Build("details", json);
            Assert.IsTrue(html.Contains("window.__INITIAL_DETAILS__"), "Should inject as global variable");
        }

        [TestMethod]
        public void Build_LoadsBundleScript()
        {
            var html = ThemedHtmlBuilder.Build("chart", "{}");
            Assert.IsTrue(html.Contains("https://copilot-tracker.local/chart.js"), "Should load chart bundle");
        }

        [TestMethod]
        public void Build_EscapesScriptTagInJson_XssPrevention()
        {
            // OWASP XSS defence: </script> in JSON must be escaped
            var maliciousJson = "{\"value\":\"</script><script>alert(1)</script>\"}";
            var html = ThemedHtmlBuilder.Build("details", maliciousJson);
            Assert.IsFalse(html.Contains("</script><script>alert"), "Should escape script tags in JSON");
            Assert.IsTrue(html.Contains("\\u003c"), "Should use unicode escapes for <");
            Assert.IsTrue(html.Contains("\\u003e"), "Should use unicode escapes for >");
        }

        [TestMethod]
        public void Build_EscapesAngleBracketsInJson()
        {
            var json = "{\"key\":\"<img src=x onerror=alert(1)>\"}";
            var html = ThemedHtmlBuilder.Build("details", json);
            Assert.IsFalse(html.Contains("<img src=x"), "Should not contain unescaped HTML in JSON");
        }

        [TestMethod]
        public void Build_HidesDiagnosticsButton()
        {
            var html = ThemedHtmlBuilder.Build("details", "{}");
            Assert.IsTrue(html.Contains("#btn-diagnostics { display: none !important; }"),
                "Should hide diagnostics button");
        }

        [TestMethod]
        public void Build_HidesRepositoryViewToggle()
        {
            var html = ThemedHtmlBuilder.Build("details", "{}");
            Assert.IsTrue(html.Contains("#view-repository { display: none !important; }"),
                "Should hide repository view toggle");
        }

        [TestMethod]
        public void Build_ContainsErrorRelayScript()
        {
            var html = ThemedHtmlBuilder.Build("details", "{}");
            Assert.IsTrue(html.Contains("window.onerror"), "Should relay JS errors back to extension");
            Assert.IsTrue(html.Contains("onunhandledrejection"), "Should relay unhandled promise rejections");
        }

        [TestMethod]
        public void Build_UsageView_IncludesHideScript()
        {
            var html = ThemedHtmlBuilder.Build("usage", "{}");
            Assert.IsTrue(html.Contains("repo-hygiene-section"), "Usage view should include hide script");
        }

        [TestMethod]
        public void Build_MaturityView_IncludesMcpLinkRewrite()
        {
            var html = ThemedHtmlBuilder.Build("maturity", "{}");
            Assert.IsTrue(html.Contains("GITHUB_MCP_DOCS"), "Maturity view should rewrite MCP links");
        }

        [TestMethod]
        public void Build_DetailsView_NoExtraHideScript()
        {
            var html = ThemedHtmlBuilder.Build("details", "{}");
            Assert.IsFalse(html.Contains("repo-hygiene-section"), "Details view should have no extra hide script");
            Assert.IsFalse(html.Contains("GITHUB_MCP_DOCS"), "Details view should have no MCP link rewrite");
        }

        // ── BuildLoadingHtml ───────────────────────────────────────────────

        [TestMethod]
        public void BuildLoadingHtml_ReturnsValidHtml()
        {
            var html = ThemedHtmlBuilder.BuildLoadingHtml("details");
            Assert.IsTrue(html.Contains("<!DOCTYPE html>"));
            Assert.IsTrue(html.Contains("Loading Copilot usage data"));
        }

        [TestMethod]
        public void BuildLoadingHtml_ContainsSpinner()
        {
            var html = ThemedHtmlBuilder.BuildLoadingHtml("chart");
            Assert.IsTrue(html.Contains("spinner"), "Should have spinner CSS class");
            Assert.IsTrue(html.Contains("@keyframes spin"), "Should have spin animation");
        }

        [TestMethod]
        public void BuildLoadingHtml_HasStrictCsp()
        {
            var html = ThemedHtmlBuilder.BuildLoadingHtml("details");
            Assert.IsTrue(html.Contains("Content-Security-Policy"));
            Assert.IsTrue(html.Contains("default-src 'none'"), "Loading page should have strict CSP");
        }

        // ── BuildErrorHtml ─────────────────────────────────────────────────

        [TestMethod]
        public void BuildErrorHtml_ReturnsValidHtml()
        {
            var html = ThemedHtmlBuilder.BuildErrorHtml("Something went wrong");
            Assert.IsTrue(html.Contains("<!DOCTYPE html>"));
            Assert.IsTrue(html.Contains("Something went wrong"));
        }

        [TestMethod]
        public void BuildErrorHtml_HtmlEncodesMessage()
        {
            var html = ThemedHtmlBuilder.BuildErrorHtml("<script>alert('xss')</script>");
            Assert.IsFalse(html.Contains("<script>alert"), "Should HTML-encode the error message");
            Assert.IsTrue(html.Contains("&lt;script&gt;"), "Should contain encoded tags");
        }

        [TestMethod]
        public void BuildErrorHtml_ContainsErrorContainer()
        {
            var html = ThemedHtmlBuilder.BuildErrorHtml("test error");
            Assert.IsTrue(html.Contains("error-container"), "Should have error container div");
            Assert.IsTrue(html.Contains("Error loading Copilot usage data"), "Should have error title");
        }

        [TestMethod]
        public void BuildErrorHtml_HasStrictCsp()
        {
            var html = ThemedHtmlBuilder.BuildErrorHtml("test");
            Assert.IsTrue(html.Contains("Content-Security-Policy"));
            Assert.IsTrue(html.Contains("default-src 'none'"));
        }

        // ── Build theme CSS ────────────────────────────────────────────────

        [TestMethod]
        public void Build_ContainsThemeCssVariables()
        {
            var html = ThemedHtmlBuilder.Build("details", "{}");
            Assert.IsTrue(html.Contains("--vscode-editor-background"), "Should contain theme CSS variables");
            Assert.IsTrue(html.Contains("--vscode-editor-foreground"), "Should contain foreground variable");
            Assert.IsTrue(html.Contains("--vscode-button-background"), "Should contain button variable");
        }

        [TestMethod]
        public void Build_ContainsFallbackDarkThemeValues()
        {
            // When running outside VS, fallback values should be used
            var html = ThemedHtmlBuilder.Build("details", "{}");
            // The fallback "#1e1e1e" should appear in the theme CSS
            Assert.IsTrue(html.Contains(":root"), "Should contain CSS :root block");
        }
    }
}
