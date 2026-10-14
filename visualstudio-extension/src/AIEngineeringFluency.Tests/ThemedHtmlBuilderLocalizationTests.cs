using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using AIEngineeringFluency.WebBridge;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace AIEngineeringFluency.Tests
{
    /// <summary>
    /// Pins that the Visual Studio host actually puts the webview localization
    /// dictionary and locale in the HTML it serves. The bundles skip
    /// initialization when <c>initialData.localization</c> is absent and silently
    /// render English, so a host that stops injecting it fails nothing else
    /// (see docs/adr/LOCALIZATION-ARCHITECTURE.md).
    ///
    /// ThemedHtmlBuilder reads the sidecars from the <c>webview</c> folder beside its
    /// assembly, so these tests stage fake ones there and restore whatever was
    /// already present (a real build may have copied genuine sidecars) afterwards.
    /// </summary>
    [TestClass]
    public class ThemedHtmlBuilderLocalizationTests
    {
        private const string EnDictionary = "{\"title\":\"Details\",\"greeting\":\"Hello\"}";
        private const string ZhDictionary = "{\"title\":\"\u8be6\u60c5\",\"greeting\":\"\u4f60\u597d\"}";

        private static readonly string WebviewDir = Path.Combine(
            Path.GetDirectoryName(typeof(ThemedHtmlBuilder).Assembly.Location)!,
            "webview");

        private static readonly string[] Locales = { "en", "zh-cn" };

        private readonly Dictionary<string, byte[]?> _originals = new Dictionary<string, byte[]?>();
        private bool _createdWebviewDir;
        private CultureInfo _originalUiCulture = CultureInfo.CurrentUICulture;

        [TestInitialize]
        public void SetUp()
        {
            _originalUiCulture = CultureInfo.CurrentUICulture;
            _createdWebviewDir = !Directory.Exists(WebviewDir);
            Directory.CreateDirectory(WebviewDir);
            foreach (var locale in Locales)
            {
                var path = SidecarPath(locale);
                _originals[locale] = File.Exists(path) ? File.ReadAllBytes(path) : null;
                File.Delete(path);
            }
        }

        [TestCleanup]
        public void TearDown()
        {
            CultureInfo.CurrentUICulture = _originalUiCulture;
            foreach (var locale in Locales)
            {
                var path = SidecarPath(locale);
                File.Delete(path);
                var original = _originals[locale];
                if (original != null) { File.WriteAllBytes(path, original); }
            }
            if (_createdWebviewDir && Directory.GetFileSystemEntries(WebviewDir).Length == 0)
            {
                Directory.Delete(WebviewDir);
            }
        }

        private static string SidecarPath(string locale)
            => Path.Combine(WebviewDir, "localization." + locale + ".json");

        private static void WriteSidecar(string locale, string json)
            => File.WriteAllText(SidecarPath(locale), json);

        private static void UseCulture(string name)
            => CultureInfo.CurrentUICulture = new CultureInfo(name);

        // ── Dictionary + locale reach the HTML ─────────────────────────────

        [TestMethod]
        public void Build_English_CarriesEnglishDictionaryAndLocale()
        {
            WriteSidecar("en", EnDictionary);
            WriteSidecar("zh-cn", ZhDictionary);
            UseCulture("en-US");

            var html = ThemedHtmlBuilder.Build("details", "{}");

            Assert.IsTrue(html.Contains("d.localization = " + EnDictionary + ";"), "English dictionary missing from HTML");
            Assert.IsTrue(html.Contains("<html lang=\"en\">"), "Declared locale should be en");
            Assert.IsFalse(html.Contains("\u4f60\u597d"), "Chinese text must not leak into the English payload");
        }

        [TestMethod]
        public void Build_ZhCn_CarriesChineseDictionaryAndLocale()
        {
            WriteSidecar("en", EnDictionary);
            WriteSidecar("zh-cn", ZhDictionary);
            UseCulture("zh-CN");

            var html = ThemedHtmlBuilder.Build("details", "{}");

            Assert.IsTrue(html.Contains("d.localization = " + ZhDictionary + ";"), "zh-cn dictionary missing from HTML");
            Assert.IsTrue(html.Contains("<html lang=\"zh-cn\">"), "Declared locale should be zh-cn");
            Assert.IsFalse(html.Contains("Hello"), "English text must not leak into the zh-cn payload");
        }

        [TestMethod]
        public void Build_SimplifiedScriptCulture_UsesZhCn()
        {
            WriteSidecar("en", EnDictionary);
            WriteSidecar("zh-cn", ZhDictionary);
            UseCulture("zh-Hans");

            var html = ThemedHtmlBuilder.Build("details", "{}");

            Assert.IsTrue(html.Contains("d.localization = " + ZhDictionary + ";"));
            Assert.IsTrue(html.Contains("<html lang=\"zh-cn\">"));
        }

        [TestMethod]
        public void Build_TraditionalChinese_FallsBackToEnglishNotSimplified()
        {
            WriteSidecar("en", EnDictionary);
            WriteSidecar("zh-cn", ZhDictionary);
            UseCulture("zh-TW");

            var html = ThemedHtmlBuilder.Build("details", "{}");

            Assert.IsTrue(html.Contains("d.localization = " + EnDictionary + ";"));
            Assert.IsTrue(html.Contains("<html lang=\"en\">"));
        }

        [TestMethod]
        public void Build_TargetsTheViewsGlobalKey()
        {
            WriteSidecar("en", EnDictionary);
            UseCulture("en-US");

            var html = ThemedHtmlBuilder.Build("usage", "{}");

            Assert.IsTrue(html.Contains("var d = window.__INITIAL_USAGE__;"));
        }

        [TestMethod]
        public void Build_DictionaryCannotCloseTheScriptTag()
        {
            WriteSidecar("en", "{\"k\":\"</script>\"}");
            UseCulture("en-US");

            var html = ThemedHtmlBuilder.Build("details", "{}");

            Assert.IsTrue(html.Contains("\\u003c/script\\u003e"), "Angle brackets in the dictionary must be escaped");
        }

        // ── Missing sidecar degrades to English ────────────────────────────

        [TestMethod]
        public void Build_MissingZhCnSidecar_FallsBackToEnglish()
        {
            WriteSidecar("en", EnDictionary);
            UseCulture("zh-CN");

            var html = ThemedHtmlBuilder.Build("details", "{}");

            Assert.IsTrue(html.Contains("d.localization = " + EnDictionary + ";"));
            Assert.IsTrue(html.Contains("<html lang=\"en\">"), "Must not declare a locale it has no dictionary for");
        }

        [TestMethod]
        public void Build_NoSidecarsAtAll_StillBuildsWithoutLocalizationScript()
        {
            UseCulture("zh-CN");

            var html = ThemedHtmlBuilder.Build("details", "{}");

            Assert.IsFalse(html.Contains("d.localization ="), "No dictionary should be emitted when none ships");
            Assert.IsTrue(html.Contains("<html lang=\"en\">"));
            Assert.IsTrue(html.Contains("window.__INITIAL_DETAILS__"), "The rest of the page must still be produced");
        }
    }
}
