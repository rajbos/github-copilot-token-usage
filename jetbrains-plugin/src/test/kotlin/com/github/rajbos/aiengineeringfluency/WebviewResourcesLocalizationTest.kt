package com.github.rajbos.aiengineeringfluency

import java.util.Locale
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue

/**
 * Pins that the JetBrains host actually puts the webview localization dictionary
 * in the HTML it serves. The bundles skip initialization when
 * `initialData.localization` is absent and silently render English, so a host that
 * stops injecting it fails nothing else (see docs/adr/LOCALIZATION-ARCHITECTURE.md).
 *
 * Pure JVM: the resource loader and locale are injected, so no IDE is started.
 */
class WebviewResourcesLocalizationTest {

    private val en = """{"title":"Details","greeting":"Hello"}"""
    private val zh = """{"title":"详情","greeting":"你好"}"""

    private fun fakeClasspath(vararg sidecars: Pair<String, String>): (String) -> String? {
        val files = mutableMapOf(
            "/webview/vscode-shim.js" to "/*shim*/",
            "/webview/details.js" to "/*bundle*/",
        )
        sidecars.forEach { (locale, json) -> files["/webview/localization.$locale.json"] = json }
        return { path -> files[path] }
    }

    private fun html(locale: Locale, loader: (String) -> String?) =
        WebviewResources.buildHtml("details", "bridge()", "{}", locale, loader)

    @Test
    fun englishHtmlCarriesEnglishDictionary() {
        val result = html(Locale.ENGLISH, fakeClasspath("en" to en, "zh-cn" to zh))
        assertTrue(result.contains("data.localization = $en;"), "English dictionary missing from HTML")
        assertFalse(result.contains("你好"))
    }

    @Test
    fun zhCnHtmlCarriesChineseDictionary() {
        val result = html(Locale.forLanguageTag("zh-CN"), fakeClasspath("en" to en, "zh-cn" to zh))
        assertTrue(result.contains("data.localization = $zh;"), "zh-cn dictionary missing from HTML")
        assertFalse(result.contains("Hello"))
    }

    @Test
    fun simplifiedScriptTagsResolveToZhCn() {
        val loader = fakeClasspath("en" to en, "zh-cn" to zh)
        assertEquals(zh, WebviewResources.loadWebviewLocalization(Locale.forLanguageTag("zh-Hans"), loader))
        assertEquals(zh, WebviewResources.loadWebviewLocalization(Locale.forLanguageTag("zh-Hans-CN"), loader))
        assertEquals(zh, WebviewResources.loadWebviewLocalization(Locale.forLanguageTag("zh-SG"), loader))
    }

    @Test
    fun traditionalChineseFallsBackToEnglishNotSimplified() {
        val loader = fakeClasspath("en" to en, "zh-cn" to zh)
        for (tag in listOf("zh-TW", "zh-HK", "zh-MO", "zh-Hant")) {
            assertEquals(en, WebviewResources.loadWebviewLocalization(Locale.forLanguageTag(tag), loader), tag)
        }
    }

    @Test
    fun unshippedLocaleFallsBackToEnglish() {
        val result = WebviewResources.loadWebviewLocalization(Locale.FRANCE, fakeClasspath("en" to en, "zh-cn" to zh))
        assertEquals(en, result)
    }

    @Test
    fun missingSidecarsDegradeWithoutCrashing() {
        val loader = fakeClasspath()
        assertNull(WebviewResources.loadWebviewLocalization(Locale.ENGLISH, loader))

        val result = html(Locale.ENGLISH, loader)
        assertTrue(result.contains("webview localization dictionary missing"))
        assertFalse(result.contains("data.localization ="))
        // The rest of the document is still produced.
        assertTrue(result.contains("window.__INITIAL_DETAILS__ = {};"))
    }

    @Test
    fun missingZhCnSidecarDegradesToEnglish() {
        val result = html(Locale.forLanguageTag("zh-CN"), fakeClasspath("en" to en))
        assertTrue(result.contains("data.localization = $en;"))
    }

    @Test
    fun dictionaryCannotCloseTheScriptTag() {
        val script = WebviewResources.buildLocalizationScript("__INITIAL_DETAILS__", """{"k":"</script>"}""")
        assertFalse(script.contains("</script>"))
        assertTrue(script.contains("<\\/script>"))
    }

    @Test
    fun scriptTargetsTheViewsGlobalKey() {
        val result = WebviewResources.buildHtml(
            "usage", "bridge()", "{}", Locale.ENGLISH,
            fakeClasspath("en" to en),
        )
        assertTrue(result.contains("var data = window.__INITIAL_USAGE__;"))
    }
}
